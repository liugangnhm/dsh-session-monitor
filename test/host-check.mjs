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
 * routes the browser half calls, and asserts each answer is a real outcome:
 * either work done, or a refusal that explains itself. A TypeError is exactly
 * what must never come back. The app-window raise is checked at its process
 * boundary (no real Electron process is launched here); `raise-e2e.mjs` drives
 * the real shell for that.
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

// The probe is how the browser half decides between the desktop raise path and
// the web fallbacks, so the reported raise mechanism must match reality: this
// check process is not Electron, so it must NOT claim an Electron raise.
const probed = await callRoute(routes.get(`${ROUTE}/probe`), { method: "GET" });
check("the probe answers with JSON", probed.statusCode === 200 && typeof probed.payload === "object");
check("a non-Electron host declares no Electron raise path", probed.payload?.raise === "none");

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
// The window reports every interaction on TWO transports (a stdout protocol
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

// --- the raise route ----------------------------------------------------------
//
// Raising the app window is delegated to Electron: the Host relaunches the
// shell, the running instance takes the single-instance lock and runs
// `restore()/show()/focus()` itself. The old Win32 helper is gone, so what has
// to be proven here is the hand-off: the child is launched WITHOUT
// ELECTRON_RUN_AS_NODE (or it would run as Node and never reach Electron), a
// zero exit means the running instance accepted it, and every refusal explains
// itself instead of throwing.

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

// The hand-off itself, with the process boundary stubbed so the check owns the
// timing. Each case pins one property the real launcher needs.
const { raiseAppWindow } = await import(new URL("../lib/index.js", import.meta.url));

/**
 * One fake child process: records the two event subscriptions the raise path
 * makes and can be settled on demand, so no real Electron process is started
 * by the automated check.
 * @param outcome - `code`/`signal`/`error`/`stderr` to deliver.
 * @returns `{ calls, child, spawn }` where `calls` holds every launch.
 */
function captureLaunch(outcome = {}) {
	const calls = [];
	const listeners = {};
	const child = {
		killCalls: 0,
		kill() {
			child.killCalls += 1;
		},
		stderr: {
			on(event, listener) {
				listeners["stderr:" + event] = listener;
				return child.stderr;
			},
		},
		on(event, listener) {
			listeners[event] = listener;
			return child;
		},
	};
	const spawn = (execPath, args, options) => {
		calls.push({ execPath, args, env: options.env, options });
		// `settle: false` models a launcher that hangs: it never reports an exit.
		if (outcome.settle === false) return child;
		setTimeout(() => {
			if (outcome.error) {
				if (listeners.error) listeners.error(outcome.error);
				return;
			}
			if (outcome.stderr && listeners["stderr:data"]) listeners["stderr:data"](outcome.stderr);
			if (listeners.exit) listeners.exit(outcome.code === undefined ? 0 : outcome.code, outcome.signal ?? null);
		}, 5);
		return child;
	};
	return { calls, child, spawn };
}

{
	// A plain-Node Host (the web profile) has no Electron window to raise.
	const result = await raiseAppWindow({ electronVersion: undefined, spawn: () => { throw new Error("must not spawn"); } });
	check("a web-profile host refuses to raise without launching anything", result.ok === false && /no Electron runtime/.test(result.reason));
}

