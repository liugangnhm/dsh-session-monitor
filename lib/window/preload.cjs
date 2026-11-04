/**
 * The bridge between the monitor window's renderer and its main process.
 *
 * Deliberately tiny and capability-shaped: the renderer can ask for the six
 * window operations, report a click, and nothing else. It never gets `require`,
 * never gets Node, and never learns the Host's URL — the main process polls the
 * Host itself, so the renderer only ever sees data.
 *
 * @module dsh-session-monitor/window/preload
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitorWindow', {
	/**
	 * Subscribe to one channel from the main process.
	 * @param channel - `state` or `host-gone`.
	 * @param callback - invoked with the payload.
	 * @returns an unsubscribe function.
	 */
	subscribe(channel, callback) {
		if (typeof callback !== 'function') return () => {};
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on(channel, listener);
		return () => ipcRenderer.removeListener(channel, listener);
	},
	/** Minimize / maximize / close / hide / show / focus — all Electron API. */
	windowAction(action) {
		ipcRenderer.send('monitor:window', String(action || ''));
	},
	/** Open a session: the Host owns navigation. */
	openSession(id) {
		ipcRenderer.send('monitor:open', { id: String(id || '') });
	},
	/** Header toggles (`toggle-filter`, `toggle-notify`). */
	command(action) {
		ipcRenderer.send('monitor:command', String(action || ''));
	},
	/** Collapse/expand one parent's sub-agents. */
	toggleChildren(parentId) {
		ipcRenderer.send('monitor:children', String(parentId || ''));
	},
	/** Whole-window alpha; the main process applies it to the real window. */
	setOpacity(value) {
		ipcRenderer.send('monitor:opacity', Number(value));
	},
	/** The locale dictionary and the initial preferences. */
	bootstrap() {
		return ipcRenderer.sendSync('monitor:bootstrap');
	},
});
