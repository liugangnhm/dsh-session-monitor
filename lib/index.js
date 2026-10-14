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
 * @module dsh-session-monitor
 */

import { spawn } from 'node:child_process';
import { existsSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Cordis function-plugin name. */
export const name = 'session-monitor';

/** Loopback routes under one prefix. */
const ROUTE = '/dsh-session-monitor';

/** Windows PowerShell, absolute (the path never moves on Windows). */
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Loopback endpoints the window talks to. */
const STATE_PATH = `${ROUTE}/state`;
const OPEN_PATH = `${ROUTE}/open`;
const COMMAND_PATH = `${ROUTE}/command`;
const WINDOW_PATH = `${ROUTE}/window`;
/** Restores and foregrounds the app window when a row is clicked. */
const FOCUS_PATH = `${ROUTE}/focus`;

/** Line protocol shared with the window script. */
const PROTOCOL_VERSION = 1;
/** How long a fresh window gets to report `ready` before it counts as failed. */
const READY_TIMEOUT_MS = 3000;
/** How long the focus helper gets before it counts as failed. */
const FOCUS_TIMEOUT_MS = 8000;
/** Actions the window's header buttons may request. */
const WINDOW_ACTIONS = new Set(['toggle-filter', 'toggle-notify']);

/** The window program, kept as a real file so it stays debuggable. */
const WINDOW_SCRIPT_PATH = fileURLToPath(new URL('./window.ps1', import.meta.url));
/** The app-window focus helper, one-shot per click. */
const FOCUS_SCRIPT_PATH = fileURLToPath(new URL('./focus.ps1', import.meta.url));

/** Windows PowerShell 5.1 needs `-STA` for WPF; the flag is harmless elsewhere. */
const POWERSHELL_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File'];
/** The focus helper builds no UI, so it needs no single-threaded apartment. */
const FOCUS_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

/**
 * Return a runnable PowerShell script path, with its UTF-8 BOM guaranteed.
 *
 * The shipped file is used as-is when it is intact. Two defences exist because
 * the script is useless without them: a UTF-8 BOM (5.1 reads a BOM-less .ps1 as
 * ANSI and mangles every non-ASCII label) and an installed location that may be
 * read-only. A repaired copy lands in `workDirectory`.
 *
 * @param workDirectory - a writable directory for the repaired copy.
 * @param sourcePath - the shipped script to run.
 * @param label - how the script is named in failure messages.
 * @returns the path to run, or a reason it cannot be run.
 */
function prepareScript(workDirectory, sourcePath, label) {
	let raw;
	try {
		raw = readFileSync(sourcePath);
	} catch (error) {
		return { ok: false, error: `${label} script unreadable: ${String((error && error.message) || error)}` };
	}
	const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
	if (hasBom) return { ok: true, path: sourcePath };
	const target = join(workDirectory, sourcePath.split(/[\\/]/).pop());
	try {
		copyFileSync(sourcePath, target);
		writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]));
	} catch (error) {
		return { ok: false, error: `${label} script repair failed: ${String((error && error.message) || error)}` };
	}
	return { ok: true, path: target };
}

/**
 * Return a runnable window script path.
 * @param workDirectory - a writable directory for the repaired copy.
 * @returns the path to run, or a reason it cannot be run.
 */
export function prepareWindowScript(workDirectory) {
	return prepareScript(workDirectory, WINDOW_SCRIPT_PATH, 'window');
}

/**
 * Return a runnable focus script path.
 * @param workDirectory - a writable directory for the repaired copy.
 * @returns the path to run, or a reason it cannot be run.
 */