{
	const capture = captureLaunch({ code: 0, stderr: "noise about the disk cache\n" });
	const result = await raiseAppWindow({
		electronVersion: "44.7.0",
		platform: "win32",
		execPath: "C:\\apps\\DeepSeek Harness.exe",
		env: { PATH: "C:\\bin", ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", KEEP: "yes" },
		spawn: capture.spawn,
	});
	check("a desktop raise relaunches the shell exactly once", capture.calls.length === 1);
	check("the relaunch passes the deep link as its only argument", capture.calls[0]?.args?.length === 1 && capture.calls[0].args[0] === "dsh://open");
	check(
		"the relaunch drops ELECTRON_RUN_AS_NODE (or it would run as Node, not Electron)",
		capture.calls[0]?.env && !("ELECTRON_RUN_AS_NODE" in capture.calls[0].env) && !("ELECTRON_NO_ATTACH_CONSOLE" in capture.calls[0].env),
	);
	check("the relaunch keeps the rest of the environment", capture.calls[0]?.env?.KEEP === "yes" && capture.calls[0]?.env?.PATH === "C:\\bin");
	check("the launcher does not inherit the Host's stdio for output", capture.calls[0]?.options?.stdio?.[0] === "ignore");
	check("a zero exit is reported as the Electron restore path", result.ok === true && result.action === "electron:restore-show-focus");
	check("a successful raise does not claim a foreground state it cannot see", !("foreground" in result));
}

{
	const capture = captureLaunch({ code: 3, stderr: "boom: no display\n" });
	const result = await raiseAppWindow({
		electronVersion: "44.7.0",
		platform: "win32",
		execPath: "C:\\apps\\DeepSeek Harness.exe",
		env: {},
		spawn: capture.spawn,
	});
	check("a failing launcher is reported as a failure", result.ok === false && result.action === "none");
	check("a failing launcher quotes why it failed", /boom: no display/.test(String(result.reason)));
}

{
	// A launcher that never settles. The implementation's deadline is unref'd
	// (so a shutting-down Host is never held open by it), which means the check
	// has to keep the loop alive itself while it waits.
	const capture = captureLaunch({ settle: false });
	const keepAlive = setInterval(() => {}, 50);
	const started = Date.now();
	const result = await raiseAppWindow({
		electronVersion: "44.7.0",
		platform: "win32",
		execPath: "C:\\apps\\DeepSeek Harness.exe",
		env: {},
		spawn: capture.spawn,
		timeoutMs: 120,
	});
	clearInterval(keepAlive);
	check("a hung launcher times out instead of hanging the click", result.ok === false && /did not hand off/.test(String(result.reason)));
	check("a timed-out launcher is NOT killed (it may have become the app)", capture.child.killCalls === 0);
	check("the timeout is bounded by the caller's value", Date.now() - started < 3000);
}

// --- the window request -----------------------------------------------------

// A window request is only really exercised with `--run`, because starting the
// real window hands this process a child handle it must then close. Without the
// flag the check asserts the part that broke in production: the route answers
// JSON, and a refusal explains itself instead of surfacing a TypeError.
const state = { rows: [{ id: "host-check", title: "主机自检", state: "running", blank: false }], totalCount: 1 };

// Whether this process could open the real window at all. The window is a real
// Electron process launched from the desktop shell's executable, and this check
// normally runs under plain Node — so the run-mode block below has to know when
// it is unable to exercise the product path rather than report a fake failure.
const inDesktopShell = typeof process.versions.electron === "string";

const opened = await callRoute(routes.get(`${ROUTE}/window`), { body: JSON.stringify({ action: "close" }) });
check("the window route answers with JSON", typeof opened.payload === "object" && opened.payload !== null);
check(
	"the window route never answers with a TypeError",
	!/is not a function|undefined is not/.test(String(opened.payload?.error ?? "")),
);
check("a close request is acknowledged", opened.payload?.ok === true);

// Outside the shell there is no Electron executable to mirror, so the refusal
// must name that fact instead of throwing or silently doing nothing.
if (!inDesktopShell) {
	const refused = await callRoute(routes.get(`${ROUTE}/window`), { body: JSON.stringify({ action: "open", state }) });
	check("a non-Electron host refuses the window with a reason", refused.payload?.ok === false && String(refused.payload?.error ?? "").length > 0);
	check("the refusal names the missing desktop shell", /not the desktop shell/.test(String(refused.payload?.error ?? "")));
}

if (process.argv.includes("--run") && process.platform === "win32" && inDesktopShell) {
	// Really start it, prove a process exists behind the answer, then close it.
	//
	// The window is now a real Electron process: the shell's own executable,
	// mirrored into a scratch runtime and booted against this plugin's
	// `resources/app`. The probe therefore looks for an Electron window process
	// whose userData points into our scratch directory — an assertion about the
	// actual product path, not about a script name.
	const started = await callRoute(routes.get(`${ROUTE}/window`), { body: JSON.stringify({ action: "open", state }) });
	if (started.payload?.ok === true) {
		check("the window reports the Electron path", started.payload?.mode === "electron");
		const listing = spawnSync(
			"powershell",
			["-NoProfile", "-Command", "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'sm-window-' -and $_.CommandLine -match '--user-data-dir' } | Measure-Object).Count"],
			{ encoding: "utf8" },
		);
		const count = Number(String(listing.stdout || "0").trim());
		check("a real Electron window process exists", Number.isFinite(count) && count > 0);
		if (!(count > 0)) console.error("process listing said:", String(listing.stdout || "").trim(), String(listing.stderr || "").trim());
		// The window is only useful if it reached its own first paint.
		const probe = await callRoute(routes.get(`${ROUTE}/probe`), { method: "GET" });
		check("the window reported a readiness handshake", probe.payload?.open === true);
	} else {
		check("the window request explains its refusal", String(started.payload?.error ?? "").length > 0);
		console.error("window refused:", String(started.payload?.error ?? ""));
	}
	const closed = await callRoute(routes.get(`${ROUTE}/window`), { body: JSON.stringify({ action: "close" }) });
	check("closing the window is acknowledged", closed.payload?.ok === true && closed.payload?.open === false);
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
