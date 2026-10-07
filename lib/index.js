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

/** Line protocol shared with the window script. */
const PROTOCOL_VERSION = 1;
/** How long a fresh window gets to report `ready` before it counts as failed. */
const READY_TIMEOUT_MS = 3000;
/** Actions the window's header buttons may request. */
const WINDOW_ACTIONS = new Set(['toggle-filter', 'toggle-notify']);

/** The window program, kept as a real file so it stays debuggable. */
const WINDOW_SCRIPT_PATH = fileURLToPath(new URL('./window.ps1', import.meta.url));

/** Windows PowerShell 5.1 needs `-STA` for WPF; the flag is harmless elsewhere. */
const POWERSHELL_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File'];

/**
 * Return a runnable window script path.
 *
 * The shipped file is used as-is when it is intact. Two defences exist because
 * the script is useless without them: a UTF-8 BOM (5.1 reads a BOM-less .ps1 as
 * ANSI and mangles every non-ASCII label) and an installed location that may be
 * read-only. A repaired copy lands in `workDirectory`.
 *
 * @param workDirectory - a writable directory for the repaired copy.
 * @returns the path to run, or a reason it cannot be run.
 */
export function prepareWindowScript(workDirectory) {
	let raw;
	try {
		raw = readFileSync(WINDOW_SCRIPT_PATH);
	} catch (error) {
		return { ok: false, error: `window script unreadable: ${String((error && error.message) || error)}` };
	}
	const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
	if (hasBom) return { ok: true, path: WINDOW_SCRIPT_PATH };
	const target = join(workDirectory, 'window.ps1');
	try {
		copyFileSync(WINDOW_SCRIPT_PATH, target);
		writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]));
	} catch (error) {
		return { ok: false, error: `window script repair failed: ${String((error && error.message) || error)}` };
	}
	return { ok: true, path: target };
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
			}))
		: [];
	return {
		rows,
		runningCount: typeof (state && state.runningCount) === 'number' ? state.runningCount : 0,
		showAll: !!(state && state.showAll),
		notifyOn: !(state && state.notifyOn === false),
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
					return sendJson(response, 200, { ok: true, queued: WINDOW_ACTIONS.has(action) });
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			register(`${ROUTE}/pending`, (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				sendJson(response, 200, { ok: true, items: pendingOpens.slice(), commands: pendingCommands.slice(), open: windowReady });
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
