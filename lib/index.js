/**
 * dsh-session-monitor, node half.
 *
 * Two jobs:
 *
 * 1. UI carrier — the same pattern as the shipped
 *    `@deepseek-ai/dsh-client-ui-open-in-app`: this entry puts a Loader row in
 *    the tree so the browser half, discovered through the package's
 *    `dsh.client` declaration and served from `exports["./client"]`, reaches
 *    the page.
 *
 * 2. The detached window. The browser half runs inside a sandboxed iframe in
 *    the desktop app, where Document Picture-in-Picture fails ("Internal error:
 *    no window") and `window.open` is blocked; the Host is only a plain-Node
 *    child of the app's main process, so `require('electron')` does not resolve
 *    either. On Windows the window is therefore a generated PowerShell WPF
 *    window: frameless, always-on-top, spawned with `node:child_process`.
 *
 * The window speaks a line-delimited JSON protocol on stdout (`ready`, `pong`,
 * `open`, `closed`) and reads its data by polling `GET /state`, which the
 * browser half keeps pushing. The Host answers a detach request only after the
 * window reported `ready` — a spawn that produces no window is reported as a
 * failure instead of a success.
 *
 * Raising the app window is the ONE thing this file does not reimplement: the
 * desktop shell already owns the correct Electron sequence (`restore()`,
 * `show()`, `focus()`) and runs it on its single-instance / `dsh://open`
 * channel. The Host relaunches the shell's own executable with that deep link,
 * so the existing instance raises itself with Electron's own API — no
 * `ShowWindow`/`SetForegroundWindow` from a helper process.
 *
 * @module dsh-session-monitor
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { prepareWindowRuntime, removeWindowRuntime } from './window-runtime.js';

/** Cordis function-plugin name. */
export const name = 'session-monitor';

/** Loopback routes under one prefix. */
const ROUTE = '/dsh-session-monitor';

/** Loopback endpoints the window talks to. */
const STATE_PATH = `${ROUTE}/state`;
const OPEN_PATH = `${ROUTE}/open`;
const COMMAND_PATH = `${ROUTE}/command`;
const WINDOW_PATH = `${ROUTE}/window`;
/** Restores and foregrounds the app window when a row is clicked. */
const FOCUS_PATH = `${ROUTE}/focus`;

/** Line protocol shared with the window process. */
const PROTOCOL_VERSION = 1;
/**
 * How long a fresh window gets to report `ready` before it counts as failed.
 *
 * An Electron window is slower to first paint than the old WPF script — it
 * boots a Chromium process — so this is larger than the WPF budget was. It is
 * still an honest deadline: the window reports `ready` from
 * `ready-to-show`, i.e. after it actually has something to draw.
 */
const READY_TIMEOUT_MS = 15000;
/**
 * How long the shell's own relaunch gets to hand its deep link to the running
 * instance (and exit) before the request counts as failed.
 *
 * The second Electron process does its work and exits on its own; this is only
 * the patience for "the OS accepted the launch and the launcher went away".
 * It is not a window-operation deadline: the running instance raises itself
 * asynchronously after the hand-off.
 */
const RAISE_TIMEOUT_MS = 8000;
/**
 * Deep link the desktop shell treats as "bring the primary window forward".
 *
 * `class DesktopHostProcess`/`main.js` in the shipped shell registers
 * `app.setAsDefaultProtocolClient('dsh')`, and its `open-url` handler calls
 * `focusPrimaryWindow()` — the same function its single-instance handler runs:
 * `if (window.isMinimized()) window.restore(); window.show(); window.focus()`.
 * That is Electron's own window API, executed by the process that OWNS the
 * window; this plugin only asks for it.
 */
const RAISE_URL = 'dsh://open';
/**
 * How long a repeated report of the same thing counts as the same event.
 *
 * The window deliberately reports every interaction on TWO transports (a stdout
 * protocol line and an HTTP POST), so that a broken pipe cannot make a control
 * silently dead. Both land here, so the host is the one place the pair can be
 * collapsed back into one event. Without this, a TOGGLE (unlike a row click,
 * which is idempotent) is applied twice and cancels itself out — the control
 * looks broken. The window is small: the two deliveries are milliseconds apart,
 * while a deliberate second click is far slower.
 */
const REPORT_DEDUPE_MS = 300;
/** Actions the window's header buttons may request. */
const WINDOW_ACTIONS = new Set(['toggle-filter', 'toggle-notify']);

