<#
  dsh-session-monitor - bring the DSH app window back to the front.

  Spawned by the plugin's Host half (lib/index.js) when a session row is
  clicked, so clicking a row in the panel or in the detached window restores a
  minimized DSH instead of only flashing the taskbar.

  Why a separate process, and why Win32:

    - The Host half is plain Node with no window of its own, and the browser
      half runs in a sandboxed iframe where `window.focus()` cannot raise
      another OS window.
    - The COM shortcut (`WScript.Shell.AppActivate`) reports success yet leaves
      a MINIMIZED window minimized (measured); only ShowWindow(SW_RESTORE)
      followed by SetForegroundWindow actually restores and foregrounds it.

  The target is found by walking this process's own ancestry: the Host half is
  spawned by the app's main process, which is the process that owns the main
  window. The match is restricted to the app's top-level window class, which
  keeps the monitor's own WPF window (class `HwndWrapper[...]`) from ever being
  the target; `-WindowClass` overrides that for a shell with another class.

  Prints one JSON line describing what it did, exits 0 whenever it produced an
  answer, and exits 3 only when no app window could be found at all.

  NOTE: this file must keep its UTF-8 BOM. Windows PowerShell 5.1 reads a
  BOM-less script as ANSI; the Host checks the BOM and runs a repaired copy from
  temp if an editor ever strips it.
#>
param(
  # NOT `-Pid`: `$PID` is a read-only PowerShell automatic variable, and binding
  # it aborts the whole script before a single window is looked at (measured).
  [int]$TargetPid = 0,
  [int]$MaxDepth = 12,
  # The app's top-level window class; Chromium/Electron uses these two.
  [string[]]$WindowClass = @("Chrome_WidgetWin_1", "Chrome_WidgetWin_0")
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class SmFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public class Found {
    public IntPtr Hwnd = IntPtr.Zero;
    public uint Pid = 0;
    public string Class = "";
    public string Title = "";
    public bool Minimized = false;
  }

  /**
    The app's main window for one pid: a visible top-level window whose class
    matches one of `classes`.
    @param classes accepted window-class names or prefixes; the default is the
      app's own. A prefix is enough because WPF decorates its class name with a
      domain and a GUID (`HwndWrapper[DefaultDomain;...;guid]`).
  */
  public static Found WindowOf(uint pid, string[] classes) {
    Found hit = null;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (hit != null) return true;
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid != pid) return true;
      if (!IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(300); GetClassName(h, c, c.Capacity);
      string cls = c.ToString();
      // Anything else (the monitor's own WPF window, IME windows, tray
      // helpers) is not the app window and must never be raised.
      bool matches = false;
      foreach (string wanted in classes) if (cls.StartsWith(wanted)) { matches = true; break; }
      if (!matches) return true;
      Found f = new Found();
      f.Hwnd = h; f.Pid = wpid; f.Class = cls;
      int len = GetWindowTextLength(h);
      StringBuilder t = new StringBuilder(len + 2);
      GetWindowText(h, t, t.Capacity);
      f.Title = t.ToString();
      f.Minimized = IsIconic(h);
      hit = f;
      return true;
    }, IntPtr.Zero);
    return hit;
  }

  /**
    Restore (if minimized) and foreground one window.

    SetForegroundWindow is refused when the caller is not the foreground
    process, which is exactly this process's situation, so a refusal falls back
    to the documented AttachThreadInput workaround before giving up.
  */
  public static string Raise(IntPtr h) {
    if (h == IntPtr.Zero) return "no-window";
    bool wasMinimized = IsIconic(h);
    ShowWindow(h, wasMinimized ? 9 /* SW_RESTORE */ : 5 /* SW_SHOW */);
    bool foreground = GetForegroundWindow() == h;
    if (!foreground) {
      if (SetForegroundWindow(h)) {
        foreground = true;
      } else {
        IntPtr current = GetForegroundWindow();
        uint otherPid;
        uint otherThread = GetWindowThreadProcessId(current, out otherPid);
        uint mine = GetCurrentThreadId();
        if (otherThread != 0 && otherThread != mine) {
          AttachThreadInput(mine, otherThread, true);
          BringWindowToTop(h);
          SetForegroundWindow(h);
          AttachThreadInput(mine, otherThread, false);
        }
        foreground = GetForegroundWindow() == h;
      }
    }
    return (wasMinimized ? "restored" : "shown") + ":" + (foreground ? "foreground" : "background");
  }
}
'@

<#
  Walk this process's ancestry for the first pid that owns an app window.

  The Host half is a child of the app's main process, so the chain reaches the
  window owner within a couple of steps. A `-TargetPid` override is honoured
  first so the Host can name the target outright when it knows it.
#>
function Find-AppWindow([int]$StartPid) {
  if ($StartPid -gt 0) {
    $direct = [SmFocus]::WindowOf([uint32]$StartPid, $WindowClass)
    if ($direct -ne $null) { return $direct }
  }
  $current = $PID
  for ($step = 0; $step -lt $MaxDepth -and $current -gt 0; $step++) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
    if ($null -eq $process) { break }
    $found = [SmFocus]::WindowOf([uint32]$current, $WindowClass)
    if ($found -ne $null) { return $found }
    $current = [int]$process.ParentProcessId
  }
  return $null
}

$answer = [ordered]@{ ok = $false; action = "none"; reason = "" }
try {
  $window = Find-AppWindow $TargetPid
  if ($null -eq $window) {
    $answer.reason = "no app window found in the process ancestry"
  } else {
    $answer.ok = $true
    $answer.pid = [int]$window.Pid
    $answer.title = $window.Title
    $answer.minimized = $window.Minimized
    $answer.action = [SmFocus]::Raise($window.Hwnd)
    $answer.foreground = ([SmFocus]::GetForegroundWindow() -eq $window.Hwnd)
  }
} catch {
  $answer.reason = $_.Exception.Message
}

$answer | ConvertTo-Json -Compress
if ($answer.ok) { exit 0 } else { exit 3 }
