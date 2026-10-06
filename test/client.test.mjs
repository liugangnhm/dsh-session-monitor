/**
 * Offline check for this package's browser half.
 *
 * The bundle is a lazy-CJS registration, so the check runs it exactly the way
 * `@deepseek-ai/dsh-client-modules` does: a `window.__ModuleLoader__.load`
 * facade captures the registration, the factory receives a `require` for the
 * platform seed words, and the exported `apply` receives a stub Cordis context
 * whose `slots`/`locale`/`sessions` services record what the plugin consumes.
 *
 * It asserts the wiring a reviewer cannot see by reading alone: the panel lands
 * in the `shell.overlay` slot, the row states map to the right colors and sort
 * order, a row click rides `uiWorkspace.openSession`, the detach button falls
 * back to a notice when Document PiP is unavailable, and a session that stops
 * running while the user is away raises exactly one system notification.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "lib", "client.js");

/** Minimal React stand-in: the components are called directly in this check. */
const React = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (init) => [typeof init === "function" ? init() : init, () => {}],
	useEffect: () => {},
	useRef: (value) => ({ current: value }),
};

/** The primitives the bundle names, tagged so assertions can identify them. */
const primitives = {
	StateDot: "StateDot",
	Toast: "Toast",
};

/** Capture the bundle's registration exactly as the browser module table does. */
let registration;
globalThis.window = {
	__ModuleLoader__: {
		load: (value) => {
			registration = value;
		},
	},
	location: { origin: "http://127.0.0.1:19387" },
	localStorage: {
		getItem: () => null,
		setItem: () => {},
	},
	innerWidth: 1280,
	innerHeight: 800,
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	focus: () => {},
};

/** The document seat the panel and the detached window drive. */
const styleElements = [];
globalThis.document = {
	head: { appendChild: (element) => styleElements.push(element) },
	createElement: () => ({ textContent: "", remove: () => {} }),
	visibilityState: "visible",
	hasFocus: () => true,
	documentElement: {},
};

/** System-notification stand-in. */
const notifications = [];
globalThis.Notification = function Notification(title, options) {
	notifications.push({ title, options });
	this.onclick = undefined;
};
globalThis.Notification.permission = "granted";

const source = readFileSync(bundlePath, "utf8");
// The bundle is a script, not an ES module; evaluate it with a module-shaped `this`.
new Function("window", `${source}\n//# sourceURL=session-monitor-client.js`)(globalThis.window);

const failures = [];
const check = (label, condition) => {
	if (!condition) failures.push(label);
};

check("bundle registers under its package id", registration?.id === "dsh-session-monitor");

const factory = registration.factory;
const exports = factory((specifier) => {
	if (specifier === "react") return React;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
});

check("client half exports apply", typeof exports.apply === "function");
check("client half exports inject", Array.isArray(exports.inject));
check(
	"client half injects the slot, copy, catalog and navigation services",
	exports.inject.includes("slots") && exports.inject.includes("locale") && exports.inject.includes("sessions") && exports.inject.includes("uiWorkspace"),
);

// --- Stub Cordis context -----------------------------------------------------

const dictionaries = [];
const injectedSlots = [];
const registrations = [];
const openSessionCalls = [];

/** One controllable session-list snapshot source. */
let listState = null;
const listListeners = [];
const sessionsStub = {
	list: {
		getSnapshot: () => listState,
		subscribe: (listener) => {
			listListeners.push(listener);
			return () => {};
		},
	},
};

/** One controllable unified-status source (the optional richer face). */
let statusState = null;
const statusListeners = [];
const uiSessionStub = {
	sessionStatus: {
		getSnapshot: () => statusState,
		subscribe: (listener) => {
			statusListeners.push(listener);
			return () => {};
		},
	},
};

const ctx = {
	locale: {
		register: (ns, dicts) => {
			dictionaries.push({ ns, dicts });
			return () => {};
		},
		bind: () => (key) => key,
	},
	slots: {
		inject: (key, callback) => {
			injectedSlots.push(key);
			callback();
			return () => {};
		},
		register: (descriptor, component) => {
			registrations.push({ descriptor, component });
			return () => {};
		},
	},
	get: (name) => {
		if (name === "sessions") return sessionsStub;
		if (name === "uiSession") return uiSessionStub;
		if (name === "uiWorkspace") return { openSession: (id) => openSessionCalls.push(id) };
		return null;
	},
	effect: (callback) => callback(),
	on: () => () => {},
};

