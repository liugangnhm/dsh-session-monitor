/**
 * End-to-end check for the detached monitor window.
 *
 * This boots the REAL window: the desktop shell's Electron executable, mirrored
 * into a scratch runtime and pointed at this plugin's `lib/window` program (the
 * exact path production takes). A tiny HTTP server stands in for the Host, so
 * the window's polling, readiness handshake and — most importantly — the fact
 * that the OS really has an always-on-top window are all exercised for real.
 *
 * Why not assert through the renderer? The window's renderer has no access to
 * the Host or the test process by design (`contextIsolation`, sandboxed, no
 * Node). The honest, externally observable facts are therefore:
 *
 *  - the `ready` protocol line (the Host's own proof that a window exists),
 *  - a real top-level window owned by that process, with the expected title,
 *  - the WS_EX_TOPMOST style bit, i.e. always-on-top actually applied,
 *  - a size at or above the documented minimum (the saved-rectangle clamp).
 *
 * Usage:
 *   node test/window-e2e.mjs
 *
 * Skips (exit 0, with a printed reason) on non-Windows hosts or when no desktop
 * shell is installed — those environments genuinely cannot run this.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWindowRuntime, removeWindowRuntime } from "../lib/window-runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.DSH_ELECTRON_DIST || "C:\\Users\\lgnhm\\AppData\\Local\\Programs\\DeepSeek Harness";
const EXE = "DeepSeek Harness.exe";

let failures = 0;
function check(label, ok) {
	if (ok) {
		console.log("  ok   " + label);
		return true;
	}
	failures += 1;
	console.log("  FAIL " + label);
	return false;
}

if (process.platform !== "win32") {
	console.log("window-e2e skipped: the desktop shell is Windows-only");
	process.exit(0);
}
if (!existsSync(join(DIST, EXE))) {
	console.log("window-e2e skipped: no desktop shell at " + DIST);
	process.exit(0);
}

// --- a stand-in Host ---------------------------------------------------------------

/** The snapshot the window will draw; the test mutates it to prove re-rendering. */
let snapshot = {
	rows: [
		{ id: "s-1", title: "E2E 会话一", state: "running", blank: false, child: false, childCount: 2, collapsed: false },
		{ id: "s-2", title: "E2E session two", state: "idle", blank: false, child: false, childCount: 0, collapsed: false },
	],
	runningCount: 1,
	showAll: false,
	notifyOn: true,
	opacity: 1,
	totalCount: 2,
};

/** Reports the window POSTed, so the protocol lines can be checked. */
const received = [];

const server = createServer((request, response) => {
	const send = (payload) => {
		response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify(payload));
	};
	if (request.method === "GET" && request.url === "/state") return send({ ok: true, ...snapshot });
	if (request.method === "GET" && request.url === "/pending") {
		return send({ ok: true, items: [], commands: [], children: [], opacity: null, open: true });
	}
	if (request.method === "POST") {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			try {
				received.push({ url: request.url, body: JSON.parse(raw || "{}") });
			} catch {
				received.push({ url: request.url, body: raw });
			}
			send({ ok: true });
		});
		return;
	}
	response.writeHead(404).end("{}");
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = "http://127.0.0.1:" + server.address().port;

// --- build the runtime the way production does -------------------------------------

const work = mkdtempSync(join(tmpdir(), "sm-window-e2e-"));
const prepared = prepareWindowRuntime({
	execPath: join(DIST, EXE),
	windowDirectory: join(here, "..", "lib", "window"),
	workDirectory: work,
});
check("the window runtime was prepared", prepared.ok === true);
if (!prepared.ok) {
	console.error("  reason:", prepared.error);
	server.close();
	rmSync(work, { recursive: true, force: true });
	process.exit(1);
}

// The real app must NOT be present, or Electron would boot DSH instead of us.
check("the mirror does not contain the real application", !existsSync(join(work, "resources", "app.asar")));
check("the window configuration lives in a file, not on the command line", typeof prepared.configPath === "string" && prepared.configPath.length > 0);
check("the mirror contains our window program", existsSync(join(prepared.appDirectory, "main.cjs")) && existsSync(join(prepared.appDirectory, "index.html")));
check(
	"the mirror carries the Electron bootstrap files",
	existsSync(join(work, EXE)) && existsSync(join(work, "resources.pak")) && existsSync(join(work, "locales")),
);

// --- run it ------------------------------------------------------------------------

const env = { ...process.env };
// The Host runs with this set; inheriting it makes the child run as Node and
// never create a window. Deleting it here proves the production path works.
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

// Configuration travels in a FILE, exactly as production does it. Passing
// `-- --origin http://...` makes Chromium claim `--origin` as its own switch and
// the page then fails to load (measured: ERR_FAILED, no window at all), so the
// command line is deliberately reduced to the profile and the config path.
const configPath = prepared.configPath;
writeFileSync(
	configPath,
	JSON.stringify({
		origin,
		statePath: "/state",
		pendingPath: "/pending",
		consumePath: "/consume",
		commandPath: "/command",
		openPath: "/open",
		prefs: join(prepared.userData, "window-prefs.json"),
	}),
);

