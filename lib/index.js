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
 * 2. The native detached window. The browser half runs inside a sandboxed
 *    iframe in the desktop app, where Document Picture-in-Picture fails
 *    ("Internal error: no window") and `window.open` is blocked. This Host,
 *    however, runs inside the Electron main process (the desktop host's own
 *    entry), so it can create a real always-on-top `BrowserWindow`. The
 *    window's page is built by `./preload.js` and driven over IPC; the
 *    browser half pushes its session snapshot over a loopback HTTP route and
 *    polls the queue of "open this session" requests the window raises.
 *
 * Everything degrades: no Electron (web profile) → the routes answer
 * `ok:false` and the browser half falls back to PiP → popup → in-app panel.
 *
 * @module dsh-session-monitor
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Cordis function-plugin name. */
export const name = 'session-monitor';

const require = createRequire(import.meta.url);

/** Loopback routes under one prefix. */
const ROUTE = '/dsh-session-monitor';

/** Only loopback callers may use these routes; they expose host internals. */
function isLocalRequest(request) {
	const host = String((request && request.headers && request.headers.host) || '');
	return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host.startsWith('[::1]:');
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
		totalCount: typeof (state && state.totalCount) === 'number' ? state.totalCount : rows.length,
	};
}

// --- the native window ----------------------------------------------------------

let electronModule = null;
let electronReason = 'not probed';

/** The Electron API when this Host runs inside the main process, else null. */
function electronApi() {
	if (electronModule === null && electronReason === 'not probed') {
		try {
			const mod = require('electron');
			if (mod && typeof mod === 'object' && mod.app && mod.BrowserWindow && mod.ipcMain) {
				electronModule = mod;
			} else if (typeof mod === 'string') {
				electronReason = 'plain Node host (require("electron") resolved to a path)';
			} else {
				electronReason = 'require("electron") exposed no API';
			}
		} catch (error) {
			electronReason = String((error && error.message) || error);
		}
	}
	return electronModule;
}

/** One report for the browser half's diagnostics. */
function environmentReport() {
	const api = electronApi();
	return {
		ok: true,
		electron: api !== null,
		electronRuntime: typeof process.versions.electron === 'string' ? process.versions.electron : null,
		reason: api !== null ? '' : electronReason,
		platform: process.platform,
	};
}

let hostWindow = null;
let ipcWired = false;
let windowState = { rows: [], runningCount: 0, showAll: false, totalCount: 0 };
/** Session ids the window asked to open, drained by the browser half. */
const pendingOpens = [];

/** Push the current snapshot into the window's page. */
function pushState() {
	if (hostWindow && !hostWindow.isDestroyed()) {
		try {
			hostWindow.webContents.send('sm:state', windowState);
		} catch {}
	}
}

/** Wire the window's IPC once per Host life. */
function wireIpc(electron) {
	if (ipcWired) return;
	ipcWired = true;
	electron.ipcMain.handle('sm:get-state', () => windowState);
	electron.ipcMain.handle('sm:open', (_event, id) => {
		if (typeof id === 'string' && id !== '') pendingOpens.push(id);
		return { ok: true };
	});
	electron.ipcMain.handle('sm:close', () => {
		closeHostWindow();
		return { ok: true };
	});
}

/** Create (or reveal) the always-on-top detached window. */
function openHostWindow() {
	const electron = electronApi();
	if (!electron) return { ok: false, open: false, error: 'electron unavailable: ' + electronReason };
	if (hostWindow && !hostWindow.isDestroyed()) {
		hostWindow.show();
		hostWindow.focus();
		return { ok: true, open: true };
	}
	let preload;
	try {
		preload = fileURLToPath(new URL('./preload.js', import.meta.url));
	} catch (error) {
		return { ok: false, open: false, error: 'preload path: ' + String((error && error.message) || error) };
	}
	let created;
	try {
		created = new electron.BrowserWindow({
			width: 340,
			height: 480,
			frame: false,
			alwaysOnTop: true,
			skipTaskbar: true,
			resizable: true,
			show: false,
			webPreferences: {
				preload,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
			},
		});
	} catch (error) {
		return { ok: false, open: false, error: 'BrowserWindow: ' + String((error && error.message) || error) };
	}
	hostWindow = created;
	wireIpc(electron);
	hostWindow.on('closed', () => {
		hostWindow = null;
	});
	created.setAlwaysOnTop(true, 'floating');
	created.loadURL('about:blank').then(
		() => {
			created.show();
			pushState();
		},
		() => {},
	);
	return { ok: true, open: true };
}

/** Close the detached window if it is open. */
function closeHostWindow() {
	if (hostWindow && !hostWindow.isDestroyed()) {
		try {
			hostWindow.close();
		} catch {}
	}
	hostWindow = null;
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
				response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
				response.end(JSON.stringify(payload));
			};

			register(`${ROUTE}/probe`, (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				sendJson(response, 200, environmentReport());
			});

			register(`${ROUTE}/window`, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					if (body.action === 'close') {
						closeHostWindow();
						return sendJson(response, 200, { ok: true, open: false });
					}
					if (body.state) windowState = normalizeState(body.state);
					const result = openHostWindow();
					if (result.ok) pushState();
					return sendJson(response, 200, result);
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			register(`${ROUTE}/state`, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					if (body.state) {
						windowState = normalizeState(body.state);
						pushState();
					}
					return sendJson(response, 200, { ok: true });
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			register(`${ROUTE}/pending`, (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				sendJson(response, 200, { ok: true, items: pendingOpens.slice() });
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
				closeHostWindow();
			};
		}, 'session-monitor: window routes');
	});
}
