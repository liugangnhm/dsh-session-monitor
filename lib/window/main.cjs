/**
 * Main process for the detached monitor window.
 *
 * This is NOT a second copy of the app: the Host runs one of these by
 * relaunching the desktop shell's own executable against a mirrored runtime
 * directory (see `lib/window-runtime.js`), so the window is a real Electron
 * `BrowserWindow` owned by a real Electron main process. Everything the panel
 * needs from the OS — always-on-top, whole-window opacity, minimize, maximize,
 * restore, hide — is therefore Electron's own window API.
 *
 * The window is a pure view: it never talks to the DSH client. It reads the
 * Host's existing loopback routes (state / pending / consume / command / open),
 * so the Host's dedupe funnel and queues are untouched.
 *
 * @module dsh-session-monitor/window/main
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const shared = require('./shared.js');

/**
 * Command-line flags this window recognises.
 *
 * The Host passes them after `--`, so they never collide with the flags the
 * shell's own bootstrap reads before the app is loaded.
 */
const ARGS = parseArgs(process.argv);

/**
 * The configuration the Host wrote next to this window program.
 *
 * Configuration travels in a FILE, not on the command line. Measured: passing
 * `-- --origin http://127.0.0.1:PORT` makes Chromium treat `--origin` as one of
 * its own switches and the page then fails to load at all (`ERR_FAILED`), so the
 * window never appeared. A file has no such ambiguity, and it also keeps the
 * Host's port out of every process listing.
 *
 * The file is read once at startup; the window only needs it then.
 */
const CONFIG = loadConfig(ARGS.config);

/** Localized strings, shipped by the Host so both halves share one dictionary. */
const STRINGS = loadStrings(CONFIG.strings);

/** Persisted window preferences (rectangle + alpha). */
const PREFS_PATH = CONFIG.prefs || '';

/** Base URL of the Host, e.g. `http://127.0.0.1:52767`. */
const ORIGIN = String(CONFIG.origin || '').replace(/\/+$/, '');

/** Route paths, passed in so the plugin can rename them in one place. */
const STATE_PATH = String(CONFIG.statePath || '/dsh-session-monitor/state');
const PENDING_PATH = String(CONFIG.pendingPath || '/dsh-session-monitor/pending');
const CONSUME_PATH = String(CONFIG.consumePath || '/dsh-session-monitor/consume');
const COMMAND_PATH = String(CONFIG.commandPath || '/dsh-session-monitor/command');
const OPEN_PATH = String(CONFIG.openPath || '/dsh-session-monitor/open');

/** The current window, or null before creation / after close. */
let window = null;

/**
 * The level that verifiably produced a topmost window, kept so later
 * re-assertions use the same one instead of re-probing the whole list.
 */
let topmostLevel = null;

// --- argv and locale -------------------------------------------------------------

/**
 * Split `--flag value` / `--flag=value` pairs out of argv.
 *
 * Only the segment after a bare `--` is ours; everything before it belongs to
 * the Electron/Chromium bootstrap and is ignored.
 * @param argv - the raw process argv.
 * @returns a flat map of recognized flags.
 */
function parseArgs(argv) {
	const separator = argv.indexOf('--');
	const tail = separator >= 0 ? argv.slice(separator + 1) : [];
	const map = {};
	for (let index = 0; index < tail.length; index += 1) {
		const token = tail[index];
		if (typeof token !== 'string' || !token.startsWith('--')) continue;
		const body = token.slice(2);
		const equals = body.indexOf('=');
		if (equals >= 0) {
			map[body.slice(0, equals)] = body.slice(equals + 1);
			continue;
		}
		const next = tail[index + 1];
		if (next !== undefined && !String(next).startsWith('--')) {
			map[body] = String(next);
			index += 1;
		} else {
			map[body] = 'true';
		}
	}
	return map;
}

/**
 * Load the configuration the Host wrote for this window.
 *
 * Configuration travels in a file rather than on the command line: measured,
 * `-- --origin http://127.0.0.1:PORT` makes Chromium claim `--origin` as one of
 * its own switches and the page then fails to load (`ERR_FAILED`), so no window
 * ever appeared. Keeping it in a file also avoids putting the Host's port in
 * every process listing.
 *
 * @param path - the JSON file path, if any.
 * @returns the parsed configuration, or an empty object.
 */
