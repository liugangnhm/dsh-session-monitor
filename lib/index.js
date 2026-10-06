/**
 * dsh-session-monitor, node half.
 *
 * Hosting carrier plus one diagnostic route: the empty `apply` exists so the
 * plugin appears in the host cordis.yml / Loader tree, and the browser half
 * ships via `exports["./client"]`, discovered through this package's
 * `package.json` `dsh.client` declaration by `@deepseek-ai/dsh-client-modules`.
 *
 * The route `GET /dsh-session-monitor/probe` answers one question the browser
 * half cannot answer on its own: whether this Host process is the Electron
 * main process (where a native always-on-top window could be created later)
 * or a plain Node process (where only browser-level windows exist). The
 * detached window itself is Document Picture-in-Picture with a `window.open`
 * fallback, both owned by the browser half, so no window lives here.
 *
 * @module dsh-session-monitor
 */

import { createRequire } from 'node:module';

/** Cordis function-plugin name. */
export const name = 'session-monitor';

const require = createRequire(import.meta.url);

/** Only loopback callers may read the probe; it exposes host internals. */
function isLocalRequest(request) {
	const host = String((request && request.headers && request.headers.host) || '');
	return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host.startsWith('[::1]:');
}

/** Report how this Host process could ever create a native window. */
function probeHost() {
	const info = {
		ok: true,
		platform: process.platform,
		electronRuntime: typeof process.versions.electron === 'string' ? process.versions.electron : null,
		electronApi: false,
		reason: '',
	};
	try {
		const mod = require('electron');
		if (mod && typeof mod === 'object' && mod.app && typeof mod.app.getVersion === 'function') {
			info.electronApi = true;
			try {
				info.electronVersion = String(mod.app.getVersion());
			} catch {}
		} else if (typeof mod === 'string') {
			info.reason = 'require("electron") resolved to a path (plain Node host)';
		} else {
			info.reason = 'require("electron") returned no app object';
		}
	} catch (error) {
		info.reason = String((error && error.message) || error);
	}
	return info;
}

/**
 * Host plugin body: register the loopback-only environment probe route the
 * browser half consults when every in-browser detached window fails.
 * @param ctx - host root context.
 */
export function apply(ctx) {
	ctx.effect(() => {
		const webServer = ctx.get && ctx.get('webServer');
		if (!webServer || typeof webServer.register !== 'function') return;
		const off = webServer.register({
			kind: 'exact',
			path: '/dsh-session-monitor/probe',
			handler: (request, response) => {
				if (!isLocalRequest(request)) {
					response.writeHead(403, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ ok: false, message: 'forbidden' }));
					return;
				}
				response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
				response.end(JSON.stringify(probeHost()));
			},
		});
		return () => {
			try {
				off();
			} catch {}
		};
	}, 'session-monitor: probe route');
}