/** Only loopback callers may use these routes; they expose host internals. */
function isLocalRequest(request) {
	const host = String((request && request.headers && request.headers.host) || '');
	return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host.startsWith('[::1]:');
}

/**
 * Pick the origin the window must poll for state.
 *
 * The request's own Host header wins: it is the address the browser half just
 * reached this Host through, so the window can reach it by construction. The
 * client's `location.origin` is only a fallback, because the browser half runs
 * inside a sandboxed iframe where that value is the literal string `"null"` —
 * handing that to the window made every state poll fail, and the window's
 * orphan guard closed it a few seconds after it appeared.
 *
 * @param request - the incoming window-control request.
 * @param provided - the browser half's reported origin, if any.
 * @returns an `http://host[:port]` origin, or an empty string when neither
 *   source yields one (the caller must refuse to open a window then).
 */
function resolveWindowOrigin(request, provided) {
	const candidate = typeof provided === 'string' ? provided.trim().replace(/\/+$/, '') : '';
	if (/^https?:\/\/[^\s/]+$/i.test(candidate)) return candidate;
	const host = String((request && request.headers && request.headers.host) || '').trim();
	if (host !== '' && /^[^\s/]+$/.test(host)) return `http://${host}`;
	return '';
}

/** Read one JSON request body, capped, rejecting on malformed input. */
function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		let raw = '';
		request.on('data', (chunk) => {
			raw += chunk;
			if (raw.length > 1e6) {
				reject(new Error('body too large'));
				request.destroy();
			}
		});
		request.on('end', () => {
			if (!raw) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch (error) {
				reject(error);
			}
		});
		request.on('error', reject);
	});
}

/** Coerce one browser-half snapshot into the window's row shape. */
function normalizeState(state) {
	const rows = Array.isArray(state && state.rows)
		? state.rows.map((row) => ({
				id: String(row.id),
				title: typeof row.title === 'string' && row.title !== '' ? row.title : String(row.id),
				state: typeof row.state === 'string' ? row.state : 'idle',
				blank: row.blank === true,
				updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
				// The hierarchy facts travel with the row: the WPF window draws its
				// own controls and cannot recompute the browser half's tree.
				child: row.child === true,
				childCount: typeof row.childCount === 'number' ? row.childCount : 0,
				collapsed: row.collapsed === true,
			}))
		: [];
	return {
		rows,
		runningCount: typeof (state && state.runningCount) === 'number' ? state.runningCount : 0,
		showAll: !!(state && state.showAll),
		notifyOn: !(state && state.notifyOn === false),
		// The panel alpha reaches the window as data, so transparency survives
		// minimizing DSH (the window keeps rendering with the app hidden).
		opacity: typeof (state && state.opacity) === 'number' ? state.opacity : 1,
		totalCount: typeof (state && state.totalCount) === 'number' ? state.totalCount : rows.length,
	};
}

// --- the detached window ----------------------------------------------------------

let windowChild = null;
/** True once the window reported `ready`; the honest "a window exists" fact. */
let windowReady = false;
let windowState = { rows: [], runningCount: 0, showAll: false, notifyOn: true, totalCount: 0 };
/**
 * The language id the browser half last reported (`ctx.locale`'s active value).
 *
 * Held between requests because the window's strings are written when it opens,
 * which is a later request than the one that carries the language. An empty
 * string means "not reported yet"; `windowLanguage()` then guesses.
 */
let windowLanguageTag = '';
/** Scratch directory holding the mirrored Electron runtime for this window. */
let windowWorkDirectory = null;
/** `userData` inside the mirror; kept separate from the real app's profile. */
let windowUserData = null;
/** Last stderr lines, quoted back when a window fails to come up. */
const windowStderr = [];
/** Recent window protocol traffic, for the diagnostics endpoint. */
const windowMessages = [];
/** Resolvers waiting for the readiness handshake. */
let readyWaiters = [];
/** Session ids a window asked to open, drained by the browser half. */
const pendingOpens = [];
/** Header actions a window asked for, drained by the browser half. */
const pendingCommands = [];
/** Parent ids whose sub-agent rows a window asked to collapse/expand. */
const pendingChildren = [];
/** The background alpha a window's slider last reported, or null. */
let pendingOpacity = null;
/** The in-flight shell raise request; at most one at a time. */
let raiseFlight = null;
/** key → time the window last reported it, for the two-transport dedupe. */
const reportedAt = new Map();