export function prepareFocusScript(workDirectory) {
	return prepareScript(workDirectory, FOCUS_SCRIPT_PATH, 'focus');
}

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
/** Writable scratch directory for a repaired copy of the window script. */
let windowWorkDirectory = null;
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
/** The in-flight focus helper; at most one at a time. */
let focusChild = null;

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
	if (message.kind === 'pong') return;
	if (message.kind === 'open') {
		windowMessages.push('open:' + String(message.id));
		if (windowMessages.length > 20) windowMessages.shift();
		if (typeof message.id === 'string' && message.id !== '') pendingOpens.push(message.id);
		return;
	}
	if (message.kind === 'command') {
		const action = typeof message.action === 'string' ? message.action : '';
		windowMessages.push('command:' + action);
		if (windowMessages.length > 20) windowMessages.shift();
		if (WINDOW_ACTIONS.has(action)) pendingCommands.push(action);
		return;
	}
	if (message.kind === 'children') {
		// A parent's twisty: the window asks the browser half to flip that
		// parent, because the browser half owns the collapse set and persists it.
		const id = typeof message.id === 'string' ? message.id : '';
		windowMessages.push('children:' + id);
		if (windowMessages.length > 20) windowMessages.shift();
		if (id !== '') pendingChildren.push(id);
		return;
	}
	if (message.kind === 'opacity') {
		// The window's slider moved: the browser half owns the setting, so this
		// only records the request until the browser half drains it.
		const value = typeof message.value === 'number' ? message.value : Number.parseFloat(String(message.value));
		windowMessages.push('opacity:' + String(value));
		if (windowMessages.length > 20) windowMessages.shift();
		if (Number.isFinite(value)) pendingOpacity = Math.min(1, Math.max(0.2, value));
		return;
	}
	if (message.kind === 'closed') {
		windowMessages.push('closed');
		if (windowMessages.length > 20) windowMessages.shift();
		windowReady = false;
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
	const powershell = process.platform === 'win32' && existsSync(POWERSHELL);
	return {
		ok: true,
		desktop: typeof process.versions.electron === 'string',
		electronRuntime: typeof process.versions.electron === 'string' ? process.versions.electron : null,
		platform: process.platform,
		powershell,
		open: windowReady,
		windowMessages: windowMessages.slice(-8),
		reason: powershell ? '' : process.platform === 'win32' ? 'powershell not found' : 'native window is Windows-only',
	};
}

/** Writable scratch path for the window script's repaired copy. */
function windowWorkDirectoryPath() {
	if (windowWorkDirectory === null) {
		windowWorkDirectory = mkdtempSync(join(tmpdir(), 'sm-window-'));
	}
	return windowWorkDirectory;
}

/**
 * Spawn the always-on-top WPF window and wait for its readiness handshake.
 *
 * `detached` is deliberately absent: a detached PowerShell with no console of
 * its own exits before the WPF message loop starts (measured, exit code 0),
 * which is exactly the "spawn reported ok, no window appeared" failure.
 */