/** Render the registered panel with a stub framework seat. */
function renderPanel() {
	const registrationEntry = registrations[0];
	return registrationEntry.component({ t: (key) => key });
}

/** Collect the row buttons: className exactly `sm-row` (plus optional ` blank`). */
function collectRows(node, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (Array.isArray(node)) {
		for (const item of node) collectRows(item, found);
		return found;
	}
	const className = node.props && typeof node.props.className === "string" ? node.props.className : "";
	if (node.type === "button" && /(^|\s)sm-row(\s|$)/.test(className)) found.push(node);
	if (node.children) for (const child of node.children) collectRows(child, found);
	return found;
}

/** Collect every rendered element whose className contains `name`. */
function collect(node, name, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (Array.isArray(node)) {
		for (const item of node) collect(item, name, found);
		return found;
	}
	const className = node.props && typeof node.props.className === "string" ? node.props.className : "";
	if (className.includes(name)) found.push(node);
	if (node.children) for (const child of node.children) collect(child, name, found);
	return found;
}

/** Collect every rendered element of one component type. */
function collectByType(node, type, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (Array.isArray(node)) {
		for (const item of node) collectByType(item, type, found);
		return found;
	}
	if (node.type === type) found.push(node);
	if (node.children) for (const child of node.children) collectByType(child, type, found);
	return found;
}

exports.apply(ctx);

check("dictionaries registered under the plugin namespace", dictionaries.some((entry) => entry.ns === "session-monitor" && entry.dicts.zh && entry.dicts.en));
check("panel registered into shell.overlay", injectedSlots.includes("shell.overlay") && registrations.length === 1);
check("overlay descriptor carries the locale seat", registrations[0]?.descriptor?.id === "session-monitor" && registrations[0]?.descriptor?.locale === "session-monitor");

// --- rows, states and navigation ---------------------------------------------

listState = {
	ids: ["s-idle", "s-done", "s-running", "s-attention"],
	byId: {
		"s-idle": { id: "s-idle", displayTitle: "Idle one", running: false, blank: false, updatedAt: 10 },
		"s-done": { id: "s-done", displayTitle: "Done one", running: false, blank: false, updatedAt: 20 },
		"s-running": { id: "s-running", displayTitle: "Running one", running: true, blank: false, updatedAt: 30 },
		"s-attention": { id: "s-attention", displayTitle: "Attention one", running: true, blank: false, updatedAt: 40 },
	},
	phase: "ready",
	projectionsBySession: {},
};
statusState = new Map([
	["s-attention", { running: true, pendingInteraction: { key: "a1", kind: "approval", sessionId: "s-attention" }, completionUnread: false }],
	["s-running", { running: true, pendingInteraction: undefined, completionUnread: false }],
	["s-done", { running: false, pendingInteraction: undefined, completionUnread: true }],
]);
for (const listener of listListeners) listener();

let panel = renderPanel();
let rows = collectRows(panel);
check("the default view hides idle sessions", rows.length === 3);
const rowTitles = rows.map((node) => node.children[1].children[0]);
check(
	"attention and running rows lead, then by recency",
	JSON.stringify(rowTitles) === JSON.stringify(["Attention one", "Running one", "Done one"]),
);
const rowStates = rows.map((node) => node.children[2].children[0]);
check(
	"visible row states keep the active ones",
	JSON.stringify(rowStates) === JSON.stringify(["state.attention", "state.running", "state.done"]),
);
check(
	"the running row shows the animated live dot",
	rows[1].children[0].type === "span" && rows[1].children[0].props.className === "sm-live",
);
check(
	"settled rows keep the official state dot",
	rows[0].children[0].type === "StateDot" && rows[0].children[0].props.state === "warning" && rows[2].children[0].props.state === "done",
);

rows[0].props.onClick();
check("a row click opens that session's conversation", JSON.stringify(openSessionCalls) === JSON.stringify(["s-attention"]));

// --- the active-only filter ---------------------------------------------------

const filterButton = collect(panel, "sm-btn", []).find((node) => node.children[0] === "panel.filterActive");
check("the panel offers the active-only filter toggle", filterButton !== undefined);
filterButton.props.onClick();
panel = renderPanel();
rows = collectRows(panel);
check("the toggle reveals every session", rows.length === 4);
check(
	"idle rows join the list last",
	rows[3].children[1].children[0] === "Idle one" && rows[3].children[2].children[0] === "state.idle",
);
const allButton = collect(panel, "sm-btn", []).find((node) => node.children[0] === "panel.filterAll");
check("the toggle reports the all-sessions view", allButton !== undefined);