/**
 * Decide whether a window report is new, or the twin of one just handled.
 *
 * Every window interaction arrives twice — once as a stdout protocol line, once
 * as an HTTP POST — so this collapses the pair. It is keyed by event kind and
 * target, so two different parents' twisties (or a twisty and a filter toggle)
 * never mask each other, and it only looks at the last few hundred milliseconds,
 * so a user pressing the same control again still registers.
 *
 * @param key - what the window reported, e.g. `children:p-1`.
 * @returns true when this is the first sighting and should be acted on.
 */
function isFreshReport(key) {
	const now = Date.now();
	const previous = reportedAt.get(key);
	if (previous !== undefined && now - previous < REPORT_DEDUPE_MS) return false;
	reportedAt.set(key, now);
	// Keep the map from growing without bound over a long-lived window.
	if (reportedAt.size > 64) {
		for (const [existing, at] of reportedAt) {
			if (now - at >= REPORT_DEDUPE_MS) reportedAt.delete(existing);
		}
	}
	return true;
}

/**
 * Process one window report, whichever transport carried it.
 *
 * Both transports funnel through here so the dedupe (and any future rule) is
 * stated once instead of twice. The caller has already checked the shape.
 *
 * @param kind - the protocol kind: `open`, `command`, `children` or `opacity`.
 * @param payload - the report's fields.
 * @returns a short label for the diagnostics ring, or an empty string.
 */
function acceptWindowReport(kind, payload) {
	if (kind === 'open') {
		const id = typeof payload.id === 'string' ? payload.id : '';
		if (id === '') return '';
		// Row clicks are idempotent, so a duplicate is harmless — but it is still
		// the same event and need not be queued twice.
		if (!isFreshReport('open:' + id)) return 'open:' + id;
		pendingOpens.push(id);
		return 'open:' + id;
	}
	if (kind === 'command') {
		const action = typeof payload.action === 'string' ? payload.action : '';
		if (!WINDOW_ACTIONS.has(action)) return '';
		if (!isFreshReport('command:' + action)) return 'command:' + action;
		pendingCommands.push(action);
		return 'command:' + action;
	}
	if (kind === 'children') {
		const id = typeof payload.id === 'string' ? payload.id : '';
		if (id === '') return '';
		if (!isFreshReport('children:' + id)) return 'children:' + id;
		pendingChildren.push(id);
		return 'children:' + id;
	}
	if (kind === 'opacity') {
		const value = typeof payload.value === 'number' ? payload.value : Number.parseFloat(String(payload.value));
		if (!Number.isFinite(value)) return '';
		// Latest wins, and the value itself is the dedupe key: a repeated report
		// of the same alpha is a no-op anyway.
		if (!isFreshReport('opacity:' + String(value))) return 'opacity:' + String(value);
		pendingOpacity = Math.min(1, Math.max(0.2, value));
		return 'opacity:' + String(value);
	}
	return '';
}