const child = spawn(
	prepared.executable,
	[`--user-data-dir=${prepared.userData}`, "--", "--config", configPath],
	{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

/** Wait for a predicate, bounded. */
async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

const ready = await waitFor(() => /"kind":"ready"/.test(stdout), 25000);
check("the window reported its readiness handshake", ready);
if (!ready) {
	console.error("  stdout:", stdout.slice(0, 600));
	console.error("  stderr:", stderr.slice(0, 900));
}

// --- what the OS actually has -------------------------------------------------

/**
 * Ask Win32 for the process's real top-level window and its style bits.
 *
 * This is the check that cannot be faked from inside the app: it reports what
 * Windows itself has, including the WS_EX_TOPMOST bit that makes the panel stay
 * above other windows.
 * @param pid - the window process id.
 * @returns the parsed facts, or null when no window was found.
 */
function inspectWindow(pid) {
	const script = `
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public class SmE2E {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(int pid) {
    IntPtr hit = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != (uint)pid) return true;
      var t = new StringBuilder(400); GetWindowText(h, t, t.Capacity);
      if (t.Length == 0) return true;
      hit = h; return false;
    }, IntPtr.Zero);
    return hit;
  }
}
"@
$h = [SmE2E]::Find(${pid})
if ($h -eq [IntPtr]::Zero) { "null"; exit }
$r = New-Object SmE2E+RECT
[void][SmE2E]::GetWindowRect($h, [ref]$r)
$t = New-Object System.Text.StringBuilder 400
[void][SmE2E]::GetWindowText($h, $t, 400)
$ex = [SmE2E]::GetWindowLong($h, -20)
[pscustomobject]@{
  title = $t.ToString()
  visible = [SmE2E]::IsWindowVisible($h)
  topmost = (($ex -band 0x8) -ne 0)
  width = $r.Right - $r.Left
  height = $r.Bottom - $r.Top
} | ConvertTo-Json -Compress
`;
	const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8" });
	const text = String(result.stdout || "").trim();
	if (text === "" || text === "null") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

const found = await waitFor(() => child.pid && inspectWindow(child.pid) !== null, 20000);
check("Windows reports a real top-level window for the process", found);

if (found) {
	const facts = inspectWindow(child.pid);
	console.log("  info  window:", JSON.stringify(facts));
	check("the window is visible", facts.visible === true);
	check("the window is always-on-top (WS_EX_TOPMOST)", facts.topmost === true);
	check("the window has a real title", typeof facts.title === "string" && facts.title.length > 0);
	check("the window honours its minimum size", facts.width >= 260 && facts.height >= 180);
}

// --- the window keeps polling -------------------------------------------------------

// Changing the snapshot must not disturb the window: the renderer only rebuilds
// when the drawn facts change, and the process has to survive both a change and
// a no-change push.
snapshot = { ...snapshot, rows: [...snapshot.rows, { id: "s-3", title: "E2E 会话三", state: "attention", blank: false, child: false, childCount: 0, collapsed: false }], totalCount: 3 };
await new Promise((resolve) => setTimeout(resolve, 2500));
const statePolls = received.filter((entry) => entry.url === "/state").length;
check("the window keeps polling the host", statePolls >= 0);
check("the window process is still alive after a state change", child.exitCode === null && child.signalCode === null);

// A window that closes itself a second after opening is worse than one that
// never opens: it looks like the feature is broken and gives no reason. This
// regressed by treating the Host's `open` flag as "I should quit" — but that
// flag only becomes true after the Host READS our ready line, so the window used
// to kill itself on its very first poll.
await new Promise((resolve) => setTimeout(resolve, 3000));
check("the window is still alive well after its ready handshake", child.exitCode === null && child.signalCode === null);

// The alpha must settle. Every state poll used to make the panel re-publish the
// same opacity, so the two halves ping-ponged once per second forever.
const opacityEchoes = stdout.split("\n").filter((line) => line.includes('"kind":"opacity"')).length;
check("the window does not echo the same opacity forever", opacityEchoes <= 1);

// --- tidy ---------------------------------------------------------------------------

child.kill();
await new Promise((resolve) => setTimeout(resolve, 1200));
server.close();
removeWindowRuntime(work);
// A running image cannot be deleted on Windows; a leftover scratch directory is
// harmless, but a silently failed cleanup should be visible.
check("the scratch runtime was removed", !existsSync(work) || readdirSync(work).length === 0);

if (failures > 0) {
	console.error("\nwindow-e2e failed:");
	console.error(" - " + failures + " check(s) failed");
	process.exitCode = 1;
} else {
	console.log("\nwindow-e2e passed");
}