// --- detach fallback ----------------------------------------------------------

const buttons = collect(panel, "sm-btn", []);
const detachButton = buttons.find((node) => node.children[0] === "panel.detach");
check("the panel offers a detach button", detachButton !== undefined);
detachButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
panel = renderPanel();
const toasts = collectByType(panel, "Toast", []);
check(
	"detach without any window path raises the failure notice with its reason",
	toasts.length === 1 && toasts[0].props.text.startsWith("toast.detachFailed") && toasts[0].props.text.includes("window.open unavailable"),
);

// --- native window path ---------------------------------------------------------

const nativeWindowCalls = [];
const nativeStateCalls = [];
let nativePending = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
	const target = String(url);
	const body = options && options.body ? JSON.parse(options.body) : {};
	if (target.endsWith("/dsh-session-monitor/window")) {
		nativeWindowCalls.push(body);
		return Promise.resolve({ json: () => Promise.resolve({ ok: true, open: true }) });
	}
	if (target.endsWith("/dsh-session-monitor/state")) {
		nativeStateCalls.push(body);
		return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
	}
	if (target.endsWith("/dsh-session-monitor/pending")) {
		return Promise.resolve({ json: () => Promise.resolve({ ok: true, items: nativePending }) });
	}
	if (target.endsWith("/dsh-session-monitor/consume")) {
		nativePending = [];
		return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
	}
	return Promise.reject(new Error("unexpected fetch " + target));
};

// The host half answers ok: the native window opens and the panel flips to 收回.
detachButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check("the host is asked to open the native window once", nativeWindowCalls.length === 1 && nativeWindowCalls[0].action === "open");
check("the snapshot rides along with the open request", Array.isArray(nativeWindowCalls[0].state?.rows));
check("the snapshot is also pushed into the window", nativeStateCalls.length >= 1);
panel = renderPanel();
const recallButton = collect(panel, "sm-btn", []).find((node) => node.children[0] === "panel.attach");
check("the panel reports the native window as detached", recallButton !== undefined);
const nativeToast = collectByType(panel, "Toast", []).find((node) => node.props.text === "toast.detachNative");
check("the native window is announced as always-on-top", nativeToast !== undefined);

// A row click inside the window reaches the app through the open-request queue.
nativePending = ["s-running"];
await new Promise((resolve) => setTimeout(resolve, 900));
check("a row click in the native window opens that session", openSessionCalls.includes("s-running"));
check("the handled request is consumed", nativePending.length === 0);

// 收回 closes it and stops the drain.
recallButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check("recall closes the native window", nativeWindowCalls.length === 2 && nativeWindowCalls[1].action === "close");
panel = renderPanel();
check("the panel returns to the detach button", collect(panel, "sm-btn", []).some((node) => node.children[0] === "panel.detach"));
globalThis.fetch = realFetch;

// --- notifications ------------------------------------------------------------

globalThis.document.visibilityState = "hidden";
globalThis.document.hasFocus = () => false;

// Seed the watcher: first sight never notifies.
listState = {
	ids: ["s-running"],
	byId: { "s-running": { id: "s-running", displayTitle: "Running one", running: true, blank: false, updatedAt: 50 } },
	phase: "ready",
	projectionsBySession: {},
};
statusState = new Map([["s-running", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
for (const listener of listListeners) listener();

// The session stops running while the user is away.
listState = {
	ids: ["s-running"],
	byId: { "s-running": { id: "s-running", displayTitle: "Running one", running: false, blank: false, updatedAt: 60 } },
	phase: "ready",
	projectionsBySession: {},
};
statusState = new Map([["s-running", { running: false, pendingInteraction: undefined, completionUnread: true }]]);
for (const listener of statusListeners) listener();

check("a finished session notifies once while the user is away", notifications.length === 1);
check(
	"the notification names the session",
	notifications.length === 1 && notifications[0].options.body === "notify.done",
);

// --- report -------------------------------------------------------------------

if (failures.length > 0) {
	console.error("session-monitor client check failed:");
	for (const failure of failures) console.error(" - " + failure);
	process.exitCode = 1;
} else {
	console.log("session-monitor client check passed");
}