/** Read one protocol line from the window's stdout. */
function handleWindowLine(line) {
	if (!line || !line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (!message || message.protocolVersion !== PROTOCOL_VERSION) return;
	if (message.kind === 'ready') {
		windowReady = true;
		const waiters = readyWaiters;
		readyWaiters = [];
		for (const resolve of waiters) resolve(true);
		return;
	}
	// The window process reports a startup failure it knows about itself (the
	// renderer crashed, the file would not load). Recording it here is what turns
	// "no window appeared" into a message the browser half can show.
	if (message.kind === 'error') {
		const detail = typeof message.detail === 'string' && message.detail !== '' ? message.detail : 'window failed';
		windowStderr.push(detail);
		if (windowStderr.length > 8) windowStderr.shift();
		windowMessages.push('error:' + detail.slice(0, 80));
		if (windowMessages.length > 20) windowMessages.shift();
		windowReady = false;
		settleReady(false);
		return;
	}
	if (message.kind === 'pong') return;
	if (message.kind === 'closed') {
		windowMessages.push('closed');
		if (windowMessages.length > 20) windowMessages.shift();
		windowReady = false;
		return;
	}
	if (message.kind === 'open' || message.kind === 'command' || message.kind === 'children' || message.kind === 'opacity') {
		const label = acceptWindowReport(message.kind, message);
		if (label !== '') {
			windowMessages.push(label);
			if (windowMessages.length > 20) windowMessages.shift();
		}
	}
}

/** Resolve every readiness waiter with the given outcome. */
function settleReady(value) {
	if (readyWaiters.length === 0) return;
	const waiters = readyWaiters;
	readyWaiters = [];
	for (const resolve of waiters) resolve(value);
}

/** Wait for the readiness handshake, bounded by the caller's patience. */
function waitForReady(timeoutMs) {
	if (windowReady) return Promise.resolve(true);
	return new Promise((resolve) => {
		readyWaiters.push(resolve);
		const timer = setTimeout(() => {
			readyWaiters = readyWaiters.filter((waiter) => waiter !== resolve);
			resolve(false);
		}, timeoutMs);
		timer.unref?.();
	});
}

/** One report for the browser half's diagnostics and path choice. */
function environmentReport() {
	const desktop = typeof process.versions.electron === 'string';
	const windowMode = windowModeFor();
	return {
		ok: true,
		desktop,
		electronRuntime: desktop ? process.versions.electron : null,
		platform: process.platform,
		// Kept for compatibility with an installed browser half that still reads
		// it: the WPF window is gone, so this is no longer the gate for anything.
		powershell: false,
		// The raise path does not need PowerShell at all: it relaunches the
		// shell and lets Electron restore/show/focus.
		raise: desktop ? 'electron' : 'none',
		// How the detached window is produced: a real Electron window (the same
		// shell executable booted against our own `resources/app`), or nothing on
		// a non-Windows host.
		window: windowMode,
		open: windowReady,
		windowMessages: windowMessages.slice(-8),
		reason: windowMode === 'electron' ? '' : windowUnavailableReason(),
	};
}

/**
 * How the detached window would be produced on this host.
 * @returns `'electron'` when the shell's Electron executable is available.
 */
function windowModeFor() {
	if (process.platform !== 'win32') return 'none';
	if (typeof process.versions.electron !== 'string') return 'none';
	return existsSync(process.execPath) ? 'electron' : 'none';
}

/** Why no window can be produced, in the words the browser half shows. */
function windowUnavailableReason() {
	if (process.platform !== 'win32') return 'native window is Windows-only';
	if (typeof process.versions.electron !== 'string') return 'not the desktop shell';
	return 'the desktop shell executable was not found';
}

/** Writable scratch path for the mirrored Electron runtime. */
function windowWorkDirectoryPath() {
	if (windowWorkDirectory === null) {
		windowWorkDirectory = mkdtempSync(join(tmpdir(), 'sm-window-'));
	}
	return windowWorkDirectory;
}

/**
 * The language the window's labels use, as reported by the browser half.
 *
 * `reported` is `ctx.locale.getLocale().active`, and it is the ONLY authoritative
 * source: the desktop shell exports no locale environment variable (measured —
 * both `DSH_LOCALE` and `LANG` are empty on Windows), so guessing from
 * `process.env` silently produced an English window for a Chinese user. Until
 * the browser half reports, the OS locale is the best available guess.
 *
 * @param reported - the language id the browser half sent, if any.
 * @returns `zh` or `en`.
 */
function windowLanguage(reported) {
	const raw = String(reported || process.env.DSH_LOCALE || '').toLowerCase();
	// Locale ids look like `zh`, `zh-CN`, `zh-Hans`; anything else is not ours.
	return raw.startsWith('zh') ? 'zh' : 'en';
}

/**
 * Write the flat string table the window's renderer consumes.
 *
 * The browser half's dictionary is nested in its own module and cannot be
 * imported here (it is a browser module), so the window gets the same locale
 * JSON the package ships. Failures are not fatal: the window ships English
 * fallbacks of its own.
 *
 * EVERY visible label the window can draw belongs here. Leaving one out does not
 * fail loudly — it silently falls back to a hardcoded English string, which is
 * how a Chinese panel ended up with English window-control tooltips.
 *
 * @param directory - the mirror's app directory.
 * @param language - `zh` or `en`.
 * @returns the file path, or an empty string.
 */
function writeWindowStrings(directory, language) {
	try {
		const source = JSON.parse(readFileSync(fileURLToPath(new URL(`../locale/${language}.json`, import.meta.url)), 'utf8'));
		const pick = (key, fallback) => (typeof source[key] === 'string' ? source[key] : fallback);
		const strings = {
			title: pick('pip.title', 'Sessions'),
			hint: pick('pip.hint', 'Click a session to open it'),
			filterActive: pick('panel.filterActive', 'Active'),
			filterAll: pick('panel.filterAll', 'All'),
			filterActiveTip: pick('panel.filterActiveTip', 'Showing active sessions only; click for all'),
			filterAllTip: pick('panel.filterAllTip', 'Showing all sessions; click for active only'),
			notifyOn: pick('panel.notifyOn', 'Notify'),
			notifyOff: pick('panel.notifyOff', 'Muted'),
			empty: pick('panel.emptyActive', 'No active sessions'),
			emptyAll: pick('panel.empty', 'No sessions'),
			opacityTip: pick('panel.opacityTip', 'Panel opacity'),
			collapseChildren: pick('panel.collapseChildren', 'Collapse sub-agents'),
			expandChildren: pick('panel.expandChildren', 'Expand sub-agents'),
			minimize: pick('window.minimize', 'Minimize'),
			maximize: pick('window.maximize', 'Maximize'),
			restore: pick('window.restore', 'Restore'),
			close: pick('window.close', 'Close'),
			running: pick('state.running', 'Running'),
			attention: pick('state.attention', 'Needs you'),
			done: pick('state.done', 'Done'),
			idle: pick('state.idle', 'Idle'),
		};
		const target = join(directory, 'strings.json');
		writeFileSync(target, JSON.stringify(strings, null, 2));
		return target;
	} catch {
		return '';
	}
}

/**
 * Spawn the always-on-top Electron window and wait for its readiness handshake.
 *
 * The window is a real `BrowserWindow` in a real Electron main process: the
 * shell's own executable is relaunched against a mirrored runtime directory
 * whose `resources/app` is this plugin's window program (see
 * `lib/window-runtime.js`). That is the only way a plain-Node Host can obtain
 * Electron's own window API — the Host has no `require('electron')`.
 *
 * `ELECTRON_RUN_AS_NODE` is deleted for the child; inheriting it would make the
 * window process run as Node and never create a window.
 *
 * @param origin - the loopback origin the window must poll.
 * @returns `{ ok, open, mode }` or a refusal that explains itself.
 */
async function openWindow(origin, language) {
	if (windowChild && windowReady) return { ok: true, open: true, mode: 'electron' };
	if (windowChild) {
		// A previous attempt is still starting: reuse its handshake.
		const ready = await waitForReady(READY_TIMEOUT_MS);
		if (ready) return { ok: true, open: true, mode: 'electron' };
		closeWindow();
	}
	if (windowModeFor() !== 'electron') {
		return { ok: false, open: false, error: 'native window unavailable: ' + windowUnavailableReason() };
	}

	const prepared = prepareWindowRuntime({
		execPath: process.execPath,
		windowDirectory: fileURLToPath(new URL('./window', import.meta.url)),
		workDirectory: windowWorkDirectoryPath(),
	});
	if (!prepared.ok) return { ok: false, open: false, error: prepared.error };
	windowUserData = prepared.userData;
	const stringsPath = writeWindowStrings(prepared.appDirectory, windowLanguage(language));

	// The window's whole configuration goes in one file. Anything app-specific
	// on the command line would be parsed by Chromium first — a bare `--origin`
	// makes it refuse to load the page at all (measured).
	try {
		writeFileSync(
			prepared.configPath,
			JSON.stringify(
				{
					origin: String(origin || ''),
					statePath: STATE_PATH,
					pendingPath: `${ROUTE}/pending`,
					consumePath: `${ROUTE}/consume`,
					commandPath: COMMAND_PATH,
					openPath: OPEN_PATH,
					prefs: join(prepared.userData, 'window-prefs.json'),
					...(stringsPath === '' ? {} : { strings: stringsPath }),
				},
				null,
				2,
			),
		);
	} catch (error) {
		return { ok: false, open: false, error: 'write the window configuration: ' + String((error && error.message) || error) };
	}

	windowStderr.length = 0;
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_NO_ATTACH_CONSOLE;

	let child;
	try {
		child = spawn(
			prepared.executable,
			[
				// A per-window profile: without it Electron would open the REAL app's
				// profile directory and fight over its Chromium cache locks.
				`--user-data-dir=${prepared.userData}`,
				// Everything else travels in this file: Chromium claims a bare
				// `--origin` as its own switch, and the page then fails to load
				// (measured), so nothing app-specific may appear on this command
				// line.
				'--',
				'--config',
				prepared.configPath,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env },
		);
	} catch (error) {
		return { ok: false, open: false, error: 'launch the window runtime: ' + String((error && error.message) || error) };
	}
	windowChild = child;
	windowReady = false;
	child.stdin?.on('error', () => {});
	child.stdout?.on('error', () => {});
	child.stderr?.on('error', () => {});
	createInterface({ input: child.stdout }).on('line', handleWindowLine);
	createInterface({ input: child.stderr }).on('line', (line) => {
		const text = String(line || '').trim();
		if (!text) return;
		windowStderr.push(text);
		if (windowStderr.length > 8) windowStderr.shift();
	});
	child.on('error', (error) => {
		if (windowChild === child) {
			windowChild = null;
			windowReady = false;
		}
		windowStderr.push(String((error && error.message) || error));
		settleReady(false);
	});
	child.on('exit', () => {
		if (windowChild === child) {
			windowChild = null;
			windowReady = false;
		}
		settleReady(false);
	});

	const ready = await waitForReady(READY_TIMEOUT_MS);
	if (!ready) {
		const detail = windowStderr.length > 0 ? windowStderr.join(' | ') : 'no readiness handshake';
		closeWindow();
		return { ok: false, open: false, error: 'window did not start: ' + detail };
	}
	return { ok: true, open: true, mode: 'electron' };
}

/** Close the detached window, however it is still alive. */
function closeWindow() {
	const child = windowChild;
	windowChild = null;
	windowReady = false;
	settleReady(false);
	if (child && child.pid) {
		try {
			// Give the window process a moment to release the mirrored executable
			// before the scratch directory is removed: on Windows a running image
			// cannot be deleted, and a half-deleted mirror would fail the next open
			// in a confusing way. `removeWindowRuntime` retries and is best effort.
			const exited = new Promise((resolve) => {
				child.once('exit', () => resolve(true));
				setTimeout(() => resolve(false), 3000).unref?.();
			});
			spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
			exited.then(() => {
				removeWindowRuntime(windowWorkDirectory);
				windowWorkDirectory = null;
				windowUserData = null;
			});
		} catch {}
	}
}

// --- the app window ---------------------------------------------------------------

/**
 * Ask the desktop shell to bring its own primary window forward.
 *
 * This file deliberately contains NO window-management syscalls. The process
 * that owns the window is the Electron main process; it already implements the
 * correct sequence with Electron's own API
 * (`if (window.isMinimized()) window.restore(); window.show(); window.focus();`)
 * and runs it for every later launch of the app (its `second-instance` handler)
 * and for the `dsh://open` deep link. The Host is a plain Node child of that
 * process, so it cannot call `BrowserWindow` itself — but it CAN relaunch the
 * shell's own executable, which is exactly the user-visible gesture "open the
 * app again". The running instance takes the lock, the new process exits, and
 * the running instance raises itself with Electron's API.
 *
 * Why this replaced a Win32 helper: calling `ShowWindow`/`SetForegroundWindow`
 * from a foreign process fights the Windows foreground lock and re-asserts the
 * frame and z-order. That is what users saw as a flicker, and when the lock
 * refused the call the window stayed behind — the "clicked, nothing happened"
 * report. Electron's path runs inside the foreground-capable process, so it
 * needs none of that.
 *
 * `ELECTRON_RUN_AS_NODE` MUST be removed for the child: the Host itself runs
 * with that variable set (that is how the shell starts it), and inheriting it
 * would make the child run a Node script instead of starting the app.
 *
 * @param options - test seams; production passes nothing.
 * @returns a JSON-safe outcome. `ok` means the shell ACCEPTED the raise request
 *   and performed the window operation itself; this process cannot observe the
 *   resulting window state, so no foreground claim is made here.
 */
export function raiseAppWindow(options = {}) {
	const platform = options.platform ?? process.platform;
	const execPath = options.execPath ?? process.execPath;
	const electronVersion = options.electronVersion ?? (process.versions && process.versions.electron);
	const baseEnv = options.env ?? process.env;
	const launch = options.spawn ?? spawn;
	const timeoutMs = options.timeoutMs ?? RAISE_TIMEOUT_MS;
	const url = options.url ?? RAISE_URL;

	if (typeof electronVersion !== 'string' || electronVersion === '') {
		// A web profile runs this Host under plain Node: there is no Electron
		// window to raise, and the browser half's `window.focus()` is all there is.
		return Promise.resolve({ ok: false, action: 'none', reason: 'not the desktop shell (no Electron runtime)' });
	}
	if (platform !== 'win32') {
		// The shell's relaunch-to-raise path is the Windows one: a second launch
		// carries the deep link in argv and lands in `second-instance`. macOS
		// delivers deep links through LaunchServices instead, which this plugin
		// has no verified path for; saying so is better than a silent no-op.
		return Promise.resolve({ ok: false, action: 'none', reason: 'raising the app window through the shell is Windows-only' });
	}
	if (typeof execPath !== 'string' || execPath === '') {
		return Promise.resolve({ ok: false, action: 'none', reason: 'the shell executable path is unknown' });
	}

	const env = { ...baseEnv };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_NO_ATTACH_CONSOLE;

	return new Promise((resolve) => {
		let child;
		try {
			// The child is deliberately NOT unref'd: its exit is the answer
			// this promise reports, and an unref'd handle lets Node drop the
			// loop (and the exit event with it) before that answer arrives.
			// The launcher is short-lived — it hands off and quits at once.
			child = launch(execPath, [url], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
		} catch (error) {
			resolve({ ok: false, action: 'none', reason: 'launch the shell: ' + String((error && error.message) || error) });
			return;
		}
		let stderr = '';
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			// Do NOT kill the child on timeout. Two cases reach here:
			//  - the running instance never answered (rare), or
			//  - there was no running instance and this launch BECAME the app
			//    (possible only if the app died between the click and the
			//    launch). Killing it would close the window the user just asked
			//    for, so the process is left alone and the outcome is honest:
			//    the hand-off did not complete.
			finish({ ok: false, action: 'none', reason: 'the shell did not hand off the raise request in time' });
		}, timeoutMs);
		timer.unref?.();

		child.stderr?.on('data', (chunk) => {
			// Electron logs the usual cache/channel noise on a normal launch, so
			// stderr is only quoted when the launcher actually fails.
			if (stderr.length < 4096) stderr += chunk;
		});
		child.stderr?.on('error', () => {});
		child.on('error', (error) => {
			finish({ ok: false, action: 'none', reason: 'launch the shell: ' + String((error && error.message) || error) });
		});
		child.on('exit', (code, signal) => {
			if (code === 0) {
				// Exit 0 is the documented second-instance path: the running
				// instance took the single-instance lock, the new process quit.
				finish({ ok: true, action: 'electron:restore-show-focus', delivered: true, platform, url });
				return;
			}
			const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
			finish({
				ok: false,
				action: 'none',
				reason: 'the shell launcher exited with ' + String(code === null ? signal || 'no status' : code) + (detail === '' ? '' : ': ' + detail.slice(0, 300)),
			});
		});
	});
}

