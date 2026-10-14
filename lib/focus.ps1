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
  # The app's MAIN window class. Only `Chrome_WidgetWin_1` qualifies: the app also
  # owns visible `Chrome_WidgetWin_0` helper windows that carry no title, and
  # accepting those made the restore target a window nobody can see (measured —
  # enumeration showed a visible untitled _0 alongside the real titled _1).
  [string[]]$WindowClass = @("Chrome_WidgetWin_1")
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
  [DllImport("user32.dll")] public static extern long GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT placement);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT minPosition;
    public POINT maxPosition;
    public RECT normalPosition;
  }

  /** GetWindowLong index for the extended window style. */
  const int GWL_EXSTYLE = -20;
  /** Extended style marking a tool window; a strong helper signal when present. */
  const long WS_EX_TOOLWINDOW = 0x00000080L;
  /**
    Smallest RESTORED window area that can be the application window, in px².

    Measured on this stack: the app window is 300x180 (54000px²) while the
    same-class helpers are 0 and 5168. The decisive detail is that a MINIMIZED
    window's live rect collapses to a tiny taskbar-adjacent box (measured 128x22),
    which fails this test — and that made the helper reject the very window it was
    asked to restore. So the size used here is the window's RESTORED size from
    GetWindowPlacement, which stays 300x180 in every state.
  */
  const long MIN_APP_AREA = 160L * 120L;

  public class Found {
    public IntPtr Hwnd = IntPtr.Zero;
    public uint Pid = 0;
    public string Class = "";
    public string Title = "";
    public bool Minimized = false;
    public bool Visible = false;
    /** The window's restored area in px², stable across minimize and hide. */
    public long Area = 0;
  }

  /**
    The app's main window for one pid: the largest top-level window whose class
    matches one of `classes` and that is big enough to be an application window.

    Visibility is deliberately NOT required. DSH hides its window to the system
    tray rather than minimizing it, leaving a window that is neither visible nor
    iconic; requiring IsWindowVisible made this helper report "no app window
    found" for exactly the state the tray leaves behind, so a second click could
    never bring the app back (measured). SW_SHOW restores such a window, so a
    hidden one is still a valid target.

    Selection is by AREA, with visibility only breaking near-ties. A UI toolkit
    keeps same-class bookkeeping windows around — WPF owns several titled
    `HwndWrapper` windows (SystemResourceNotifyWindow, ...) plus an untitled shim —
    and picking by first-match or by visibility alone selected one of those: a
    minimized window then looked "already in front", and the restore was applied
    to a window nobody can see (measured: real window 54000px², helpers 0 and
    5168). Area separates them cleanly where titles and styles do not.

    @param classes accepted window-class names or prefixes. A prefix is enough
      because WPF decorates its class name with a domain and a GUID
      (`HwndWrapper[DefaultDomain;...;guid]`).
  */
  public static Found WindowOf(uint pid, string[] classes) {
    Found hit = null;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid != pid) return true;
      StringBuilder c = new StringBuilder(300); GetClassName(h, c, c.Capacity);
      string cls = c.ToString();
      // Anything else (the monitor's own WPF window, IME windows, tray
      // helpers) is not the app window and must never be raised.
      bool matches = false;
      foreach (string wanted in classes) if (cls.StartsWith(wanted)) { matches = true; break; }
      if (!matches) return true;
      // A tool window is never an application window.
      long exStyle = GetWindowLong(h, GWL_EXSTYLE);
      if ((exStyle & WS_EX_TOOLWINDOW) != 0) return true;
      int len = GetWindowTextLength(h);
      // An untitled window of the same class is a helper too.
      if (len == 0) return true;
      // Size comes from the window's RESTORED placement, not its live rect: a
      // minimized window's live rect is a tiny taskbar box (measured 128x22),
      // which would wrongly fail the size test and hide the real window from this
      // search precisely when it most needs restoring.
      WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
      placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
      long area;
      if (GetWindowPlacement(h, ref placement)) {
        area = Math.Max(0, placement.normalPosition.Right - placement.normalPosition.Left)
             * (long)Math.Max(0, placement.normalPosition.Bottom - placement.normalPosition.Top);
      } else {
        RECT live;
        GetWindowRect(h, out live);
        area = Math.Max(0, live.Right - live.Left) * (long)Math.Max(0, live.Bottom - live.Top);
      }
      // Too small to be the application window; skip the toolkit's shims.
      if (area < MIN_APP_AREA) return true;
      StringBuilder t = new StringBuilder(len + 2);
      GetWindowText(h, t, t.Capacity);
      Found f = new Found();
      f.Hwnd = h; f.Pid = wpid; f.Class = cls;
      f.Title = t.ToString();
      f.Minimized = IsIconic(h);
      f.Visible = IsWindowVisible(h);
      f.Area = area;
      // Largest wins; an on-screen window beats a hidden one of the same size.
      bool better = hit == null
        || f.Area > hit.Area
        || (f.Area == hit.Area && f.Visible && !hit.Visible);
      if (better) hit = f;
      return true;
    }, IntPtr.Zero);
    return hit;
  }

  /**
    Bring one window back and put it in front.

    Three starting states have to be handled, because the app uses all of them:
    minimized (SW_RESTORE), hidden to the tray (SW_SHOW — a hidden window is not
    iconic, so SW_RESTORE is not the right call), and merely behind another window
    (SW_SHOW changes nothing, only the foreground call matters).

    When the window is ALREADY visible, un-minimized and in front, this returns
    immediately without touching it. That case is the common one (the user is
    looking at the app and clicks a session to switch to it) and issuing
    ShowWindow/SetForegroundWindow for a window that needs neither makes it
    visibly flicker, because those calls re-assert the frame and the z-order.

    Showing is asynchronous on this app: `ShowWindow` returned false and the
    window only became visible about 100ms later (measured), so the sequence
    WAITS for the window to actually appear before claiming success. Reporting
    success while still hidden is what made the earlier version look like it
    worked when the app stayed in the tray.

    SetForegroundWindow is refused when the caller is not the foreground process,
    which is exactly this process's situation, so a refusal falls back to the
    documented AttachThreadInput workaround before giving up.
  */
  public static string Raise(IntPtr h) {
    if (h == IntPtr.Zero) return "no-window";

    // Fast path: nothing to do, so do nothing. This is a pure read — no
    // ShowWindow, no SetForegroundWindow — which is what keeps the usual click
    // flicker-free.
    if (IsWindowVisible(h) && !IsIconic(h) && GetForegroundWindow() == h) {
      return "already-front:foreground";
    }

    bool wasMinimized = IsIconic(h);
    bool wasVisible = IsWindowVisible(h);

    // The show and the foreground call are retried together: taking the
    // foreground can only succeed once the window is on screen, and the app may
    // need a moment before either sticks.
    bool foreground = false;
    for (int attempt = 0; attempt < 10; attempt++) {
      if (IsIconic(h)) ShowWindow(h, 9 /* SW_RESTORE */);
      else ShowWindow(h, 5 /* SW_SHOW */);

      if (GetForegroundWindow() == h) {
        foreground = true;
      } else if (!SetForegroundWindow(h)) {
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

      // Done as soon as the window is both on screen and in front.
      if (IsWindowVisible(h) && !IsIconic(h) && foreground) break;
      System.Threading.Thread.Sleep(90);
    }

    // The starting state is reported: "unhidden" is the tray case, and knowing
    // which one it was is what makes a failure diagnosable from the Host's log.
    // The OUTCOME is reported too, so a caller can tell "brought back" from
    // "tried and the app stayed hidden".
    string what = !wasVisible ? "unhidden" : wasMinimized ? "restored" : "shown";
    bool visibleNow = IsWindowVisible(h);
    string outcome = visibleNow ? (foreground ? "foreground" : "background") : "still-hidden";
    return what + ":" + outcome;
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
    $answer.hidden = -not $window.Visible
    $answer.action = [SmFocus]::Raise($window.Hwnd)
    $answer.foreground = ([SmFocus]::GetForegroundWindow() -eq $window.Hwnd)
  }
} catch {
  $answer.reason = $_.Exception.Message
}

$answer | ConvertTo-Json -Compress
if ($answer.ok) { exit 0 } else { exit 3 }