async function openWindow(origin) {
	if (windowChild && windowReady) return { ok: true, open: true, mode: 'powershell' };
	if (windowChild) {
		// A previous attempt is still starting: reuse its handshake.
		const ready = await waitForReady(READY_TIMEOUT_MS);
		if (ready) return { ok: true, open: true, mode: 'powershell' };
		closeWindow();
	}
	if (process.platform !== 'win32' || !existsSync(POWERSHELL)) {
		return { ok: false, open: false, error: 'native window unavailable: ' + environmentReport().reason };
	}
	const prepared = prepareWindowScript(windowWorkDirectoryPath());
	if (!prepared.ok) return { ok: false, open: false, error: prepared.error };
	windowStderr.length = 0;
	let child;
	try {
		child = spawn(
			POWERSHELL,
			[...POWERSHELL_ARGS, prepared.path, '-Origin', String(origin || ''), '-StatePath', STATE_PATH, '-OpenPath', OPEN_PATH, '-CommandPath', COMMAND_PATH],
			{ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
		);
	} catch (error) {
		return { ok: false, open: false, error: 'spawn powershell: ' + String((error && error.message) || error) };
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
	return { ok: true, open: true, mode: 'powershell' };
}

/** Close the detached window, however it is still alive. */
function closeWindow() {
	const child = windowChild;
	windowChild = null;
	windowReady = false;
	settleReady(false);
	if (child && child.pid) {
		try {
			spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
		} catch {}
	}
}

// --- the app window ---------------------------------------------------------------

/**
 * Restore and foreground the DSH app window by running the focus helper.
 *
 * The Host half cannot raise a window itself: it is a plain Node child process
 * with no window, and the browser half lives in a sandboxed iframe where
 * `window.focus()` cannot touch another OS window. So this spawns a short-lived
 * PowerShell helper that walks its own process ancestry to the app's main
 * process (whose child this Host is) and restores that window.
 *
 * Only one helper runs at a time: a second click while one is in flight is
 * reported as busy rather than stacking processes, and the process is killed if
 * it outlives its patience so a hung helper cannot accumulate.
 *
 * @param workDirectory - a writable directory for a repaired script copy.
 * @returns the helper's own JSON report, or a refusal that explains itself.
 */
function focusAppWindow(workDirectory) {
	if (process.platform !== 'win32' || !existsSync(POWERSHELL)) {
		return Promise.resolve({ ok: false, action: 'none', reason: environmentReport().reason });
	}
	if (focusChild !== null) {
		return Promise.resolve({ ok: false, action: 'none', reason: 'a focus request is already running' });
	}
	const prepared = prepareFocusScript(workDirectory);
	if (!prepared.ok) return Promise.resolve({ ok: false, action: 'none', reason: prepared.error });

	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(POWERSHELL, [...FOCUS_ARGS, prepared.path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		} catch (error) {
			resolve({ ok: false, action: 'none', reason: 'spawn powershell: ' + String((error && error.message) || error) });
			return;
		}
		focusChild = child;
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (focusChild === child) focusChild = null;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			try {
				spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
			} catch {}
			finish({ ok: false, action: 'none', reason: 'focus helper timed out' });
		}, FOCUS_TIMEOUT_MS);
		timer.unref?.();

		child.stdout?.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on('data', (chunk) => {
			stderr += chunk;
		});
		child.stdout?.on('error', () => {});
		child.stderr?.on('error', () => {});
		child.on('error', (error) => {
			finish({ ok: false, action: 'none', reason: String((error && error.message) || error) });
		});
		child.on('exit', () => {
			const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
			if (line === '') {
				finish({ ok: false, action: 'none', reason: stderr.trim() || 'focus helper said nothing' });
				return;
			}
			try {
				const parsed = JSON.parse(line);
				finish(parsed && typeof parsed === 'object' ? parsed : { ok: false, action: 'none', reason: 'unreadable focus report' });
			} catch {
				finish({ ok: false, action: 'none', reason: 'unreadable focus report: ' + line.slice(0, 200) });
			}
		});
	});
}

/**
 * Kill an in-flight focus helper, so unloading the plugin leaves no process.
 */
function closeFocusHelper() {
	const child = focusChild;
	focusChild = null;
	if (child && child.pid) {
		try {
			spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
		} catch {}
	}
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
				try {
					const result = await focusAppWindow(windowWorkDirectoryPath());
					return sendJson(response, 200, result);
				} catch (error) {
					return sendJson(response, 200, { ok: false, action: 'none', reason: String((error && error.message) || error) });
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
					const origin = resolveWindowOrigin(request, body.origin);
					if (origin === '') {
						return sendJson(response, 200, { ok: false, open: false, error: 'no reachable origin for the window' });
					}
					const result = await openWindow(origin);
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
			register(COMMAND_PATH, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					const action = typeof body.action === 'string' ? body.action : '';
					windowMessages.push('http-command:' + action);
					if (windowMessages.length > 20) windowMessages.shift();
					if (WINDOW_ACTIONS.has(action)) pendingCommands.push(action);
					// The window's twisty and slider post here too, so a window
					// whose stdout is unreadable (or whose click only produced an
					// HTTP call) still reaches the browser half.
					const childId = typeof body.id === 'string' ? body.id : '';
					if (action === 'toggle-children' && childId !== '') pendingChildren.push(childId);
					if (action === 'set-opacity') {
						const value = Number.parseFloat(String(body.value));
						if (Number.isFinite(value)) pendingOpacity = Math.min(1, Math.max(0.2, value));
					}
					const queued = WINDOW_ACTIONS.has(action) || (action === 'toggle-children' && childId !== '') || action === 'set-opacity';
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
			// has had.
			register(`${ROUTE}/open`, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					const id = typeof body.id === 'string' ? body.id : '';
					windowMessages.push('http-open:' + id);
					if (windowMessages.length > 20) windowMessages.shift();
					if (id !== '') pendingOpens.push(id);
					return sendJson(response, 200, { ok: true, queued: id !== '' });
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
				closeFocusHelper();
			};
		}, 'session-monitor: window routes');
	});
}