// --- routes ---------------------------------------------------------------------

/**
 * Host plugin body: register the window-control routes once the webServer is
 * composed. `ctx.inject` waits for the service instead of reading it at
 * effect time, when the base layer has not published it yet.
 * @param ctx - host root context.
 */
export function apply(ctx) {
	ctx.inject(['webServer'], (hostCtx) => {
		hostCtx.effect(() => {
			const webServer = hostCtx.get('webServer');
			if (!webServer || typeof webServer.register !== 'function') return;
			const disposers = [];
			const register = (path, handler) => {
				disposers.push(webServer.register({ kind: 'exact', path, handler }));
			};
			const sendJson = (response, code, payload) => {
				// The charset is load-bearing: Windows PowerShell 5.1's
				// Invoke-WebRequest decodes a charset-less JSON body as
				// Latin-1, which turned every Chinese session title in the
				// window into mojibake.
				response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				response.end(JSON.stringify(payload));
			};

			register(`${ROUTE}/probe`, (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				sendJson(response, 200, environmentReport());
			});

			// Clicking a session row switches the conversation in the browser half
			// and then asks for this: the app window comes back from minimized (or
			// from behind another window). It is deliberately its own route, so the
			// browser half owns navigation and this owns only the window.
			register(FOCUS_PATH, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					await readJsonBody(request);
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
				// One raise at a time. A second click while the shell is still
				// taking the hand-off must not stack launcher processes; the
				// first request already raises the same window.
				if (raiseFlight !== null) {
					return sendJson(response, 200, { ok: false, action: 'none', busy: true, reason: 'a raise request is already in flight' });
				}
				try {
					raiseFlight = raiseAppWindow();
					const result = await raiseFlight;
					return sendJson(response, 200, result);
				} catch (error) {
					return sendJson(response, 200, { ok: false, action: 'none', reason: String((error && error.message) || error) });
				} finally {
					raiseFlight = null;
				}
			});

			register(WINDOW_PATH, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					if (body.action === 'close') {
						closeWindow();
						return sendJson(response, 200, { ok: true, open: false });
					}
					if (body.state) windowState = normalizeState(body.state);
					// The browser half knows the ACTIVE language (`ctx.locale`);
					// this Node half does not, and the shell exports no locale
					// environment variable. Without this the window fell back to
					// English for a Chinese user.
					if (typeof body.language === 'string' && body.language !== '') windowLanguageTag = body.language;
					const origin = resolveWindowOrigin(request, body.origin);
					if (origin === '') {
						return sendJson(response, 200, { ok: false, open: false, error: 'no reachable origin for the window' });
					}
					const result = await openWindow(origin, windowLanguageTag);
					return sendJson(response, 200, result);
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			register(STATE_PATH, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method === 'GET') {
					return sendJson(response, 200, { ok: true, ...windowState, open: windowReady });
				}
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'GET, POST' });
				try {
					const body = await readJsonBody(request);
					if (body.state) windowState = normalizeState(body.state);
					return sendJson(response, 200, { ok: true });
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			// The window's own header buttons post here as well as writing their
			// stdout `command` line. The browser half owns both settings and
			// drains this queue, so the window only ever asks.
			//
			// This goes through the same funnel as the stdout line, so the two
			// deliveries of ONE press become ONE event. Queuing both would apply
			// a toggle twice and cancel it out.
			register(COMMAND_PATH, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					const action = typeof body.action === 'string' ? body.action : '';
					let queued = false;
					if (action === 'toggle-children') {
						queued = acceptWindowReport('children', body) !== '';
					} else if (action === 'set-opacity') {
						queued = acceptWindowReport('opacity', body) !== '';
					} else {
						queued = acceptWindowReport('command', body) !== '';
					}
					windowMessages.push('http-command:' + action + (queued ? '' : '(dup)'));
					if (windowMessages.length > 20) windowMessages.shift();
					return sendJson(response, 200, { ok: true, queued });
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			register(`${ROUTE}/pending`, (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				sendJson(response, 200, {
					ok: true,
					items: pendingOpens.slice(),
					commands: pendingCommands.slice(),
					children: pendingChildren.slice(),
					opacity: pendingOpacity,
					open: windowReady,
				});
			});

			// The window's click handler posts here as well as writing its
			// stdout `open` line: two independent transports, because a click
			// that silently goes nowhere is the worst failure mode this plugin
			// has had. Both funnel into one report, so the pair is not queued
			// pairwise either.
			register(`${ROUTE}/open`, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					const id = typeof body.id === 'string' ? body.id : '';
					const queued = acceptWindowReport('open', body) !== '';
					windowMessages.push('http-open:' + id + (queued ? '' : '(dup)'));
					if (windowMessages.length > 20) windowMessages.shift();
					return sendJson(response, 200, { ok: true, queued: queued && id !== '' });
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			register(`${ROUTE}/consume`, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
					for (let index = pendingOpens.length - 1; index >= 0; index -= 1) {
						if (ids.includes(pendingOpens[index])) pendingOpens.splice(index, 1);
					}
					const actions = Array.isArray(body.commands) ? body.commands.filter((action) => typeof action === 'string') : [];
					for (let index = pendingCommands.length - 1; index >= 0; index -= 1) {
						if (actions.includes(pendingCommands[index])) pendingCommands.splice(index, 1);
					}
					const children = Array.isArray(body.children) ? body.children.filter((id) => typeof id === 'string') : [];
					for (let index = pendingChildren.length - 1; index >= 0; index -= 1) {
						if (children.includes(pendingChildren[index])) pendingChildren.splice(index, 1);
					}
					// The alpha is a single latest-wins value, not a queue: a slider
					// drag produces many updates and only the last one matters.
					if (body.opacity === true) pendingOpacity = null;
					return sendJson(response, 200, { ok: true });
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			return () => {
				for (const dispose of disposers) {
					try {
						dispose();
					} catch {}
				}
				closeWindow();
			};
		}, 'session-monitor: window routes');
	});
}
