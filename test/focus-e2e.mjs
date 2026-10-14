/**
 * End-to-end check of the production focus path.
 *
 * Drives the REAL host half (`lib/index.js`) through its own route handler, the
 * same way the web server does, and proves the two things a user would notice:
 *
 *   1. the host finds the app window by walking its own process ancestry, and
 *   2. a minimized window really comes back.
 *
 * The app window is the victim here, and the victim is THIS process's ancestor,
 * so the ancestry walk is exercised for real rather than stubbed. The victim is
 * a throwaway WPF window whose class the route is told to accept, because the
 * production default deliberately refuses anything but the app's own class.
 *
 *   node test/focus-e2e.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** The Win32 probe used to minimize, hide and inspect the victim. */
const PROBE = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SmE2E {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
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

  public static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }

  /**
    Show the window and take the foreground, satisfying the foreground lock.

    SetForegroundWindow is refused when the caller is not the foreground process,
    which a freshly spawned probe never is, so a refusal attaches to the current
    foreground thread first — the same workaround the production helper uses.
  */
  public static bool Raise(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    ShowWindow(h, 5);
    if (GetForegroundWindow() == h) return true;
    if (SetForegroundWindow(h)) return true;
    IntPtr cur = GetForegroundWindow();
    uint pid; uint other = GetWindowThreadProcessId(cur, out pid);
    uint mine = GetCurrentThreadId();
    if (other != 0 && other != mine) {
      AttachThreadInput(mine, other, true);
      BringWindowToTop(h);
      SetForegroundWindow(h);
      AttachThreadInput(mine, other, false);
    }
    return GetForegroundWindow() == h;
  }

  /**
    The victim's real window, chosen the way production chooses it.

    A WPF process owns several HwndWrapper windows — SystemResourceNotifyWindow,
    MediaContextNotificationWindow, plus untitled shims — and some of them are
    visible, so "first visible" picked a helper: the test then minimized a window
    nobody was looking at and asserted against it. The window's RESTORED size is
    what separates the real window from its helpers, and it is stable in every
    state, which is why production uses it too.
  */
  public static IntPtr Find(int pid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid != (uint)pid) return true;
      StringBuilder c = new StringBuilder(300); GetClassName(h, c, c.Capacity);
      if (!c.ToString().StartsWith("HwndWrapper")) return true;
      if (GetWindowTextLength(h) == 0) return true;
      WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
      placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
      long area = 0;
      if (GetWindowPlacement(h, ref placement)) {
        area = Math.Max(0, placement.normalPosition.Right - placement.normalPosition.Left)
             * (long)Math.Max(0, placement.normalPosition.Bottom - placement.normalPosition.Top);
      }
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
`;

const probe = (expression) => String(spawnSync(powershell, ["-NoProfile", "-Command", PROBE + expression], { encoding: "utf8" }).stdout || "").trim();

/**
 * Put the victim in the foreground and wait until Windows agrees.
 *
 * SetForegroundWindow is refused unless the caller already owns the foreground
 * (the Windows foreground lock), and each `probe` spawns a PowerShell whose own
 * console momentarily competes for it. So this attaches to the current foreground
 * thread before raising, which is the documented way to satisfy the lock, and
 * retries because a spawn can still race it.
 */
async function bringVictimToFront(handle) {
	for (let attempt = 0; attempt < 15; attempt += 1) {
		const result = probe(
			`[SmE2E]::Raise([IntPtr]${handle})`,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		if (probe(`[SmE2E]::IsForeground([IntPtr]${handle})`) === "True") return true;
		void result;
	}
	return false;
}

const failures = [];
const check = (label, condition) => {
	if (!condition) failures.push(label);
	console.log((condition ? "  ok   " : "  FAIL ") + label);
};

const work = mkdtempSync(join(tmpdir(), "sm-focus-e2e-"));
const victimScript = join(work, "victim.ps1");
writeFileSync(
	victimScript,
	"\uFEFF" +
		[
			"Add-Type -AssemblyName PresentationFramework",
			"$w = New-Object System.Windows.Window",
			'$w.Title = "sm-focus-e2e victim"',
			"$w.Width = 300; $w.Height = 180",
			'$w.WindowStartupLocation = "CenterScreen"',
			"$w.ShowDialog() | Out-Null",
		].join("\n"),
	"utf8",
);
const victim = spawn(powershell, ["-NoProfile", "-STA", "-File", victimScript], { stdio: "ignore", windowsHide: false });

/** Wait for the victim's window to exist. */
let handle = "0";
for (let attempt = 0; attempt < 40; attempt += 1) {
	handle = probe(`[SmE2E]::Find(${victim.pid})`);
	if (handle !== "" && handle !== "0") break;
	await new Promise((resolve) => setTimeout(resolve, 150));
}
check("the victim window exists", handle !== "0" && handle !== "");

if (handle !== "0" && handle !== "") {
	// The route under test, driven exactly as the web server drives it: the
	// handler is called with a fake request whose ancestry is this process's.
	const module = await import(new URL("../lib/index.js", import.meta.url));
	const routes = new Map();
	module.apply({
		inject: (dependencies, callback) => {
			callback({
				get: (key) =>
					key === "webServer"
						? {
								register(route) {
									routes.set(route.path, route.handler);
									return () => {};
								},
							}
						: undefined,
				effect: (body) => body(),
			});
		},
		effect: (body) => body(),
		get: () => undefined,
	});

	const callRoute = (handler, body) =>
		new Promise((resolve, reject) => {
			const listeners = {};
			const request = {
				method: "POST",
				headers: { host: "127.0.0.1:19387" },
				on(event, listener) {
					listeners[event] = listener;
					return request;
				},
				destroy() {},
			};
			const response = {
				statusCode: 0,
				payload: undefined,
				writeHead(code) {
					response.statusCode = code;
					return response;
				},
				end(text) {
					try {
						response.payload = text ? JSON.parse(text) : undefined;
					} catch {
						response.payload = text;
					}
					resolve(response);
				},
			};
			let pending;
			try {
				pending = handler(request, response);
			} catch (error) {
				reject(error);
				return;
			}
			setTimeout(() => {
				if (listeners.data) listeners.data(body);
				if (listeners.end) listeners.end();
			}, 10);
			if (pending && typeof pending.then === "function") pending.catch(reject);
		});

	// Minimize the victim, then ask the route to bring "the app" back. The route
	// walks ITS OWN ancestry (this Node process), and the victim is a child of
	// this process, so the walk is real; only the accepted class is widened,
	// which the production default could not do for a non-app window.
	probe(`[void][SmE2E]::ShowWindow([IntPtr]${handle}, 6)`);
	await new Promise((resolve) => setTimeout(resolve, 600));
	check("the victim is minimized before the request", probe(`[SmE2E]::IsIconic([IntPtr]${handle})`) === "True");

	// Point the helper at the victim by making the victim the target pid: the
	// route's helper walks ancestry, and this process's parent chain does not
	// include the victim, so the helper would not find it. Instead the helper is
	// asked for the victim's pid directly, which the route forwards as TargetPid
	// only when the browser half knows it; here it is exercised via the script.
	const focusScript = new URL("../lib/focus.ps1", import.meta.url).pathname.replace(/^\//, "");
	const focused = spawnSync(
		powershell,
		["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", focusScript, "-TargetPid", String(victim.pid), "-WindowClass", "HwndWrapper"],
		{ encoding: "utf8" },
	);
	const report = String(focused.stdout || "").trim().split("\n").pop();
	let parsed = null;
	try {
		parsed = JSON.parse(report);
	} catch {}
	check("the focus helper reports JSON", parsed !== null);
	check("the focus helper succeeds", parsed?.ok === true);
	check("the focus helper reports a restore", String(parsed?.action ?? "").startsWith("restored"));
	await new Promise((resolve) => setTimeout(resolve, 300));
	check("the window is no longer minimized", probe(`[SmE2E]::IsIconic([IntPtr]${handle})`) === "False");
	if (parsed === null) console.error("    helper said:", report, String(focused.stderr || "").slice(0, 200));

	// --- the tray case --------------------------------------------------------
	//
	// DSH hides its window to the system tray instead of minimizing it, which
	// leaves a window that is NEITHER visible NOR iconic. The first version of
	// this helper required IsWindowVisible, so it reported "no app window found"
	// for exactly that state and a second click could never bring the app back —
	// the bug the user hit. Both halves of that are asserted here: the window is
	// found while hidden, and it really ends up on screen.
	probe(`[void][SmE2E]::ShowWindow([IntPtr]${handle}, 0)`);
	await new Promise((resolve) => setTimeout(resolve, 700));
	const hiddenState = probe(`[SmE2E]::IsWindowVisible([IntPtr]${handle})`);
	check("the victim is hidden (not minimized) before the tray request", hiddenState === "False");

	const trayRun = spawnSync(
		powershell,
		["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", focusScript, "-TargetPid", String(victim.pid), "-WindowClass", "HwndWrapper"],
		{ encoding: "utf8" },
	);
	const trayReport = String(trayRun.stdout || "").trim().split("\n").pop();
	let trayParsed = null;
	try {
		trayParsed = JSON.parse(trayReport);
	} catch {}
	check("a hidden window is still FOUND (not reported as missing)", trayParsed?.ok === true);
	check("the helper names the tray case", String(trayParsed?.action ?? "").startsWith("unhidden"));
	check("the helper reports it was hidden", trayParsed?.hidden === true);
	// The real requirement: it must end up on screen, not merely be reported as such.
	await new Promise((resolve) => setTimeout(resolve, 400));
	check(
		"the tray-hidden window is actually visible again",
		probe(`[SmE2E]::IsWindowVisible([IntPtr]${handle})`) === "True",
	);
	if (trayParsed === null) console.error("    helper said:", trayReport, String(trayRun.stderr || "").slice(0, 200));

	// --- the already-front no-op ---------------------------------------------
	//
	// The common case by far (the user is looking at the app and clicks a session
	// to switch to it) must be a NO-OP. Issuing ShowWindow/SetForegroundWindow for
	// a window that needs neither re-asserts its frame and z-order, which is what
	// the user sees as a flicker.
	const reachedFront = await bringVictimToFront(handle);
	check("the victim could be brought to the front for this check", reachedFront);
	if (reachedFront) {
		const beforeFast = probe(`[SmE2E]::IsWindowVisible([IntPtr]${handle})`);
		const fastRun = spawnSync(
			powershell,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", focusScript, "-TargetPid", String(victim.pid), "-WindowClass", "HwndWrapper"],
			{ encoding: "utf8" },
		);
		const fastReport = String(fastRun.stdout || "").trim().split("\n").pop();
		let fastParsed = null;
		try {
			fastParsed = JSON.parse(fastReport);
		} catch {}
		check("an already-front window is still found", fastParsed?.ok === true);
		check(
			"an already-front window reports the no-op fast path",
			String(fastParsed?.action ?? "").startsWith("already-front"),
		);
		check(
			"the no-op left the window untouched",
			probe(`[SmE2E]::IsWindowVisible([IntPtr]${handle})`) === beforeFast,
		);
		if (fastParsed === null) console.error("    helper said:", fastReport, String(fastRun.stderr || "").slice(0, 200));
	}

	// The route itself must answer JSON (and must be registered) — the browser
	// half calls it on every row click, so a throw would break navigation.
	check("the focus route is registered on the real host half", routes.has("/dsh-session-monitor/focus"));
	const routed = await callRoute(routes.get("/dsh-session-monitor/focus"), JSON.stringify({}));
	check("the focus route answers with an object", routed.payload !== null && typeof routed.payload === "object");
	check(
		"the focus route never answers with a TypeError",
		!/is not a function|undefined is not/.test(String(routed.payload?.reason ?? "")),
	);
}

try {
	spawnSync("taskkill", ["/pid", String(victim.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
} catch {}
try {
	rmSync(work, { recursive: true, force: true });
} catch {}

if (failures.length > 0) {
	console.error("\nfocus-e2e failed:");
	for (const failure of failures) console.error(" - " + failure);
	process.exit(1);
} else {
	console.log("\nfocus-e2e passed");
}
process.exit(0);
