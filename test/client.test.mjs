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

/**
 * A real in-memory localStorage.
 *
 * Persistence is a stated requirement (the opacity and the collapse set must
 * survive a reload), so the check has to be able to observe a write — a stub
 * whose setItem is a no-op proves nothing about saving.
 */
const storage = new Map();
globalThis.window = {
	__ModuleLoader__: {
		load: (value) => {
			registration = value;
		},
	},
	location: { origin: "http://127.0.0.1:19387" },
	localStorage: {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
		removeItem: (key) => storage.delete(key),
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
	// The alpha path normalizes the theme token through a throwaway element's
	// style, so the stub has to carry one; the token itself resolves empty here,
	// which exercises the documented fallback color.
	createElement: () => ({ textContent: "", style: {}, remove: () => {} }),
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
			// A real source hands back a working unsubscribe, and the plugin
			// relies on it; a no-op stub would hide leaked subscriptions.
			return () => {
				const index = listListeners.indexOf(listener);
				if (index >= 0) listListeners.splice(index, 1);
			};
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
			// Removable, so the plugin's own cleanup is observable: a stub that
			// silently keeps every listener turns a disposed instance into a
			// phantom that still reacts to snapshots.
			return () => {
				const index = statusListeners.indexOf(listener);
				if (index >= 0) statusListeners.splice(index, 1);
			};
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

/** The overlay registration (the in-app card); the sidebar toggle is [1]. */
function overlayEntry() {
	return registrations.find((entry) => entry.descriptor.name === "shell.overlay");
}

/** The sidebar toggle registration. */
function sidebarEntry() {
	return registrations.find((entry) => entry.descriptor.name === "sidebar.footer.action");
}

/**
 * Render the registered panel with a stub framework seat.
 *
 * The card starts hidden by default, so this opens it the way a user would —
 * through the sidebar toggle's context menu — then renders the overlay.
 */
function renderPanel() {
	if (overlayEntry().component({ t: (key) => key }) === null) {
		const toggle = sidebarEntry().component({ t: (key) => key });
		toggle.props.onContextMenu({ preventDefault: () => {} });
	}
	return overlayEntry().component({ t: (key) => key });
}

/** Collect the row buttons: className contains `sm-row` (plus optional suffixes). */
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

/**
 * Row cell accessors.
 *
 * A row renders four cells: the twisty/spacer lead, the state dot, the title
 * and the state label. Naming them here keeps the assertions about the cells
 * they mean rather than about child indices, which changed once already when
 * the lead column was introduced.
 */
const cellLead = (row) => row.children[0];
const cellDot = (row) => row.children[1];
const cellTitle = (row) => row.children[2].children[0];
const cellState = (row) => row.children[3].children[0];

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

/**
 * Collect elements carrying exactly one class token.
 *
 * Needed where class names are prefixes of each other (`sm-opacity` vs
 * `sm-opacity-value`), so a substring match would return the wrong element.
 */
function collectByClass(node, exactClass, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (Array.isArray(node)) {
		for (const item of node) collectByClass(item, exactClass, found);
		return found;
	}
	const className = node.props && typeof node.props.className === "string" ? node.props.className : "";
	if (className.split(/\s+/).includes(exactClass)) found.push(node);
	if (node.children) for (const child of node.children) collectByClass(child, exactClass, found);
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

/**
 * Boot a completely fresh instance of the client half.
 *
 * Persisted settings are read once, when the plugin starts, so "the value is
 * restored next time" can only be observed by really starting again: the module
 * factory has to re-run, not merely re-render.
 *
 * The instance is disposed before returning. A live second instance would keep
 * its own subscriptions on the shared stub sources, and every later snapshot
 * would then notify (and re-render) through both instances — which shows up as
 * duplicated notifications rather than as anything obviously "leaky".
 *
 * @returns the new instance's panel element, with the card already opened.
 */
function bootFresh() {
	const freshFactory = registration.factory;
	const freshExports = freshFactory((specifier) => {
		if (specifier === "react") return React;
		if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
		throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
	});
	const freshRegistrations = [];
	/** Disposers returned by the instance's own effects. */
	const disposers = [];
	const freshCtx = {
		...ctx,
		effect: (callback) => disposers.push(callback()),
		slots: {
			inject: (key, callback) => {
				callback();
				return () => {};
			},
			register: (descriptor, component) => {
				freshRegistrations.push({ descriptor, component });
				return () => {};
			},
		},
	};
	freshExports.apply(freshCtx);
	const overlay = freshRegistrations.find((entry) => entry.descriptor.name === "shell.overlay");
	const sidebar = freshRegistrations.find((entry) => entry.descriptor.name === "sidebar.footer.action");
	if (overlay.component({ t: (key) => key }) === null) {
		sidebar.component({ t: (key) => key }).props.onContextMenu({ preventDefault: () => {} });
	}
	const panel = overlay.component({ t: (key) => key });
	for (const dispose of disposers) {
		if (typeof dispose === "function") {
			try {
				dispose();
			} catch {}
		}
	}
	return panel;
}

check("dictionaries registered under the plugin namespace", dictionaries.some((entry) => entry.ns === "session-monitor" && entry.dicts.zh && entry.dicts.en));

// The locale/*.json files are a second copy of the same dictionary, and the two
// drift silently: a key added to the code but not the JSON shows up as a raw key
// in the app's language settings. This keeps them honest.
const localeFiles = ["zh", "en"].map((lang) => ({
	lang,
	json: JSON.parse(readFileSync(join(here, "..", "locale", `${lang}.json`), "utf8")),
}));
const codeDicts = dictionaries.find((entry) => entry.ns === "session-monitor").dicts;
for (const { lang, json } of localeFiles) {
	const codeKeys = Object.keys(codeDicts[lang]).sort();
	const fileKeys = Object.keys(json)
		.filter((key) => key !== "meta")
		.sort();
	check(
		`locale/${lang}.json covers every key the code defines`,
		JSON.stringify(codeKeys) === JSON.stringify(fileKeys.filter((key) => codeKeys.includes(key))),
	);
	// Every key in the file must exist in the code too, or the file promises
	// copy the plugin can never show.
	const extra = fileKeys.filter((key) => !codeKeys.includes(key));
	check(`locale/${lang}.json defines no key the code lacks (${extra.join(",")})`, extra.length === 0);
	// The new settings must be translated, not left to fall back to the key.
	for (const key of ["panel.opacity", "panel.collapseChildren", "panel.expandChildren"]) {
		check(`locale/${lang}.json translates ${key}`, typeof json[key] === "string" && json[key] !== "");
	}
}
check("panel registered into shell.overlay", injectedSlots.includes("shell.overlay"));
check(
	"a sidebar toggle gives the hidden panel a permanent entry point",
	injectedSlots.includes("sidebar.footer.action"),
);
check("both registrations carry the locale seat", registrations.length === 2 && registrations.every((entry) => entry.descriptor?.id === "session-monitor" && entry.descriptor?.locale === "session-monitor"));

// --- the panel starts hidden ---------------------------------------------------

// The detached window is the product; the in-app card is the fallback the user
// opts into. This is the default the plugin ships with.
check(
	"the in-app panel renders nothing until it is asked for",
	overlayEntry().component({ t: (key) => key }) === null,
);
// ... and the sidebar row is how it is asked for, since a hidden panel with no
// affordance would be unreachable.
const sidebarToggle = sidebarEntry().component({ t: (key) => key });
check("the sidebar toggle renders", sidebarToggle !== null);
sidebarToggle.props.onContextMenu({ preventDefault: () => {} });
check(
	"the sidebar toggle's context menu shows the panel",
	overlayEntry().component({ t: (key) => key }) !== null,
);

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
const rowTitles = rows.map(cellTitle);
check(
	"attention and running rows lead, then by recency",
	JSON.stringify(rowTitles) === JSON.stringify(["Attention one", "Running one", "Done one"]),
);
const rowStates = rows.map(cellState);
check(
	"visible row states keep the active ones",
	JSON.stringify(rowStates) === JSON.stringify(["state.attention", "state.running", "state.done"]),
);
check(
	"the running row shows the animated live dot",
	cellDot(rows[1]).type === "span" && cellDot(rows[1]).props.className === "sm-live",
);
check(
	"settled rows keep the official state dot",
	cellDot(rows[0]).type === "StateDot" && cellDot(rows[0]).props.state === "warning" && cellDot(rows[2]).props.state === "done",
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
	cellTitle(rows[3]) === "Idle one" && cellState(rows[3]) === "state.idle",
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

// --- sub-agents: hierarchy, per-child state, and collapsing ---------------------

// The host's projection writes sub-agents into `byId` and often leaves them OUT
// of `ids` — the exact shape that made them invisible before. So this snapshot
// puts the child only in `byId`.
listState = {
	ids: ["p-1", "p-2"],
	byId: {
		"p-1": { id: "p-1", displayTitle: "Parent one", running: true, blank: false, updatedAt: 100 },
		"p-1-kid": { id: "p-1-kid", displayTitle: "Kid of one", running: true, blank: false, updatedAt: 0, parentId: "p-1", origin: "subagent" },
		"p-2": { id: "p-2", displayTitle: "Parent two", running: false, blank: false, updatedAt: 90 },
	},
	phase: "ready",
	projectionsBySession: {},
};
statusState = new Map([
	["p-1", { running: true, pendingInteraction: undefined, completionUnread: false }],
	["p-1-kid", { running: false, pendingInteraction: undefined, completionUnread: true }],
]);
for (const listener of listListeners) listener();

panel = renderPanel();
rows = collectRows(panel);
check(
	"a sub-agent that is absent from ids still reaches the panel",
	rows.some((row) => cellTitle(row) === "Kid of one"),
);
const parentRow = rows.find((row) => cellTitle(row) === "Parent one");
const kidRow = rows.find((row) => cellTitle(row) === "Kid of one");
check("the sub-agent renders directly under its parent", rows.indexOf(kidRow) === rows.indexOf(parentRow) + 1);
check("the sub-agent row is marked as a child", /(^|\s)sm-row(\s|$)/.test(kidRow.props.className) && /\bchild\b/.test(kidRow.props.className));
check("the parent row is not marked as a child", !/\bchild\b/.test(parentRow.props.className));
check(
	"the sub-agent carries its OWN state, not the parent's",
	cellState(kidRow) === "state.done" && cellState(parentRow) === "state.running",
);
check(
	"the parent advertises how many sub-agents it owns",
	parentRow.children[2].children.some((child) => child && child.props && child.props.className === "sm-row-kids"),
);
check("a parent with sub-agents offers a twisty", cellLead(parentRow).props.className === "sm-twisty");
check("a sub-agent row reserves the twisty column instead", cellLead(kidRow).props.className === "sm-twisty-spacer");

// Collapsing hides the child and is persisted.
parentRow.children[0].props.onClick({ stopPropagation: () => {} });
panel = renderPanel();
rows = collectRows(panel);
check("collapsing a parent hides its sub-agent", !rows.some((row) => cellTitle(row) === "Kid of one"));
check("collapsing keeps the parent row itself", rows.some((row) => cellTitle(row) === "Parent one"));
check("collapsing the chosen parent is persisted", storage.get("sm.collapsedParents") === JSON.stringify(["p-1"]));
const collapsedParent = rows.find((row) => cellTitle(row) === "Parent one");
check("the twisty reports the collapsed state", collapsedParent.children[0].props["aria-expanded"] === "false");
// And the collapse survives a restart, which is what "remembered" has to mean.
check(
	"the collapsed parent is still collapsed on the next start",
	!collectRows(bootFresh()).some((row) => cellTitle(row) === "Kid of one"),
);

// A collapsed parent must not be dropped by the active-only filter while it is
// hiding a child that the filter would have kept — otherwise a quiet parent
// would silently take its running sub-agent off screen with it.
listState = {
	ids: ["q-1"],
	byId: {
		"q-1": { id: "q-1", displayTitle: "Quiet parent", running: false, blank: false, updatedAt: 10 },
		"q-1-kid": { id: "q-1-kid", displayTitle: "Busy kid", running: true, blank: false, updatedAt: 0, parentId: "q-1", origin: "subagent" },
	},
	phase: "ready",
	projectionsBySession: {},
};
statusState = new Map([
	["q-1", { running: false, pendingInteraction: undefined, completionUnread: false }],
	["q-1-kid", { running: true, pendingInteraction: undefined, completionUnread: false }],
]);
storage.set("sm.collapsedParents", JSON.stringify(["q-1"]));
for (const listener of listListeners) listener();
panel = renderPanel();
rows = collectRows(panel);
check(
	"an idle parent hiding a running sub-agent survives the active-only filter",
	rows.some((row) => cellTitle(row) === "Quiet parent"),
);

// And with the child expanded, that same idle parent appears only because of it.
storage.set("sm.collapsedParents", JSON.stringify([]));
for (const listener of listListeners) listener();
panel = renderPanel();
rows = collectRows(panel);
check(
	"expanding shows the running sub-agent under its idle parent",
	rows.some((row) => cellTitle(row) === "Busy kid") && rows.some((row) => cellTitle(row) === "Quiet parent"),
);

// --- background opacity: adjustable and persisted -------------------------------

storage.delete("sm.collapsedParents");
listState = {
	ids: ["s-running"],
	byId: { "s-running": { id: "s-running", displayTitle: "Running one", running: true, blank: false, updatedAt: 70 } },
	phase: "ready",
	projectionsBySession: {},
};
statusState = new Map([["s-running", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
for (const listener of listListeners) listener();
panel = renderPanel();
const opacitySlider = collectByClass(panel, "sm-opacity")[0].children[1];
check("the panel offers an opacity control", opacitySlider !== undefined && opacitySlider.props.type === "range");
check(
	"the opacity control spans the legible range",
	opacitySlider.props.min === "0.2" && opacitySlider.props.max === "1",
);
opacitySlider.props.onChange({ target: { value: "0.5" } });
check("changing the opacity persists it", storage.get("sm.opacity") === "0.5");
panel = renderPanel();
const translucentRoot = collectByClass(panel, "sm-root")[0];
check(
	"the panel background carries the chosen alpha",
	/rgba\(32,\s*33,\s*36,\s*0?\.5\)/.test(String(translucentRoot.props.style.background)),
);
check(
	"the panel reports the opacity back to the user",
	collectByClass(panel, "sm-opacity-value")[0].children[0] === "50%",
);
// Only the background is translucent: the text color stays its own opaque token.
check(
	"the panel text color is left untouched by the alpha",
	translucentRoot.props.style.color === undefined,
);

// An out-of-range stored value is clamped rather than trusted, so a hand-edited
// entry cannot make the panel unreadable.
storage.set("sm.opacity", "0.01");
check(
	"a too-low stored opacity is clamped on load",
	collectByClass(bootFresh(), "sm-opacity-value")[0].children[0] === "20%",
);
storage.set("sm.opacity", "5");
check(
	"a too-high stored opacity is clamped on load",
	collectByClass(bootFresh(), "sm-opacity-value")[0].children[0] === "100%",
);
// The headline requirement: the value survives a restart and is applied again.
storage.set("sm.opacity", "0.8");
const reloaded = bootFresh();
check(
	"a stored opacity is restored on the next start",
	collectByClass(reloaded, "sm-opacity-value")[0].children[0] === "80%",
);
check(
	"the restored opacity is applied to the background, not just the label",
	/rgba\(32,\s*33,\s*36,\s*0?\.8\)/.test(String(collectByClass(reloaded, "sm-root")[0].props.style.background)),
);
storage.delete("sm.opacity");

// --- raising the app window on a row click --------------------------------------

const focusCalls = [];
globalThis.fetch = (url, options) => {
	const target = String(url);
	if (target.endsWith("/dsh-session-monitor/focus")) {
		focusCalls.push(options && options.body ? JSON.parse(options.body) : {});
		return Promise.resolve({ json: () => Promise.resolve({ ok: true, action: "restored:foreground" }) });
	}
	return Promise.reject(new Error("unexpected fetch " + target));
};
listState = {
	ids: ["s-running"],
	byId: { "s-running": { id: "s-running", displayTitle: "Running one", running: true, blank: false, updatedAt: 80 } },
	phase: "ready",
	projectionsBySession: {},
};
for (const listener of listListeners) listener();
panel = renderPanel();
collectRows(panel)[0].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check(
	"a row click asks the host to restore the app window",
	focusCalls.length === 1,
);
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

// A session that finishes while hidden (filtered out of the active view, or
// folded under a collapsed parent) must still notify: the whole point of the
// notice is that the user is away and cannot see the row.
notifications.length = 0;
storage.delete("sm.collapsedParents");
listState = {
	ids: ["h-1"],
	byId: {
		"h-1": { id: "h-1", displayTitle: "Hidden parent", running: true, blank: false, updatedAt: 200 },
		"h-1-kid": { id: "h-1-kid", displayTitle: "Child still running", running: true, blank: false, updatedAt: 0, parentId: "h-1", origin: "subagent" },
	},
	phase: "ready",
	projectionsBySession: {},
};
statusState = new Map([
	["h-1", { running: true, pendingInteraction: undefined, completionUnread: false }],
	["h-1-kid", { running: true, pendingInteraction: undefined, completionUnread: false }],
]);
for (const listener of listListeners) listener();

// Collapse the parent through the real control, so the live instance's own
// collapse set changes (writing storage would only take effect on a restart).
panel = renderPanel();
const hideParent = collectRows(panel).find((row) => cellTitle(row) === "Hidden parent");
hideParent.children[0].props.onClick({ stopPropagation: () => {} });
panel = renderPanel();
check(
	"the child is genuinely off screen before it finishes",
	!collectRows(panel).some((row) => cellTitle(row) === "Child still running"),
);

// Now the hidden child finishes.
listState = {
	ids: ["h-1"],
	byId: {
		"h-1": { id: "h-1", displayTitle: "Hidden parent", running: true, blank: false, updatedAt: 201 },
		"h-1-kid": { id: "h-1-kid", displayTitle: "Child still running", running: false, blank: false, updatedAt: 0, parentId: "h-1", origin: "subagent" },
	},
	phase: "ready",
	projectionsBySession: {},
};
statusState = new Map([
	["h-1", { running: true, pendingInteraction: undefined, completionUnread: false }],
	["h-1-kid", { running: false, pendingInteraction: undefined, completionUnread: true }],
]);
for (const listener of statusListeners) listener();
check(
	"a sub-agent that finishes while collapsed under its parent still notifies",
	notifications.length === 1,
);
storage.delete("sm.collapsedParents");

// --- the detached PiP window ----------------------------------------------------
//
// The Document-PiP path is a different renderer (raw DOM in another document,
// not React), so it can silently drift from the panel: the panel can gain
// opacity and child rows while the PiP window keeps drawing a flat opaque list.
// This drives the real buildPip/renderPip code against a minimal document stub.

/** A tiny DOM stub just rich enough for buildPip and renderPip. */
function createPipDocument() {
	const makeElement = (tag) => {
		const element = {
			tagName: tag,
			className: "",
			textContent: "",
			innerHTML: "",
			title: "",
			type: "",
			style: {},
			children: [],
			classList: { toggle: () => {}, add: () => {}, remove: () => {} },
			appendChild(child) {
				this.children.push(child);
				return child;
			},
			/** Handlers the code registered, so a test can really fire them. */
			handlers: {},
			addEventListener(event, handler) {
				if (!this.handlers[event]) this.handlers[event] = [];
				this.handlers[event].push(handler);
			},
			/** Invoke the click handlers the way a user's click would. */
			fireClick() {
				for (const handler of this.handlers.click || []) handler({ stopPropagation: () => {} });
			},
			querySelector(selector) {
				return this.bySelector(selector);
			},
			bySelector(selector) {
				const wanted = selector.replace(/^\./, "");
				for (const child of this.children) {
					if ((child.className || "").split(/\s+/).includes(wanted)) return child;
					const nested = child.bySelector ? child.bySelector(selector) : null;
					if (nested) return nested;
				}
				return null;
			},
		};
		return element;
	};
	const body = makeElement("body");
	const head = makeElement("head");
	const doc = {
		title: "",
		body,
		head,
		createElement: (tag) => makeElement(tag),
		querySelector(selector) {
			return body.bySelector(selector);
		},
	};
	// buildPip assigns body.innerHTML then queries the skeleton, so materialize
	// the elements it expects.
	Object.defineProperty(body, "innerHTML", {
		get() {
			return "";
		},
		set() {
			body.children = [];
			for (const [className, tag] of [
				["sm-pip", "div"],
				["sm-pip-title", "span"],
				["sm-pip-filter", "button"],
				["sm-pip-recall", "button"],
				["sm-pip-list", "div"],
				["sm-pip-hint", "div"],
			]) {
				const element = makeElement(tag);
				element.className = className;
				body.appendChild(element);
			}
		},
	});
	return doc;
}

const pipDocument = createPipDocument();
const pipStub = {
	document: pipDocument,
	addEventListener: () => {},
	close: () => {},
};
globalThis.window.documentPictureInPicture = {
	requestWindow: () => Promise.resolve(pipStub),
};

// A sub-agent plus a running parent, so the PiP window is exercised on both.
listState = {
	ids: ["pip-parent"],
	byId: {
		"pip-parent": { id: "pip-parent", displayTitle: "Pip parent", running: true, blank: false, updatedAt: 300 },
		"pip-parent-kid": { id: "pip-parent-kid", displayTitle: "Pip child", running: false, blank: false, updatedAt: 301, parentId: "pip-parent", origin: "subagent" },
	},
	phase: "ready",
	projectionsBySession: {},
};
statusState = new Map([
	["pip-parent", { running: true, pendingInteraction: undefined, completionUnread: false }],
	["pip-parent-kid", { running: false, pendingInteraction: undefined, completionUnread: true }],
]);
for (const listener of listListeners) listener();

// Set a distinctive alpha through the panel's own control, so the assertion
// below compares the two surfaces rather than a hardcoded number.
panel = renderPanel();
const pipOpacitySlider = collectByClass(panel, "sm-opacity")[0].children[1];
pipOpacitySlider.props.onChange({ target: { value: "0.35" } });

// Detach through the real button, which now takes the Document-PiP path.
const pipDetach = collect(panel, "sm-btn", []).find((node) => node.children[0] === "panel.detach");
pipDetach.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));

const pipList = pipDocument.body.querySelector(".sm-pip-list");
check("the PiP window received rows", pipList !== null && pipList.children.length >= 2);
check(
	"the PiP window renders the parent row",
	pipList.children.some((child) => child.title === "Pip parent"),
);
check(
	"the PiP window indents the sub-agent row",
	pipList.children.some((child) => /\bchild\b/.test(child.className || "")),
);
// The requirement is that the setting reads the same in both places, so this
// compares the two surfaces instead of restating the alpha.
const panelSurface = String(collectByClass(renderPanel(), "sm-root")[0].props.style.background);
check(
	"the PiP window applies the same background opacity as the panel",
	String(pipDocument.body.style.background) === panelSurface &&
		/rgba\(32,\s*33,\s*36,\s*0?\.35\)/.test(String(pipDocument.body.style.background)),
);

// Clicking a row IN THE DETACHED WINDOW must also restore the app: the focus
// path has to serve both surfaces, and the detached window is a different
// renderer with its own click listeners.
const pipFocusCalls = [];
globalThis.fetch = (url, options) => {
	const target = String(url);
	if (target.endsWith("/dsh-session-monitor/focus")) {
		pipFocusCalls.push(options && options.body ? JSON.parse(options.body) : {});
		return Promise.resolve({ json: () => Promise.resolve({ ok: true, action: "restored:foreground" }) });
	}
	return Promise.reject(new Error("unexpected fetch " + target));
};
// Fire the click listener renderPip attached to the row.
pipList.children[0].fireClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check(
	"a row click inside the detached window also asks the host to restore the app",
	pipFocusCalls.length === 1,
);
globalThis.fetch = realFetch;
globalThis.window.documentPictureInPicture = undefined;
storage.delete("sm.opacity");

// --- report -------------------------------------------------------------------

if (failures.length > 0) {
	console.error("session-monitor client check failed:");
	for (const failure of failures) console.error(" - " + failure);
	process.exitCode = 1;
} else {
	console.log("session-monitor client check passed");
}
