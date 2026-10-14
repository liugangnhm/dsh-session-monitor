/**
 * Host-half checks: the routes answer, and the window really opens.
 *
 * `lib/index.js` had no test at all, and that gap shipped a name collision
 * (`prepareWindowScript(windowWorkDirectory())` called a `let` as a function),
 * which made every window request answer 400 "windowWorkDirectory is not a
 * function" — a window that never appeared, with the failure only visible in a
 * hidden panel's toast.
 *
 * This drives the real `apply()` against a stub Cordis context, invokes the
 * window route the browser half calls, and asserts the answer is a real
 * outcome: either a started window, or a refusal that explains itself. A
 * TypeError is exactly what must never come back.
 *
 *   node test/host-check.mjs          # routes and refusal paths only
 *   node test/host-check.mjs --run    # also spawn the real window and close it
 */
import { spawnSync } from "node:child_process";

const failures = [];
const check = (label, condition) => {
	if (!condition) failures.push(label);
};

const ROUTE = "/dsh-session-monitor";

/**
 * A PowerShell probe for the throwaway focus window.
 *
 * Kept as the prefix of a `-Command` string so each probe is one short
 * expression; the class is defined once per spawned process.
 */
const WIN32_PROBE = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SmCheck {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  public static IntPtr Find(int pid) {
    IntPtr hit = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (hit != IntPtr.Zero) return true;
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid != (uint)pid || !IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(300); GetClassName(h, c, c.Capacity);
      if (c.ToString().StartsWith("HwndWrapper")) { hit = h; return true; }
      return true;
    }, IntPtr.Zero);
    return hit;
  }
}
'@
`;

/** Load the host half and capture the routes its apply() registers. */
async function loadHost() {
	const module = await import(new URL("../lib/index.js", import.meta.url));
	const routes = new Map();
	const registered = [];
	const webServer = {
		register(route) {
			routes.set(route.path, route.handler);
			registered.push(route);
			return () => {};
		},
	};
	const ctx = {
		// The host half waits for webServer through ctx.inject, so the stub has
		// to hand the callback a context where the service is already there. The
		// child effect must also RUN its callback: registration happens inside
		// it, and a stub that swallows the callback registers no routes at all.
		inject: (dependencies, callback) => {
			check(
				"the host waits for webServer before registering",
				Array.isArray(dependencies) && dependencies.includes("webServer"),
			);
			callback({
				get: (key) => (key === "webServer" ? webServer : undefined),
				effect: (body) => {
					body();
				},
			});
		},
		effect: (body) => {
			body();
		},
		get: () => undefined,
	};
	module.apply(ctx);
	return { module, routes, registered };
}

/**
 * One fake request/response pair, collecting the JSON the handler writes.
 *
 * The body is delivered on the next tick, exactly as a real socket would, and
 * `end` always fires: a handler that awaits the body would otherwise never
 * settle and the check would hang instead of failing.
 */
function callRoute(handler, { method = "POST", host = "127.0.0.1:19387", body } = {}) {
	return new Promise((resolve, reject) => {
		const listeners = {};
		const request = {
			method,
			headers: { host },
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

		// The handler registers its listeners synchronously, so it is called
		// first and the body follows on a later tick - the order a socket uses.
		let pending;
		try {
			pending = handler(request, response);
		} catch (error) {
			reject(error);
			return;
		}
		setTimeout(() => {
			try {
				if (body !== undefined && listeners.data) listeners.data(body);
				if (listeners.end) listeners.end();
			} catch (error) {
				reject(error);
			}
		}, 10);
		if (pending && typeof pending.then === "function") pending.catch(reject);
	});
}

const { routes, registered } = await loadHost();

check("the probe route is registered", routes.has(`${ROUTE}/probe`));
check("the window route is registered", routes.has(`${ROUTE}/window`));
check("the state route is registered", routes.has(`${ROUTE}/state`));
check("the open route is registered", routes.has(`${ROUTE}/open`));
check("the command route is registered", routes.has(`${ROUTE}/command`));
check("the pending route is registered", routes.has(`${ROUTE}/pending`));
check("the consume route is registered", routes.has(`${ROUTE}/consume`));
check("the focus route is registered", routes.has(`${ROUTE}/focus`));
check("every route is an exact registration", registered.every((route) => route.kind === "exact"));

// --- refusals ---------------------------------------------------------------

const foreign = await callRoute(routes.get(`${ROUTE}/probe`), { method: "GET", host: "example.test" });
check("a non-loopback caller is refused", foreign.statusCode === 403);

const wrongMethod = await callRoute(routes.get(`${ROUTE}/window`), { method: "GET" });
check("a wrong method on the window route is refused", wrongMethod.statusCode === 405);

const malformed = await callRoute(routes.get(`${ROUTE}/open`), { body: "not json" });
check("a malformed body is a client error", malformed.statusCode === 400);
check(
	"a refusal explains itself instead of throwing",
	typeof malformed.payload?.error === "string" && !/is not a function/.test(malformed.payload.error),
);

// --- one press, two transports, one event -------------------------------------
//
// lib/window.ps1 reports every interaction on TWO transports (a stdout protocol
// line and an HTTP POST) so that a broken pipe cannot make a control silently
// dead. Both land on the host, so the host is where the pair has to collapse
// back into one event. This is not a nicety: a row click is idempotent, but a
// TOGGLE applied twice cancels itself out and the control looks broken — which
// is exactly what happened before the funnel existed (measured: one twisty
// press queued ["p-1","p-1"]).
//
// From the funnel's point of view the two transports are indistinguishable, so
// two rapid deliveries here model precisely what the real window produces.

/** Read what the browser half would drain. */
async function pendingState() {
	const response = await callRoute(routes.get(`${ROUTE}/pending`), { method: "GET" });
	return response.payload;
}

/** Deliver one report twice, the way the window's two transports do. */
async function pressTwice(path, body) {
	await callRoute(routes.get(path), { body: JSON.stringify(body) });
	await callRoute(routes.get(path), { body: JSON.stringify(body) });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

await pressTwice(`${ROUTE}/command`, { action: "toggle-children", id: "h-parent" });
let pending = await pendingState();
check(
	"one twisty press on both transports queues exactly one toggle",
	Array.isArray(pending.children) && pending.children.length === 1,
);
if (pending.children?.length !== 1) console.error("  queued:", JSON.stringify(pending.children));
await callRoute(routes.get(`${ROUTE}/consume`), { body: JSON.stringify({ children: ["h-parent"] }) });
check("draining clears the queued toggle", (await pendingState()).children.length === 0);

// A deliberate second press still has to register, or the control would only
// work once.
await settle();
await pressTwice(`${ROUTE}/command`, { action: "toggle-children", id: "h-parent" });
check("a real second press still registers", (await pendingState()).children.length === 1);
await callRoute(routes.get(`${ROUTE}/consume`), { body: JSON.stringify({ children: ["h-parent"] }) });

// Two different parents must never mask each other.
await settle();
await pressTwice(`${ROUTE}/command`, { action: "toggle-children", id: "h-parent-a" });
await pressTwice(`${ROUTE}/command`, { action: "toggle-children", id: "h-parent-b" });
check("different parents are tracked independently", (await pendingState()).children.length === 2);
await callRoute(routes.get(`${ROUTE}/consume`), { body: JSON.stringify({ children: ["h-parent-a", "h-parent-b"] }) });

// The pre-existing header toggles ride the same funnel.
await settle();
await pressTwice(`${ROUTE}/command`, { action: "toggle-filter" });
check("one filter press on both transports queues exactly one toggle", (await pendingState()).commands.length === 1);
await callRoute(routes.get(`${ROUTE}/consume`), { body: JSON.stringify({ commands: ["toggle-filter"] }) });

await settle();
await pressTwice(`${ROUTE}/open`, { id: "h-session" });
check("one row click on both transports queues exactly one open", (await pendingState()).items.length === 1);
await callRoute(routes.get(`${ROUTE}/consume`), { body: JSON.stringify({ ids: ["h-session"] }) });

// --- the focus route ----------------------------------------------------------

const foreignFocus = await callRoute(routes.get(`${ROUTE}/focus`), { method: "POST", host: "example.test" });
check("a non-loopback focus caller is refused", foreignFocus.statusCode === 403);

const wrongFocusMethod = await callRoute(routes.get(`${ROUTE}/focus`), { method: "GET" });
check("a wrong method on the focus route is refused", wrongFocusMethod.statusCode === 405);

const malformedFocus = await callRoute(routes.get(`${ROUTE}/focus`), { body: "not json" });
check("a malformed focus body is a client error", malformedFocus.statusCode === 400);

// A real focus request answers JSON and explains itself. It is never allowed to
// surface a TypeError: this route is called on every row click, so a throw here
// would break navigation for the user.
const focused = await callRoute(routes.get(`${ROUTE}/focus`), { body: JSON.stringify({}) });
check("the focus route answers with JSON", typeof focused.payload === "object" && focused.payload !== null);
check(
	"the focus route never answers with a TypeError",
	!/is not a function|undefined is not/.test(String(focused.payload?.reason ?? "")),
);
check(
	"a focus request reports an action or a reason",
	typeof focused.payload?.action === "string" || typeof focused.payload?.reason === "string",
);

// --- the window request -----------------------------------------------------

// A window request is only really exercised with `--run`, because starting the
// real window hands this process a child handle it must then close. Without the
// flag the check asserts the part that broke in production: the route answers
// JSON, and a refusal explains itself instead of surfacing a TypeError.
const state = { rows: [{ id: "host-check", title: "主机自检", state: "running", blank: false }], totalCount: 1 };
const opened = await callRoute(routes.get(`${ROUTE}/window`), {
	body: JSON.stringify(process.argv.includes("--run") ? { action: "open", state } : { action: "close" }),
});

check("the window route answers with JSON", typeof opened.payload === "object" && opened.payload !== null);
check(
	"the window route never answers with a TypeError",
	!/is not a function|undefined is not/.test(String(opened.payload?.error ?? "")),
);
check("a close request is acknowledged", opened.payload?.ok === true);

if (process.argv.includes("--run") && process.platform === "win32") {
	// Really start it, prove a process exists behind the answer, then close it.
	const started = await callRoute(routes.get(`${ROUTE}/window`), { body: JSON.stringify({ action: "open", state }) });
	if (started.payload?.ok === true) {
		const listing = spawnSync(
			"powershell",
			["-NoProfile", "-Command", "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'window\\.ps1' } | Measure-Object).Count"],
			{ encoding: "utf8" },
		);
		const count = Number(String(listing.stdout || "0").trim());
		check("a window process really exists", Number.isFinite(count) && count > 0);
		if (!(count > 0)) console.error("process listing said:", String(listing.stdout || "").trim(), String(listing.stderr || "").trim());
	} else {
		check("the window request explains its refusal", String(started.payload?.error ?? "").length > 0);
		console.error("window refused:", String(started.payload?.error ?? ""));
	}
	const closed = await callRoute(routes.get(`${ROUTE}/window`), { body: JSON.stringify({ action: "close" }) });
	check("closing the window is acknowledged", closed.payload?.ok === true && closed.payload?.open === false);
}

// --- the focus helper, against a throwaway window ------------------------------
//
// `lib/focus.ps1` is the one piece of this plugin that drives the OS window
// manager, and its failure mode is silent (a click that does nothing). So with
// `--run` it is exercised for real — but never against the user's own DSH
// window: a temporary WPF window stands in for it, and the assertions are
// "minimized becomes restored" and "the helper reports what it did".
if (process.argv.includes("--run") && process.platform === "win32") {
	const { spawn } = await import("node:child_process");
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

	const work = mkdtempSync(join(tmpdir(), "sm-focus-check-"));
	const victimScript = join(work, "victim.ps1");
	writeFileSync(
		victimScript,
		"\uFEFF" +
			[
				"Add-Type -AssemblyName PresentationFramework",
				"$w = New-Object System.Windows.Window",
				'$w.Title = "sm-focus-check victim"',
				"$w.Width = 300; $w.Height = 180",
				'$w.WindowStartupLocation = "CenterScreen"',
				"$w.ShowDialog() | Out-Null",
			].join("\n"),
		"utf8",
	);
	const victim = spawn(powershell, ["-NoProfile", "-STA", "-File", victimScript], { stdio: "ignore", windowsHide: false });

	/** One Add-Type'd probe, so the check can minimize and inspect the victim. */
	const probe = (command) =>
		spawnSync(powershell, ["-NoProfile", "-Command", WIN32_PROBE + command], { encoding: "utf8" });

	const handle = await (async () => {
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const found = probe(`[SmCheck]::Find(${victim.pid})`);
			const text = String(found.stdout || "").trim();
			if (text !== "" && text !== "0") return text;
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		return "0";
	})();

	check("the throwaway window exists to test against", handle !== "0");
	if (handle !== "0") {
		probe(`[void][SmCheck]::ShowWindow([IntPtr]${handle}, 6)`);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const minimized = String(probe(`[SmCheck]::IsIconic([IntPtr]${handle})`).stdout || "").trim();
		check("the throwaway window is minimized before the focus run", minimized === "True");

		// The route's own target is this Node process's ancestry, which is not the
		// victim, so the helper is invoked directly with the victim's pid. The
		// window class is widened for the victim because the production default
		// deliberately refuses non-Chromium windows — that refusal is itself the
		// reason the monitor's own WPF window can never be raised by mistake.
		const focusScript = new URL("../lib/focus.ps1", import.meta.url).pathname.replace(/^\//, "");
		const focused = spawnSync(
			powershell,
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				focusScript,
				"-TargetPid",
				String(victim.pid),
				"-WindowClass",
				"HwndWrapper",
			],
			{ encoding: "utf8" },
		);
		const report = String(focused.stdout || "").trim().split("\n").pop();
		let parsed = null;
		try {
			parsed = JSON.parse(report);
		} catch {}
		check("the focus helper reports a JSON outcome", parsed !== null);
		check("the focus helper succeeded against a real window", parsed?.ok === true);
		check(
			"the focus helper restored the minimized window",
			String(parsed?.action ?? "").startsWith("restored"),
		);
		if (parsed === null) console.error("focus helper said:", report, String(focused.stderr || "").slice(0, 300));
	}

	try {
		spawnSync("taskkill", ["/pid", String(victim.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
	} catch {}
	try {
		rmSync(work, { recursive: true, force: true });
	} catch {}
}

if (failures.length > 0) {
	console.error("host-check failed:");
	for (const failure of failures) console.error(" - " + failure);
	process.exitCode = 1;
} else {
	console.log("host-check passed");
}

// The Host half keeps module-level state (a temp directory, a spawn helper's
// handles) alive by design; this check owns no long-lived resource, so it exits
// rather than waiting for an idle event loop that may never come.
process.exit(process.exitCode ?? 0);
