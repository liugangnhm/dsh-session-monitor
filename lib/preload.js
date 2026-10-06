/**
 * dsh-session-monitor, detached-window preload.
 *
 * Runs inside the host-created always-on-top BrowserWindow. The window has no
 * served page: this preload builds the whole UI on the about:blank document,
 * renders the session snapshot the Host pushes over the `sm:state` channel,
 * and routes row clicks through `sm:open` into the Host's open queue (drained
 * by the browser half, which owns the app navigation).
 *
 * The labels are a small local dictionary rather than the plugin's locale
 * namespace: a preload is a separate module context that cannot ride the
 * browser half's translation seat.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const TEXTS = navigator.language && navigator.language.toLowerCase().startsWith("en")
	? {
			title: "DSH Sessions",
			empty: "No active sessions",
			hint: "Click a session to open · always on top",
			states: { running: "Running", attention: "Needs you", done: "Done", idle: "Idle" },
		}
	: {
			title: "DSH 会话监控",
			empty: "暂无活跃会话",
			hint: "点击会话跳转 · 窗口始终置顶",
			states: { running: "运行中", attention: "待处理", done: "已完成", idle: "空闲" },
		};

const CSS = `
html,body{margin:0;height:100%}
body{background:#202124;color:#e8eaed;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
.sm-pip{display:flex;flex-direction:column;height:100vh;box-sizing:border-box;border:1px solid #3c4043}
.sm-pip-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #3c4043;-webkit-app-region:drag;user-select:none}
.sm-pip-title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-pip-close{appearance:none;-webkit-app-region:no-drag;border:1px solid #3c4043;background:transparent;color:inherit;border-radius:6px;height:22px;width:26px;font-size:13px;line-height:1;cursor:pointer}
.sm-pip-close:hover{background:#292a2d}
.sm-pip-list{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:2px}
.sm-pip-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;border-radius:6px;padding:8px;color:inherit;font:inherit;cursor:pointer}
.sm-pip-row:hover{background:#292a2d}
.sm-pip-row-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-pip-row-state{flex:none;font-size:11px}
.sm-pip-row.blank .sm-pip-row-title{color:#9aa0a6}
.sm-pip-empty{padding:16px 8px;color:#9aa0a6;text-align:center}
.sm-pip-hint{padding:6px 10px;border-top:1px solid #3c4043;color:#9aa0a6;font-size:11px}
.sm-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.sm-dot-running{background:#8ab4f8}
.sm-dot-attention{background:#fdd663}
.sm-dot-done{background:#81c995}
.sm-dot-idle{background:#9aa0a6}
.sm-live{position:relative;display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;background:#8ab4f8;animation:sm-breathe 1.2s ease-in-out infinite}
.sm-live::before,.sm-live::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid #8ab4f8;animation:sm-ripple 1.2s ease-out infinite}
.sm-live::after{animation-delay:.6s}
@keyframes sm-breathe{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.16);opacity:.85}}
@keyframes sm-ripple{0%{transform:scale(.7);opacity:.9}70%{transform:scale(2.2);opacity:0}100%{transform:scale(2.2);opacity:0}}
`;

const stateTones = {
	running: "#8ab4f8",
	attention: "#fdd663",
	done: "#81c995",
	idle: "#9aa0a6",
};

contextBridge.exposeInMainWorld("smHost", {
	open: (id) => ipcRenderer.invoke("sm:open", id),
	close: () => ipcRenderer.invoke("sm:close"),
	onState: (callback) => {
		const listener = (_event, state) => callback(state);
		ipcRenderer.on("sm:state", listener);
		return () => ipcRenderer.removeListener("sm:state", listener);
	},
});

(function build() {
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.appendChild(style);
	document.body.innerHTML =
		'<div class="sm-pip"><div class="sm-pip-head"><span class="sm-pip-title"></span><button class="sm-pip-close" type="button" title="×">×</button></div><div class="sm-pip-list"></div><div class="sm-pip-hint"></div></div>';
	document.querySelector(".sm-pip-hint").textContent = TEXTS.hint;
	document.querySelector(".sm-pip-close").addEventListener("click", () => {
		try {
			window.smHost.close();
		} catch {}
	});
	window.smHost.onState(render);
	ipcRenderer.invoke("sm:get-state").then(render, () => {});
})();

/** Repaint the list from one Host snapshot. */
function render(state) {
	const doc = document;
	const snapshot = state && typeof state === "object" ? state : { rows: [] };
	const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
	const title = doc.querySelector(".sm-pip-title");
	if (title) title.textContent = TEXTS.title + " · " + rows.length;
	const list = doc.querySelector(".sm-pip-list");
	if (!list) return;
	list.textContent = "";
	if (rows.length === 0) {
		const empty = doc.createElement("div");
		empty.className = "sm-pip-empty";
		empty.textContent = TEXTS.empty;
		list.appendChild(empty);
		return;
	}
	for (const row of rows) {
		const item = doc.createElement("button");
		item.type = "button";
		item.className = "sm-pip-row" + (row.blank ? " blank" : "");
		item.title = row.title;
		const dot = doc.createElement("span");
		dot.className = row.state === "running" ? "sm-live" : "sm-dot sm-dot-" + (stateTones[row.state] ? row.state : "idle");
		const label = doc.createElement("span");
		label.className = "sm-pip-row-title";
		label.textContent = row.title;
		const stateLabel = doc.createElement("span");
		stateLabel.className = "sm-pip-row-state";
		stateLabel.textContent = TEXTS.states[row.state] || TEXTS.states.idle;
		stateLabel.style.color = stateTones[row.state] || stateTones.idle;
		item.appendChild(dot);
		item.appendChild(label);
		item.appendChild(stateLabel);
		item.addEventListener("click", () => {
			try {
				window.smHost.open(row.id);
			} catch {}
		});
		list.appendChild(item);
	}
}
