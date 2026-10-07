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