function loadConfig(path) {
	if (!path || !existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Load the locale dictionary the Host wrote for this window.
 *
 * Missing or malformed input falls back to built-in English rather than leaving
 * the window blank — a blank always-on-top rectangle is the worst outcome.
 * @param path - the JSON file path, if any.
 * @returns a flat string map.
 */
function loadStrings(path) {
	// English is the last-resort fallback, used only when the Host could not write
	// a string table at all. It is not the default language: the table carries
	// whatever language the app is actually showing.
	const fallback = {
		title: 'Sessions',
		hint: 'Click a session to open it',
		filterActive: 'Active',
		filterAll: 'All',
		filterActiveTip: 'Showing active sessions only; click for all',
		filterAllTip: 'Showing all sessions; click for active only',
		notifyOn: 'Notify',
		notifyOff: 'Muted',
		empty: 'No active sessions',
		emptyAll: 'No sessions',
		opacityTip: 'Panel opacity',
		collapseChildren: 'Collapse sub-agents',
		expandChildren: 'Expand sub-agents',
		minimize: 'Minimize',
		maximize: 'Maximize',
		restore: 'Restore',
		close: 'Close',
		running: 'Running',
		attention: 'Needs you',
		done: 'Done',
		idle: 'Idle',
	};
	if (!path || !existsSync(path)) return fallback;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		return { ...fallback, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
	} catch {
		return fallback;
	}
}

// --- preferences -----------------------------------------------------------------

/**
 * Saved preferences, loaded once.
 * @returns the parsed object, or an empty one.
 */
function readPrefs() {
	if (PREFS_PATH === '' || !existsSync(PREFS_PATH)) return {};
	try {
		const parsed = JSON.parse(readFileSync(PREFS_PATH, 'utf8'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Persist preferences.
 *
 * Written through a temporary file: a torn write would otherwise lose the
 * saved rectangle and the window would reopen in the default corner.
 * @param patch - fields to merge over the current file.
 */
function writePrefs(patch) {
	if (PREFS_PATH === '') return;
	try {
		const next = { ...readPrefs(), ...patch, savedAt: Date.now() };
		mkdirSync(dirname(PREFS_PATH), { recursive: true });
		const temporary = PREFS_PATH + '.tmp';
		writeFileSync(temporary, JSON.stringify(next, null, 2));
		try {
			renameSync(temporary, PREFS_PATH);
		} catch {
			copyFileSync(temporary, PREFS_PATH);
		}
	} catch {
		// A window that cannot remember its position is still a working window.
	}
}

// --- startup failure --------------------------------------------------------------

/**
 * Report a startup failure on the protocol channel the Host already reads.
 *
 * A window that cannot appear is reported as a failure line, never as success:
 * "the spawn said ok but no window appeared" was the worst failure of the old
 * implementation, and this window has no room to repeat it.
 * @param detail - why the window is not usable.
 */
function failStartup(detail) {
	try {
		process.stdout.write(JSON.stringify({ protocolVersion: 1, kind: 'error', detail: String(detail || 'window failed') }) + '\n');
	} catch {}
	app.quit();
}

/**
 * Apply always-on-top and verify it actually took.
 *
 * Electron's `isAlwaysOnTop()` is NOT trustworthy here: measured on 44.7.0 for
 * Windows, `setAlwaysOnTop(true)` reports `true` while the window's
 * `WS_EX_TOPMOST` bit stays clear, and `alwaysOnTop: true` in the constructor
 * reports `false` yet the window is nothing of the sort. So the levels are tried
 * in order until the getter agrees, and the level that worked is kept for later
 * re-assertions. A panel that believes it is on top while sinking behind other
 * windows is exactly the "always-on-top does not work" report.
 * @returns the level that verified, or null when none did.
 */
function applyAlwaysOnTop() {
	if (!window || window.isDestroyed()) return null;
	for (const level of shared.TOPMOST_LEVELS) {
		try {
			window.setAlwaysOnTop(true, level);
			if (window.isAlwaysOnTop()) {
				topmostLevel = level;
				return level;
			}
		} catch {}
	}
	// Last resort: the plain call. It reports false on the platforms measured,
	// but on a platform where the levels are unknown it may be the working one.
	try {
		window.setAlwaysOnTop(true);
		if (window.isAlwaysOnTop()) {
			topmostLevel = '(default)';
			return topmostLevel;
		}
	} catch {}
	return null;
}

/**
 * Re-assert always-on-top after an operation Windows uses as a reason to drop it.
 *
 * `show`, `restore` and `focus` can all clear the topmost bit on Windows; the
 * panel is useless without it, so every one of those paths ends here.
 */
function keepOnTop() {
	const level = topmostLevel || applyAlwaysOnTop();
	if (!level || !window || window.isDestroyed()) return;
	try {
		window.setAlwaysOnTop(true, level === '(default)' ? undefined : level);
	} catch {}
}

// --- the window -------------------------------------------------------------------

/**
 * Build the always-on-top panel.
 *
 * `showInactive()` is deliberate: a monitor that steals focus every time it
 * appears would interrupt whatever the user is typing in the app it monitors.
 */
function createWindow() {
	const saved = readPrefs();
	const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
	const bounds = shared.clampBounds(saved.bounds, display.workArea, { width: shared.MIN_WIDTH, height: shared.MIN_HEIGHT });

	window = new BrowserWindow({
		...bounds,
		minWidth: shared.MIN_WIDTH,
		minHeight: shared.MIN_HEIGHT,
		frame: false,
		transparent: true,
		resizable: true,
		// Passed for intent, but the authoritative application is
		// `applyAlwaysOnTop()` below: this option alone does not set the bit.
		alwaysOnTop: true,
		skipTaskbar: true,
		show: false,
		backgroundColor: '#00000000',
		title: STRINGS.title,
		webPreferences: {
			preload: join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			spellcheck: false,
		},
	});

	window.setOpacity(shared.clampOpacity(saved.opacity));

	const loadGuard = setTimeout(() => failStartup('the window did not finish rendering in time'), 10000);
	loadGuard.unref?.();

	window.loadFile(join(__dirname, 'index.html')).catch((error) => failStartup('load: ' + String((error && error.message) || error)));

	window.once('ready-to-show', () => {
		clearTimeout(loadGuard);
		if (!window) return;
		window.showInactive();
		// Applied after the first show: before that there is no HWND to style,
		// which is why setting it in the constructor provably did nothing.
		const level = applyAlwaysOnTop();
		if (level === null) console.error('[session-monitor] always-on-top could not be verified');
		// The readiness handshake is the Host's proof that a window really
		// exists. It is sent only here — after the first paint — so a spawn that
		// produced a process but no window can never be reported as a success.
		sendLine({ kind: 'ready', topmost: level !== null });
		// Polling starts only now. Starting it while the page is still loading
		// made the first load fail outright (`ERR_FAILED`, measured) whenever the
		// Host was reachable, which meant the window never appeared at all.
		startPolling();
	});

	// Any path that can clear the topmost bit re-asserts it.
	window.on('show', keepOnTop);
	window.on('restore', keepOnTop);
	window.on('focus', keepOnTop);

	window.on('closed', () => {
		window = null;
		app.quit();
	});

	// Remember where the user put it — but not the rectangle a maximize or a
	// minimize produces, which would bring the window back in that shape.
	let saveTimer = 0;
	const remember = () => {
		if (!window || window.isDestroyed() || window.isMaximized() || window.isMinimized()) return;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			if (!window || window.isDestroyed() || window.isMaximized() || window.isMinimized()) return;
			writePrefs({ bounds: window.getBounds() });
		}, 400);
	};
	window.on('moved', remember);
	window.on('resized', remember);
}

// --- the Host ---------------------------------------------------------------------

/** Consecutive failed polls; the orphan guard that closes the window. */
let failures = 0;
/** Timer handles, cleared on close. */
let stateTimer = 0;
let pendingTimer = 0;

/**
 * GET one JSON route from the Host.
 * @param path - route path, starting with `/`.
 * @returns parsed JSON, or null on any failure.
 */
async function getJson(path) {
	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), 4000);
	try {
		const response = await fetch(ORIGIN + path, { signal: controller.signal });
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	} finally {
		clearTimeout(deadline);
	}
}

/**
 * POST one JSON body to the Host.
 * @param path - route path.
 * @param body - JSON-serializable body.
 */
async function postJson(path, body) {
	try {
		await fetch(ORIGIN + path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	} catch {}
}

/** Send one protocol line to the Host over stdout (the pipe transport). */
function sendLine(message) {
	try {
		process.stdout.write(JSON.stringify({ protocolVersion: 1, ...message }) + '\n');
	} catch {}
}

/** Push a snapshot into the renderer. */
function push(payload) {
	if (!window || window.isDestroyed()) return;
	window.webContents.send('state', payload);
}

/**
 * Poll the Host's state route once per second and hand it to the renderer.
 *
 * The Host owns the snapshot; this window never computes status. That is what
 * keeps the panel and the in-app list from disagreeing.
 */
async function pollState() {
	const data = await getJson(STATE_PATH);
	if (!window || window.isDestroyed()) return;
	if (!data || data.ok !== true) {
		failures += 1;
		// Ten seconds of silence means the Host is gone; an always-on-top window
		// left behind would be impossible to explain to the user.
		if (failures >= 10) {
			window.webContents.send('host-gone', true);
			app.quit();
		}
		return;
	}
	failures = 0;
	push({
		rows: Array.isArray(data.rows) ? data.rows : [],
		showAll: data.showAll === true,
		notifyOn: data.notifyOn !== false,
		opacity: typeof data.opacity === 'number' ? data.opacity : 1,
		totalCount: typeof data.totalCount === 'number' ? data.totalCount : 0,
		runningCount: typeof data.runningCount === 'number' ? data.runningCount : 0,
	});
}

/**
 * Drain the Host's queues.
 *
 * Row clicks and header toggles reach the Host through TWO transports (a stdout
 * protocol line and an HTTP POST) so a broken pipe cannot make a button silently
 * do nothing. The Host folds the pair into one event; this side only has to
 * deliver both. What arrives here is the opposite direction: settings the
 * browser half changed, which the window must adopt.
 */
async function pollPending() {
	const data = await getJson(PENDING_PATH);
	if (!window || window.isDestroyed() || !data || data.ok !== true) return;

	// `data.open` is deliberately NOT an exit condition. It mirrors the Host's
	// own `windowReady`, which only becomes true once the Host has READ this
	// window's `ready` line — a moment that can be later than this window's
	// first poll. Acting on it closed the window instantly and intermittently
	// (measured: ready, one state push, then exit). A real close (收回, or the
	// plugin unloading) kills this process from the Host side already, and
	// `pollState`'s orphan guard covers a Host that disappeared.

	const items = Array.isArray(data.items) ? data.items.filter((id) => typeof id === 'string') : [];
	const commands = Array.isArray(data.commands) ? data.commands.filter((a) => typeof a === 'string') : [];
	const children = Array.isArray(data.children) ? data.children.filter((id) => typeof id === 'string') : [];
	const opacity = typeof data.opacity === 'number' ? data.opacity : null;

	if (items.length === 0 && commands.length === 0 && children.length === 0 && opacity === null) return;

	// Report what is being consumed so the Host's queues are emptied; otherwise
	// the same open request would be replayed on every poll.
	if (items.length > 0 || commands.length > 0 || children.length > 0 || opacity !== null) {
		await postJson(CONSUME_PATH, {
			ids: items,
			commands,
			children,
			...(opacity !== null ? { opacity: true } : {}),
		});
	}
	if (items.length > 0) push({ requestedOpens: items });
	if (commands.length > 0) push({ requestedCommands: commands });
	if (children.length > 0) push({ requestedChildren: children });
	if (opacity !== null) push({ requestedOpacity: opacity });
}

/** Start both poll loops. */
function startPolling() {
	if (stateTimer) return;
	stateTimer = setInterval(pollState, 1000);
	pendingTimer = setInterval(pollPending, 700);
	stateTimer.unref?.();
	pendingTimer.unref?.();
	void pollState();
	void pollPending();
}

/** Stop both poll loops (used when the window closes). */
function stopPolling() {
	if (stateTimer) clearInterval(stateTimer);
	if (pendingTimer) clearInterval(pendingTimer);
	stateTimer = 0;
	pendingTimer = 0;
}

// --- IPC --------------------------------------------------------------------------

/**
 * Header buttons, all Electron API.
 *
 * The renderer only asks; the main process owns the window. That split keeps
 * `contextIsolation` on and gives one auditable place for every window
 * operation.
 */
ipcMain.on('monitor:window', (event, action) => {
	if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
	try {
		if (action === 'minimize') window.minimize();
		else if (action === 'maximize') {
			if (window.isMaximized()) window.unmaximize();
			else window.maximize();
		} else if (action === 'close') window.close();
		else if (action === 'hide') window.hide();
		else if (action === 'show') window.showInactive();
		else if (action === 'focus') window.focus();
	} catch {}
});

/** Whole-window alpha; the renderer never fakes translucency with CSS. */
ipcMain.on('monitor:opacity', (event, value) => {
	if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
	const alpha = shared.clampOpacity(value);
	window.setOpacity(alpha);
	writePrefs({ opacity: alpha });
	// Both transports, same as every other control: the browser half persists
	// the setting, and a single lost delivery must not make the slider look
	// like it did nothing next time the panel opens.
	sendLine({ kind: 'opacity', value: alpha });
	void postJson(COMMAND_PATH, { action: 'set-opacity', value: alpha });
});

/** A click on a row: the Host owns navigation (and raising the app window). */
ipcMain.on('monitor:open', (event, payload) => {
	if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
	const id = payload && typeof payload.id === 'string' ? payload.id : '';
	if (id === '') return;
	sendLine({ kind: 'open', id });
	void postJson(OPEN_PATH, { id });
});

/** Header toggles (`toggle-filter`, `toggle-notify`). */
ipcMain.on('monitor:command', (event, action) => {
	if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
	if (typeof action !== 'string' || action === '') return;
	sendLine({ kind: 'command', action });
	void postJson(COMMAND_PATH, { action });
});

/** Twisty presses: the parent whose sub-agents collapse/expand. */
ipcMain.on('monitor:children', (event, id) => {
	if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
	if (typeof id !== 'string' || id === '') return;
	sendLine({ kind: 'children', parentId: id });
	void postJson(COMMAND_PATH, { action: 'toggle-children', parentId: id });
});

/** The renderer's initial payload: strings, saved alpha, its own capabilities. */
ipcMain.on('monitor:bootstrap', (event) => {
	const saved = readPrefs();
	event.returnValue = {
		strings: STRINGS,
		opacity: shared.clampOpacity(saved.opacity),
		platform: process.platform,
	};
});

// --- lifecycle --------------------------------------------------------------------

// A single instance per userData; the Host gives this window its own scratch
// directory, so this lock only guards against a second monitor window.
if (!app.requestSingleInstanceLock()) {
	failStartup('another monitor window is already running');
} else {
	app.on('second-instance', () => {
		if (!window || window.isDestroyed()) return;
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	});

	app
		.whenReady()
		.then(createWindow)
		.catch((error) => failStartup(String((error && error.message) || error)));

	app.on('window-all-closed', () => app.quit());

	// The panel is a local view: it must never navigate or spawn windows.
	app.on('web-contents-created', (_event, contents) => {
		contents.setWindowOpenHandler(() => ({ action: 'deny' }));
		contents.on('will-navigate', (event) => event.preventDefault());
	});

	app.on('before-quit', stopPolling);
}

// A renderer crash would leave a blank always-on-top rectangle the user cannot
// dismiss; report it and let the Host decide.
app.on('render-process-gone', (_event, _contents, details) => {
	failStartup('renderer gone: ' + String((details && details.reason) || 'unknown'));
});
