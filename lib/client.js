window.__ModuleLoader__.load({
	id: "dsh-session-monitor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const StateDot = primitives.StateDot;
		const Toast = primitives.Toast;
		const e = React.createElement;

		/** Dictionary namespace owned by this plugin; also the panel's `locale` seat. */
		const NS = "session-monitor";

		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"panel.title": "会话监控",
			"panel.count": "{n} 个会话",
			"panel.collapse": "收起",
			"panel.expand": "展开",
			"panel.detach": "外置",
			"panel.attach": "收回",
			"panel.notifyOn": "系统通知：开",
			"panel.notifyOff": "系统通知：关",
			"panel.filterActive": "活跃",
			"panel.filterAll": "全部",
			"panel.filterActiveTip": "当前仅显示活跃会话（运行中 / 待处理 / 未读完成），点击显示全部",
			"panel.filterAllTip": "当前显示全部会话（含空闲），点击仅显示活跃",
			"panel.empty": "暂无会话",
			"panel.emptyActive": "暂无活跃会话",
			"panel.opacity": "透明度",
			"panel.opacityTip": "只调整面板背景的透明度，文字与状态点保持清晰；设置会自动保存",
			"panel.collapseChildren": "收起子 agent",
			"panel.expandChildren": "展开子 agent",
			"state.running": "运行中",
			"state.attention": "待处理",
			"state.done": "已完成",
			"state.idle": "空闲",
			"state.blank": "新会话",
			"pip.title": "DSH 会话监控",
			"pip.hint": "点击会话跳转 · 窗口始终置顶",
			"pip.recall": "收回",
			"toast.detachPopup": "已打开独立窗口（普通窗口、不置顶；DSH 最小化时仍在）",
			"toast.detachNative": "已打开置顶独立窗口（始终位于其他窗口之上）",
			"toast.detachFailed": "外置窗口打开失败",
			"panel.toggleTip": "左键：打开/收回外置窗口 · 右键：显示/隐藏应用内面板",
			"panel.show": "显示面板",
			"notify.title": "DSH 会话监控",
			"notify.done": "会话「{title}」已完成",
			"notify.attention": "会话「{title}」等待你处理",
		};

		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"panel.title": "Sessions",
			"panel.count": "{n} sessions",
			"panel.collapse": "Collapse",
			"panel.expand": "Expand",
			"panel.detach": "Detach",
			"panel.attach": "Recall",
			"panel.notifyOn": "System notifications: on",
			"panel.notifyOff": "System notifications: off",
			"panel.filterActive": "Active",
			"panel.filterAll": "All",
			"panel.filterActiveTip": "Showing active sessions only (running / needs you / unread done); click to show all",
			"panel.filterAllTip": "Showing all sessions (including idle); click to show active only",
			"panel.empty": "No sessions",
			"panel.emptyActive": "No active sessions",
			"panel.opacity": "Opacity",
			"panel.opacityTip": "Adjusts the panel background only; text and status dots stay sharp. Saved automatically",
			"panel.collapseChildren": "Collapse sub-agents",
			"panel.expandChildren": "Expand sub-agents",
			"state.running": "Running",
			"state.attention": "Needs you",
			"state.done": "Done",
			"state.idle": "Idle",
			"state.blank": "New",
			"pip.title": "DSH Sessions",
			"pip.hint": "Click a session to open · always on top",
			"pip.recall": "Recall",
			"toast.detachPopup": "Opened a standalone window (normal, not always-on-top; survives minimizing the app)",
			"toast.detachNative": "Opened the always-on-top window (stays above other windows)",
			"toast.detachFailed": "Could not open the detached window",
			"panel.toggleTip": "Click: open/recall the detached window · Right-click: show/hide the in-app panel",
			"panel.show": "Show panel",
			"notify.title": "DSH Session monitor",
			"notify.done": "Session “{title}” finished",
			"notify.attention": "Session “{title}” needs you",
		};

		/** Persisted preferences (panel-local, no plugin config surface). */
		const LS_NOTIFY = "sm.notify";
		const LS_POS = "sm.pos";
		const LS_COLLAPSED = "sm.collapsed";
		const LS_SHOWALL = "sm.showAll";
		const LS_PANEL = "sm.panel";
		const LS_OPACITY = "sm.opacity";
		const LS_COLLAPSED_PARENTS = "sm.collapsedParents";

		/**
		 * Background-alpha bounds. The floor keeps a translucent panel legible
		 * against arbitrary content behind it; the ceiling is fully opaque.
		 */
		const OPACITY_MIN = 0.2;
		const OPACITY_MAX = 1;

		/** Loopback-only host-half route reporting native-window availability. */
		const PROBE_URL = "/dsh-session-monitor/probe";
		/** Host-half window-control routes (open/close, snapshot, requests). */
		const WINDOW_URL = "/dsh-session-monitor/window";
		const STATE_URL = "/dsh-session-monitor/state";
		const PENDING_URL = "/dsh-session-monitor/pending";
		const CONSUME_URL = "/dsh-session-monitor/consume";
		/** Host-half route that restores and foregrounds the DSH window. */
		const FOCUS_URL = "/dsh-session-monitor/focus";

		/** How long a locally observed finish stays green before it fades to idle. */
		const DONE_WINDOW_MS = 45000;
		/** Per (session, kind) system-notification cooldown. */
		const NOTIFY_COOLDOWN_MS = 60000;

		/**
		 * Row display states in priority order. `dot` is a StateDot semantic,
		 * `key` the dictionary label, `tone` the CSS color for the row label.
		 */
		const STATES = {
			attention: { dot: "warning", key: "state.attention", tone: "var(--dsw-alias-state-warn-primary)" },
			running: { dot: "ongoing", key: "state.running", tone: "var(--dsw-alias-brand-primary)" },
			done: { dot: "done", key: "state.done", tone: "var(--dsw-alias-state-success-primary)" },
			idle: { dot: "idle", key: "state.idle", tone: "var(--dsw-alias-state-idle-primary)" },
		};
		const RANK = { attention: 0, running: 1, done: 2, idle: 3 };

		/**
		 * A minimal snapshot source. `getSnapshot`/`subscribe` is the whole
		 * contract the React hook below needs, so this package adds no runtime
		 * dependency of its own beyond the shared baseline.
		 * @param initial - the first snapshot value.
		 * @returns a snapshot source whose `set` notifies every subscriber.
		 */
		function createSource(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set: (next) => {
					if (Object.is(next, value)) return;
					value = next;
					for (const listener of [...listeners]) listener();
				},
			};
		}

		/** React binding for one snapshot source; stable across re-renders. */
		function useSnap(source) {
			const [value, setValue] = React.useState(() => source.getSnapshot());
			React.useEffect(() => source.subscribe(() => setValue(source.getSnapshot())), [source]);
			return value;
		}

		/**
		 * The row's state dot: a pulsing live indicator while running (a solid
		 * brand-colored core with a breathing halo), the official StateDot for
		 * every settled state.
		 * @param state - one of `STATES`' keys.
		 * @returns the dot element.
		 */
		function dotElement(state) {
			if (state === "running") return e("span", { className: "sm-live", "aria-hidden": true });
			return e(StateDot, { state: STATES[state].dot, size: 8 });
		}

		/** Read one persisted flag; absent (never set) keeps the default. */
		function readFlag(key) {
			try {
				return window.localStorage.getItem(key);
			} catch {
				return null;
			}
		}

		/** Persist one flag; a storage failure must never break the panel. */
		function writeFlag(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch {}
		}

		/** Restore the dragged panel position, or null for the default corner. */
		function loadPos() {
			try {
				const raw = window.localStorage.getItem(LS_POS);
				if (!raw) return null;
				const pos = JSON.parse(raw);
				if (pos && typeof pos.top === "number" && typeof pos.left === "number") return { top: pos.top, left: pos.left };
			} catch {}
			return null;
		}

		/** Default panel position: below the title bar, hugging the right edge. */
		function defaultPos() {
			const width = window.innerWidth || 1280;
			return { top: 56, left: Math.max(12, width - 320) };
		}

		/** Clamp any candidate alpha into the legible range, or null when unusable. */
		function clampOpacity(value) {
			const number = typeof value === "number" ? value : Number.parseFloat(String(value));
			if (!Number.isFinite(number)) return null;
			return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, number));
		}

		/**
		 * Resolve one theme token into `rgb()`/`rgba()` components.
		 *
		 * The panel's background comes from a `--dsw-alias-*` token that may be
		 * any CSS color form, so this asks the browser to normalize it (via a
		 * throwaway element's computed style) instead of parsing it by hand. Any
		 * unreadable form yields null and the caller keeps the token as-is.
		 * @param value - the token's computed value.
		 * @returns the channel triple, or null when it cannot be resolved.
		 */
		function toRgbChannels(value) {
			const text = typeof value === "string" ? value.trim() : "";
			if (text === "") return null;
			try {
				const probe = document.createElement("span");
				probe.style.color = text;
				if (probe.style.color === "") return null;
				// A detached element has no computed style; only trust the
				// normalized color the CSSOM itself produced.
				const normalized = probe.style.color;
				const match = /^rgba?\(([^)]+)\)$/i.exec(normalized);
				if (!match) return null;
				const parts = match[1].split(/[\s,/]+/).filter((part) => part !== "");
				if (parts.length < 3) return null;
				const channels = parts.slice(0, 3).map((part) => Number.parseFloat(part));
				if (channels.some((channel) => !Number.isFinite(channel))) return null;
				return channels;
			} catch {
				return null;
			}
		}

		/**
		 * One background color at the requested alpha.
		 *
		 * Only the background is affected: the panel's text, dots and borders
		 * keep their own opaque colors, which is what keeps a translucent panel
		 * readable. Returning the raw token unchanged at full alpha keeps the
		 * theme's own color (and any gradient/keyword form) intact.
		 * @param opacity - the clamped background alpha.
		 * @returns a CSS color for the panel background.
		 */
		function panelBackground(opacity) {
			const token = "var(--dsw-alias-bg-overlay, #202124)";
			if (opacity >= OPACITY_MAX) return token;
			let channels = null;
			try {
				channels = toRgbChannels(window.getComputedStyle(document.documentElement).getPropertyValue("--dsw-alias-bg-overlay"));
			} catch {
				channels = null;
			}
			// No resolvable token (or a non-rgb form): fall back to the shipped
			// surface color, so the alpha still works instead of silently not.
			if (channels === null) channels = [32, 33, 36];
			return "rgba(" + channels.map((channel) => Math.round(channel)).join(",") + "," + opacity + ")";
		}

		/**
		 * Restore the saved background alpha, or the shipped default.
		 *
		 * An absent value means "never set" and keeps the default opaque panel;
		 * a stored value outside the range is clamped rather than trusted, so a
		 * hand-edited storage entry cannot make the panel unreadable.
		 */
		function loadOpacity() {
			const stored = clampOpacity(readFlag(LS_OPACITY));
			return stored === null ? OPACITY_MAX : stored;
		}

		/** Restore the set of collapsed parent session ids, or an empty set. */
		function loadCollapsedParents() {
			try {
				const raw = readFlag(LS_COLLAPSED_PARENTS);
				if (!raw) return new Set();
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return new Set();
				return new Set(parsed.filter((id) => typeof id === "string" && id !== ""));
			} catch {
				return new Set();
			}
		}

		/** True when this browser can open a Document Picture-in-Picture window. */
		function pipDetachable() {
			return typeof window !== "undefined" && "documentPictureInPicture" in window;
		}

		/**
		 * Map one session's facts to a display state. Pending interaction wins
		 * over running (the turn is open but blocked on the user), a finish the
		 * user has not acknowledged wins over plain idle.
		 * @param summary - the catalog row (`SessionSummary`).
		 * @param status - the unified UI status row, when the service is present.
		 * @param locallyDone - this row finished within the local done window.
		 * @returns one of `STATES`' keys.
		 */
		function deriveState(summary, status, locallyDone) {
			if (status && status.pendingInteraction) return "attention";
			const running = status ? status.running === true : summary.running === true;
			if (running) return "running";
			if ((status && status.completionUnread) || locallyDone) return "done";
			return "idle";
		}

		/**
		 * Project the session list and status snapshots into sorted rows.
		 *
		 * The list's `ids` array only carries top-level sessions: the host's
		 * projection writes sub-agents into `byId` and often leaves them out of
		 * `ids`, which is why they were invisible before. So this walks `byId`
		 * for the sub-agent entries (`origin: "subagent"`, or any entry naming a
		 * `parentId`) and attaches each to its parent as a child row.
		 *
		 * Filtering happens here rather than in a second pass, because the two
		 * decisions are entangled: a collapsed parent hides its children, so the
		 * parent must survive the active-only filter whenever a child it is
		 * hiding would have survived it. Filtering afterwards would drop a quiet
		 * parent and silently take its running sub-agent down with it.
		 *
		 * @param list - `SessionListState` from `ctx.sessions.list`, or null.
		 * @param statusMap - `SessionStatusSnapshot` when `ctx.uiSession` exists.
		 * @param localDone - id → deadline map for locally observed finishes.
		 * @param collapsedParents - parent ids whose children are hidden.
		 * @param showAll - true keeps idle rows too; false is the active view.
		 * @returns `rows` (what to render), `allRows` (every entry regardless of
		 *   filter or collapse, for the notifier) and the total entry count.
		 */
		function buildRows(list, statusMap, localDone, collapsedParents, showAll) {
			if (!list || !list.byId) return { rows: [], allRows: [], totalCount: 0 };
			const now = Date.now();
			const childrenOf = new Map();
			const seen = new Set();

			/** One summary → one display row (state, title, depth facts). */
			const toRow = (id, summary) => {
				const status = statusMap ? statusMap.get(id) : undefined;
				return {
					id,
					title: summary.displayTitle || String(id),
					cwd: typeof summary.cwd === "string" ? summary.cwd : "",
					blank: summary.blank === true,
					state: deriveState(summary, status, (localDone.get(id) || 0) > now),
					updatedAt: typeof summary.updatedAt === "number" ? summary.updatedAt : 0,
				};
			};

			// A child is any entry the host marked as a sub-agent or that names a
			// parent present in this snapshot. Both facts are optional, so the
			// check is deliberately permissive: a missed child is invisible,
			// while a mis-parented one degrades to a root row (never dropped).
			const isChildOf = (summary) => {
				const parentId = typeof summary.parentId === "string" ? summary.parentId : "";
				if (parentId === "" || parentId === summary.id) return false;
				return summary.origin === "subagent" || list.byId[parentId] !== undefined;
			};

			// Pass 1: classify every entry in `byId`, so a child whose parent is
			// absent from `ids` still finds its parent, and a parent that is
			// itself only in `byId` still shows up.
			for (const id of Object.keys(list.byId)) {
				const summary = list.byId[id];
				if (!summary) continue;
				seen.add(id);
				if (isChildOf(summary)) {
					const parentId = summary.parentId;
					if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
					childrenOf.get(parentId).push(id);
				}
			}

			/** The same priority order the flat list always used. */
			const byPriority = (left, right) => {
				const byRank = RANK[left.state] - RANK[right.state];
				if (byRank !== 0) return byRank;
				return right.updatedAt - left.updatedAt;
			};

			// Pass 2: roots keep the host's own ordering (`ids` first, in order),
			// which is the authoritative order the official lineage projection
			// also relies on.
			const roots = [];
			const rootIds = new Set();
			const pushRoot = (id, summary) => {
				if (isChildOf(summary)) return;
				if (rootIds.has(id)) return;
				rootIds.add(id);
				roots.push(toRow(id, summary));
			};
			for (const id of list.ids || []) {
				const summary = list.byId[id];
				if (summary) pushRoot(id, summary);
			}
			for (const id of seen) pushRoot(id, list.byId[id]);
			roots.sort(byPriority);

			// Pass 3: interleave each parent with its own children, dropping the
			// idle ones in the active view. A parent survives when it is itself
			// active, or when it still has a child on screen to account for.
			const rows = [];
			/** Every entry, filter and collapse ignored; the notifier's input. */
			const allRows = [];
			for (const parent of roots) {
				const kids = childrenOf.get(parent.id) || [];
				const childRows = kids
					.map((id) => ({ ...toRow(id, list.byId[id]), child: true, parentId: parent.id }))
					.sort(byPriority);
				allRows.push({ ...parent, child: false, childCount: childRows.length, collapsed: false });
				for (const child of childRows) allRows.push(child);

				const keptChildren = showAll ? childRows : childRows.filter((child) => child.state !== "idle");
				const parentActive = showAll || parent.state !== "idle";
				if (!parentActive && keptChildren.length === 0) continue;
				const collapsed = keptChildren.length > 0 && collapsedParents.has(parent.id);
				rows.push({
					...parent,
					child: false,
					childCount: keptChildren.length,
					collapsed,
				});
				if (collapsed) continue;
				for (const child of keptChildren) rows.push(child);
			}
			return { rows, allRows, totalCount: seen.size };
		}

		/**
		 * Stable signature so an unchanged list never re-renders the panel.
		 *
		 * The child/parent facts are part of the signature because they change
		 * what is on screen: gaining a sub-agent, or collapsing a parent, must
		 * repaint even when every state string stays the same.
		 */
		function rowsSignature(rows) {
			let signature = "";
			for (const row of rows) {
				signature +=
					row.id +
					":" +
					row.state +
					":" +
					row.updatedAt +
					":" +
					row.title +
					":" +
					(row.child ? "c" : "r") +
					":" +
					(row.collapsed ? "x" : "o") +
					":" +
					(row.childCount || 0) +
					";";
			}
			return signature;
		}

		/** Panel stylesheet, inserted once per plugin life into the app document. */
		const PANEL_CSS = `
.sm-root{position:fixed;z-index:1000;width:300px;max-width:calc(100vw - 24px);background:var(--dsw-alias-bg-overlay,#202124);border:1px solid var(--dsw-alias-border-l1,#3c4043);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#e8eaed);font-size:12px;line-height:1.5;overflow:hidden}
.sm-head{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:grab;user-select:none;touch-action:none}
.sm-head:active{cursor:grabbing}
.sm-title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-count{color:var(--dsw-alias-label-secondary,#9aa0a6);font-variant-numeric:tabular-nums}
.sm-btn{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l1,#3c4043);background:transparent;color:inherit;border-radius:6px;height:22px;padding:0 7px;font-size:11px;cursor:pointer}
.sm-btn:hover{background:var(--dsw-alias-bg-layer-2,#292a2d)}
.sm-btn.on{color:var(--dsw-alias-state-success-primary,#81c995);border-color:var(--dsw-alias-state-success-primary,#81c995)}
.sm-btn.filter.on{color:var(--dsw-alias-brand-primary,#8ab4f8);border-color:var(--dsw-alias-brand-primary,#8ab4f8)}
.sm-opacity{display:flex;align-items:center;gap:6px;padding:0 8px 6px;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:11px}
.sm-opacity input{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary,#8ab4f8);height:14px;cursor:pointer}
.sm-opacity-value{flex:none;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
.sm-list{max-height:300px;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:2px}
.sm-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;border-radius:6px;padding:7px 8px;color:inherit;font:inherit;cursor:pointer}
.sm-row:hover{background:var(--dsw-alias-bg-layer-2,#292a2d)}
.sm-row-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-row-state{flex:none;font-size:11px}
.sm-row.blank .sm-row-title{color:var(--dsw-alias-label-secondary,#9aa0a6)}
.sm-twisty{appearance:none;flex:none;width:14px;height:14px;padding:0;border:0;border-radius:3px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:9px;line-height:1;cursor:pointer}
.sm-twisty:hover{background:var(--dsw-alias-bg-layer-2,#292a2d);color:var(--dsw-alias-label-primary,#e8eaed)}
.sm-twisty-spacer{flex:none;width:14px}
.sm-row.child{padding-left:20px}
.sm-row.child .sm-row-title{color:var(--dsw-alias-label-secondary,#9aa0a6)}
.sm-empty{padding:12px 8px;color:var(--dsw-alias-label-secondary,#9aa0a6);text-align:center}
.sm-legend{display:flex;flex-wrap:wrap;gap:4px 10px;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l1,#3c4043);color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:11px}
.sm-legend-item{display:inline-flex;align-items:center;gap:4px}
.sm-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.sm-dot-running{background:var(--dsw-alias-brand-primary,#8ab4f8)}
.sm-dot-attention{background:var(--dsw-alias-state-warn-primary,#fdd663)}
.sm-dot-done{background:var(--dsw-alias-state-success-primary,#81c995)}
.sm-dot-idle{background:var(--dsw-alias-state-idle-primary,#9aa0a6)}
.sm-side{display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font:inherit;font-size:12px;cursor:pointer}
.sm-side:hover{background:var(--dsw-alias-bg-layer-2,#292a2d)}
.sm-side-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary,#9aa0a6)}
.sm-side-dot.on{background:var(--dsw-alias-state-success-primary,#81c995)}
.sm-live{position:relative;display:inline-block;flex:none;width:10px;height:10px;margin-left:2px;border-radius:50%;background:var(--dsw-alias-brand-primary,#8ab4f8);animation:sm-breathe 1.2s ease-in-out infinite}
.sm-live::before,.sm-live::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--dsw-alias-brand-primary,#8ab4f8);animation:sm-ripple 1.2s ease-out infinite}
.sm-live::after{animation-delay:.6s}
@keyframes sm-breathe{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.16);opacity:.85}}
@keyframes sm-ripple{0%{transform:scale(.7);opacity:.9}70%{transform:scale(2.2);opacity:0}100%{transform:scale(2.2);opacity:0}}
@media (prefers-reduced-motion: reduce){.sm-live,.sm-live::before,.sm-live::after{animation:none}.sm-live::before{transform:scale(1.5);opacity:.9}.sm-live::after{transform:scale(2.05);opacity:.35}}
`;

		/** Detached-window stylesheet; theme variables are injected at runtime. */
		const PIP_CSS = `
html,body{margin:0;height:100%}
body{background:var(--dsw-alias-bg-layer-1,#202124);color:var(--dsw-alias-label-primary,#e8eaed);font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.sm-pip{display:flex;flex-direction:column;height:100vh;box-sizing:border-box}
.sm-pip-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#3c4043)}
.sm-pip-title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-pip-recall{appearance:none;border:1px solid var(--dsw-alias-border-l1,#3c4043);background:transparent;color:inherit;border-radius:6px;height:22px;padding:0 8px;font-size:11px;cursor:pointer}
.sm-pip-recall:hover{background:var(--dsw-alias-bg-layer-2,#292a2d)}
.sm-pip-filter{appearance:none;border:1px solid var(--dsw-alias-border-l1,#3c4043);background:transparent;color:inherit;border-radius:6px;height:22px;padding:0 8px;font-size:11px;cursor:pointer}
.sm-pip-filter:hover{background:var(--dsw-alias-bg-layer-2,#292a2d)}
.sm-pip-filter.on{color:var(--dsw-alias-brand-primary,#8ab4f8);border-color:var(--dsw-alias-brand-primary,#8ab4f8)}
.sm-pip-list{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:2px}
.sm-pip-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;border-radius:6px;padding:8px;color:inherit;font:inherit;cursor:pointer}
.sm-pip-row:hover{background:var(--dsw-alias-bg-layer-2,#292a2d)}
.sm-pip-row-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-pip-row-state{flex:none;font-size:11px}
.sm-pip-row.blank .sm-pip-row-title{color:var(--dsw-alias-label-secondary,#9aa0a6)}
.sm-pip-twisty{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:9px;cursor:pointer}
.sm-pip-twisty:hover{color:var(--dsw-alias-label-primary,#e8eaed)}
.sm-pip-twisty-spacer{flex:none;width:14px}
.sm-pip-row.child{padding-left:20px}
.sm-pip-row.child .sm-pip-row-title{color:var(--dsw-alias-label-secondary,#9aa0a6)}
.sm-pip-empty{padding:16px 8px;color:var(--dsw-alias-label-secondary,#9aa0a6);text-align:center}
.sm-pip-hint{padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1,#3c4043);color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:11px}
.sm-live{position:relative;display:inline-block;flex:none;width:10px;height:10px;margin-left:2px;border-radius:50%;background:var(--dsw-alias-brand-primary,#8ab4f8);animation:sm-breathe 1.2s ease-in-out infinite}
.sm-live::before,.sm-live::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--dsw-alias-brand-primary,#8ab4f8);animation:sm-ripple 1.2s ease-out infinite}
.sm-live::after{animation-delay:.6s}
@keyframes sm-breathe{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.16);opacity:.85}}
@keyframes sm-ripple{0%{transform:scale(.7);opacity:.9}70%{transform:scale(2.2);opacity:0}100%{transform:scale(2.2);opacity:0}}
@media (prefers-reduced-motion: reduce){.sm-live,.sm-live::before,.sm-live::after{animation:none}.sm-live::before{transform:scale(1.5);opacity:.9}.sm-live::after{transform:scale(2.05);opacity:.35}}
`;

		/** Required services: the slot registry, copy, session catalog, navigation. */
		const inject = ["slots", "locale", "sessions", "uiWorkspace"];

		/**
		 * Client plugin body: mirror the live session catalog into a local
		 * snapshot, render the in-app floating panel, own the detached
		 * Picture-in-Picture window, and raise the finish/attention notices.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const locale = ctx.locale;
			const t = locale && locale.bind ? locale.bind(NS) : (key) => key;
			const sessions = ctx.get("sessions") || null;
			const uiSession = ctx.get("uiSession") || null;
			const uiWorkspace = ctx.get("uiWorkspace") || null;

			ctx.effect(
				() => (locale && locale.register ? locale.register(NS, { zh, en }) : undefined),
				"session-monitor: dictionaries",
			);

			// --- local state -----------------------------------------------------

			const source = createSource({
				rows: [],
				runningCount: 0,
				totalCount: 0,
				collapsed: readFlag(LS_COLLAPSED) === "1",
				detached: false,
				detachable: pipDetachable(),
				notifyOn: readFlag(LS_NOTIFY) !== "0",
				showAll: readFlag(LS_SHOWALL) === "1",
				// Background alpha only: text, dots and borders stay fully opaque,
				// so a translucent panel still reads clearly over the app.
				opacity: loadOpacity(),
				// The panel ships hidden: the detached window is the product.
				// "1" is an explicit opt-in, absent means hidden.
				panelOpen: readFlag(LS_PANEL) === "1",
				notice: null,
				pos: loadPos(),
			});

			/** Merge a patch into the snapshot, skipping no-op re-renders. */
			function publish(patch) {
				const previous = source.getSnapshot();
				const next = { ...previous, ...patch };
				source.set(next);
			}

			/** Catalog rows observed while `ctx.sessions` is unavailable. */
			let fallbackList = null;
			/** id → deadline while a locally observed finish stays green. */
			const localDone = new Map();
			/** id → previous summary running flag, for local finish detection. */
			const previousRunning = new Map();
			/** id → previously seen status, seeded without notifying. */
			const seenStatus = new Map();
			/** kind:id → last system-notification time. */
			const notifiedAt = new Map();
			/** Every row array reuses its reference while nothing changed. */
			let lastRows = [];
			let lastSignature = "";
			/** Entry count behind `lastRows`, including rows the filter dropped. */
			let lastTotalCount = 0;
			/** Parent session ids whose sub-agent rows the user collapsed. */
			const collapsedParents = loadCollapsedParents();
			/** Monotonic notice sequence; a repeat replays by remounting the toast. */
			let noticeSeq = 0;

			// --- notices ----------------------------------------------------------

			/** Raise one in-app toast by dictionary key. */
			function raiseNotice(kind) {
				noticeSeq += 1;
				publish({ notice: { kind, seq: noticeSeq } });
			}

			/** Ask once for system-notification permission, on a user gesture. */
			function ensureNotifyPermission() {
				try {
					if (typeof Notification !== "undefined" && Notification.permission === "default") {
						Promise.resolve(Notification.requestPermission()).then(
							() => {},
							() => {},
						);
					}
				} catch {}
			}

			/**
			 * Raise one system notification, falling back to the in-app toast.
			 * @param kind - dictionary key of the sentence.
			 * @param title - session title interpolated into the sentence.
			 */
			function raiseSystemNotice(kind, title) {
				const body = t(kind, { title });
				try {
					if (typeof Notification !== "undefined" && Notification.permission === "granted") {
						const notification = new Notification(t("notify.title"), { body, tag: "session-monitor:" + kind });
						notification.onclick = () => {
							try {
								window.focus();
							} catch {}
						};
						return;
					}
				} catch {}
				raiseNotice(kind);
			}

			/**
			 * Watch status transitions and notify only while the user is away.
			 * @param statusMap - the unified status snapshot, when available.
			 * @param rows - the freshly built display rows.
			 */
			function watchTransitions(statusMap, rows) {
				const snapshot = source.getSnapshot();
				if (!snapshot.notifyOn) {
					seenStatus.clear();
					return;
				}
				const away = document.visibilityState === "hidden" || document.hasFocus() === false;
				const now = Date.now();
				for (const row of rows) {
					const status = statusMap ? statusMap.get(row.id) : undefined;
					const running = status ? status.running === true : row.state === "running";
					const pending = status ? !!status.pendingInteraction : false;
					const previous = seenStatus.get(row.id);
					seenStatus.set(row.id, { running, pending });
					if (previous === undefined || !away) continue;
					let kind = null;
					if (previous.running && !running) kind = "notify.done";
					else if (!previous.pending && pending) kind = "notify.attention";
					if (kind === null) continue;
					const key = row.id + ":" + kind;
					if (now - (notifiedAt.get(key) || 0) < NOTIFY_COOLDOWN_MS) continue;
					notifiedAt.set(key, now);
					raiseSystemNotice(kind, row.title);
				}
			}

			// --- rebuild ----------------------------------------------------------

			/** Re-derive rows from both snapshots and republish what changed. */
			function rebuild() {
				const list = sessions && sessions.list ? sessions.list.getSnapshot() : fallbackList;
				const statusMap = uiSession && uiSession.sessionStatus ? uiSession.sessionStatus.getSnapshot() : null;

				// Local finish detection: a summary that stopped running greens
				// the row briefly even when the unified status service is absent.
				// This walks `byId`, not `ids`: sub-agents live in `byId` and
				// their finishes are exactly what a parent-level view hides.
				const now = Date.now();
				if (list && list.byId) {
					for (const id of Object.keys(list.byId)) {
						const summary = list.byId[id];
						if (!summary) continue;
						const running = summary.running === true;
						const previous = previousRunning.get(id);
						previousRunning.set(id, running);
						if (previous === true && running === false) localDone.set(id, now + DONE_WINDOW_MS);
					}
				}

				const built = buildRows(list, statusMap, localDone, collapsedParents, source.getSnapshot().showAll);
				// The notifier watches `allRows`, not the visible rows: a session
				// that finishes while the active-only filter (or a collapsed
				// parent) is hiding it must still notify, which is exactly the
				// case the user is away and waiting for.
				watchTransitions(statusMap, built.allRows);
				const signature = rowsSignature(built.rows);
				if (signature !== lastSignature) {
					lastSignature = signature;
					lastRows = built.rows;
					lastTotalCount = built.totalCount;
					applyFilter();
				}
				renderPip();
				pushState();
			}

			/**
			 * Republish the row set the panel and the detached window render.
			 *
			 * `buildRows` has already applied the active-only filter, so this
			 * only counts what is on screen; `totalCount` stays the count of
			 * every known entry so the empty message can tell "no sessions at
			 * all" apart from "none active right now".
			 */
			function applyFilter() {
				let runningCount = 0;
				for (const row of lastRows) {
					if (row.state === "running" || row.state === "attention") runningCount += 1;
				}
				publish({ rows: lastRows, runningCount, totalCount: lastTotalCount });
			}

			// --- navigation -------------------------------------------------------

			/**
			 * Open one session's conversation and pull the app window forward.
			 *
			 * `uiWorkspace.openSession` selects the session but cannot raise the
			 * OS window, and `window.focus()` is a no-op from the sandboxed
			 * iframe the browser half lives in — a minimized DSH used to stay
			 * minimized. The host half owns the real fix (a Win32 restore of the
			 * app window), so this asks for it and keeps the browser-level call
			 * as a harmless fallback for the web profile.
			 * @param id - the session (or sub-agent) id to show.
			 */
			function openSession(id) {
				localDone.delete(id);
				try {
					if (uiWorkspace && uiWorkspace.openSession) uiWorkspace.openSession(id);
				} catch {}
				try {
					window.focus();
				} catch {}
				raiseAppWindow();
				rebuild();
			}

			/**
			 * Ask the host half to restore and foreground the DSH window.
			 *
			 * Fire-and-forget: navigation must never wait on (or fail because
			 * of) a window-management nicety, so every failure path is swallowed
			 * and the row click still switches sessions.
			 */
			function raiseAppWindow() {
				Promise.resolve()
					.then(() =>
						fetch(FOCUS_URL, {
							method: "POST",
							credentials: "same-origin",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({}),
						}),
					)
					.catch(() => {});
			}

			// --- detached Picture-in-Picture window --------------------------------

			let pipWindow = null;

			/** Open the detached window, or recall it when already open. */
			function detach() {
				if (nativeWindow || pipWindow) {
					recall();
					return;
				}
				if (hostDesktop) {
					// The desktop shell's sandboxed frame cannot open any
					// browser window; the host's native window is the path there.
					openNativeWindow(null);
					return;
				}
				if (pipDetachable()) {
					let request;
					try {
						// The call stays inside the click handler: Document PiP
						// requires a user activation, which a promise hop can lose.
						request = window.documentPictureInPicture.requestWindow({ width: 340, height: 460 });
					} catch (error) {
						openNativeWindow(error);
						return;
					}
					Promise.resolve(request)
						.then((opened) => adoptDetached(opened))
						.catch((error) => openNativeWindow(error));
					return;
				}
				openNativeWindow(null);
			}

			/** The host-created native always-on-top window, when open. */
			let nativeWindow = false;
			/** Open-request drain timer; unref'd so it never holds a process. */
			let pendingTimer = 0;
			/** The opener origin, so the host window can poll the same server. */
			let hostOrigin = "";
			/** True once the probe said this Host runs in the desktop shell. */
			let hostDesktop = false;
	
			/**
			 * Ask the host half for the native always-on-top window. The desktop
			 * Host spawns a frameless WPF window (PowerShell) and answers `ok`;
			 * a web-profile Host, or a spawn failure, answers `ok:false` and the
			 * chain continues with the browser-level fallbacks.
			 */
			function openNativeWindow(pipError) {
				const errors = pipError ? [errorText(pipError)] : [];
				Promise.resolve()
					.then(() =>
						fetch(WINDOW_URL, {
							method: "POST",
							credentials: "same-origin",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ action: "open", origin: hostOrigin, state: source.getSnapshot() }),
						}),
					)
					.then((response) => response.json())
					.then((result) => {
						if (result && result.ok && result.open) {
							startNative();
							return;
						}
						if (result && result.error) errors.push(result.error);
						openDetachedPopup(errors);
					})
					.catch((error) => {
						errors.push(errorText(error));
						openDetachedPopup(errors);
					});
			}
	
			/** Track the native window, push the snapshot, drain its requests. */
			function startNative() {
				nativeWindow = true;
				publish({ detached: true });
				pushState();
				ensureNotifyPermission();
				raiseNotice("toast.detachNative");
				startPendingPoll();
			}
	
			/** Push the current snapshot into the native window. */
			function pushState() {
				if (!nativeWindow) return;
				Promise.resolve()
					.then(() =>
						fetch(STATE_URL, {
							method: "POST",
							credentials: "same-origin",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ state: source.getSnapshot() }),
						}),
					)
					.catch(() => {});
			}	
			/** Drain the native window's open-requests into app navigation. */
			function startPendingPoll() {
				if (pendingTimer) return;
				pendingTimer = setInterval(() => {
					Promise.resolve()
						.then(() => fetch(PENDING_URL, { credentials: "same-origin" }))
						.then((response) => response.json())
						.then((result) => {
							if (result && result.open === false && nativeWindow) {
								// The host window closed itself (its × button).
								nativeWindow = false;
								stopPendingPoll();
								publish({ detached: false });
								return;
							}
							const commands = result && Array.isArray(result.commands) ? result.commands : [];
							for (const action of commands) {
								if (action === "toggle-filter") toggleShowAll();
								else if (action === "toggle-notify") toggleNotify();
							}
							// The window's twisty and slider arrive as their own
							// channels: they change settings this half owns, so they
							// must not be mistaken for the header toggles.
							const children = result && Array.isArray(result.children) ? result.children : [];
							for (const parentId of children) toggleChildren(parentId);
							const windowOpacity = result ? result.opacity : null;
							if (typeof windowOpacity === "number") setOpacity(windowOpacity);
							const consumed = commands.length > 0 || children.length > 0 || typeof windowOpacity === "number";
							if (consumed) {
								Promise.resolve()
									.then(() =>
										fetch(CONSUME_URL, {
											method: "POST",
											credentials: "same-origin",
											headers: { "content-type": "application/json" },
											body: JSON.stringify({
												commands,
												children,
												...(typeof windowOpacity === "number" ? { opacity: true } : {}),
											}),
										}),
									)
									.catch(() => {});
							}
							const items = result && Array.isArray(result.items) ? result.items : [];
							if (items.length === 0) return;
							for (const id of items) openSession(id);
							Promise.resolve()
								.then(() =>
									fetch(CONSUME_URL, {
										method: "POST",
										credentials: "same-origin",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({ ids: items }),
									}),
								)
								.catch(() => {});
						})
						.catch(() => {});
				}, 700);
				if (pendingTimer && typeof pendingTimer.unref === "function") pendingTimer.unref();
			}
	
			/** Stop the open-request drain. */
			function stopPendingPoll() {
				if (pendingTimer) {
					clearInterval(pendingTimer);
					pendingTimer = 0;
				}
			}
	
			/** Take ownership of one opened detached window (PiP or popup). */
				function adoptDetached(opened) {
					pipWindow = opened;
					buildPip(opened);
					publish({ detached: true });
					renderPip();
					ensureNotifyPermission();
				}
	
				/**
				 * Fallback detached window: a plain `window.open` popup the opener
				 * drives exactly like the PiP one. It is an independent OS window
				 * (it survives minimizing the app), but — unlike PiP — not always
				 * on top. A sandboxed browser half without allow-popups gets null
				 * here, which the reason string records for the failure toast.
				 */
				function openDetachedPopup(pipError) {
					const errors = pipError ? [errorText(pipError)] : [];
					let opened = null;
					try {
						if (typeof window.open !== "function") {
							errors.push("window.open unavailable");
						} else {
							opened = window.open("about:blank", "dsh-session-monitor", "popup=yes,width=360,height=480") || null;
							if (!opened) errors.push("window.open blocked (sandboxed frame)");
						}
					} catch (error) {
						errors.push(errorText(error));
					}
					if (opened) {
						adoptDetached(opened);
						raiseNotice("toast.detachPopup");
						return;
					}
					failDetach(errors);
				}
	
			/** One error's message, or its string form. */
			function errorText(error) {
				try {
					return error && error.message ? String(error.message) : String(error || "unknown");
				} catch {
					return "unknown";
				}
			}

			/**
			 * Report one detach failure with every reason gathered so far, then
			 * let the host-half probe refine the same toast: it says which host
			 * this is and why its native window was unavailable.
			 */
			function failDetach(errors) {
				pipWindow = null;
				const detail = (Array.isArray(errors) ? errors : [errorText(errors)]).join("; ");
				try {
					console.error("[session-monitor] detach failed:", detail);
				} catch {}
				noticeSeq += 1;
				publish({ notice: { kind: "toast.detachFailed", seq: noticeSeq, detail } });
				Promise.resolve()
					.then(() => fetch(PROBE_URL, { credentials: "same-origin" }))
					.then((response) => response.json())
					.then((info) => {
						noticeSeq += 1;
						const host = info && info.desktop ? "desktop" : "web";
						const reason = info && info.reason ? " (" + info.reason + ")" : "";
						publish({ notice: { kind: "toast.detachFailed", seq: noticeSeq, detail: detail + " | host " + host + reason } });
					})
					.catch(() => {});
			}

			/** Close the detached window and return to the in-app panel. */
			function recall() {
				if (nativeWindow) {
					nativeWindow = false;
					stopPendingPoll();
					publish({ detached: false });
					Promise.resolve()
						.then(() =>
							fetch(WINDOW_URL, {
								method: "POST",
								credentials: "same-origin",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ action: "close" }),
							}),
						)
						.catch(() => {});
					return;
				}
				if (pipWindow) {
					try {
						pipWindow.close();
					} catch {}
				}
				pipWindow = null;
				publish({ detached: false });
			}

			/** Seed the detached document: theme tokens, skeleton, wiring. */
			function buildPip(opened) {
				const doc = opened.document;
				doc.title = t("pip.title");
				const rootStyle = window.getComputedStyle(document.documentElement);
				const names = [
					"--dsw-alias-bg-base",
					"--dsw-alias-bg-layer-1",
					"--dsw-alias-bg-layer-2",
					"--dsw-alias-bg-overlay",
					"--dsw-alias-border-l1",
					"--dsw-alias-border-l2",
					"--dsw-alias-brand-primary",
					"--dsw-alias-label-primary",
					"--dsw-alias-label-secondary",
					"--dsw-alias-state-idle-primary",
					"--dsw-alias-state-success-primary",
					"--dsw-alias-state-warn-primary",
				];
				let variables = "";
				for (const name of names) {
					const value = rootStyle.getPropertyValue(name);
					if (value) variables += name + ":" + value + ";";
				}
				const style = doc.createElement("style");
				style.textContent = ":root{\n" + variables + "\n}\n" + PIP_CSS;
				doc.head.appendChild(style);
				doc.body.innerHTML =
					'<div class="sm-pip"><div class="sm-pip-head"><span class="sm-pip-title"></span><button class="sm-pip-filter" type="button"></button><button class="sm-pip-recall" type="button"></button></div><div class="sm-pip-list"></div><div class="sm-pip-hint"></div></div>';
				doc.querySelector(".sm-pip-title").textContent = t("pip.title");
				doc.querySelector(".sm-pip-recall").textContent = t("pip.recall");
				doc.querySelector(".sm-pip-hint").textContent = t("pip.hint");
				doc.querySelector(".sm-pip-recall").addEventListener("click", () => recall());
				doc.querySelector(".sm-pip-filter").addEventListener("click", () => toggleShowAll());
				opened.addEventListener("pagehide", () => {
					if (pipWindow === opened) {
						pipWindow = null;
						publish({ detached: false });
					}
				});
			}

			/** Repaint the detached window's list from the current snapshot. */
			function renderPip() {
				if (!pipWindow) return;
				const doc = pipWindow.document;
				const snapshot = source.getSnapshot();
				const list = doc.querySelector(".sm-pip-list");
				if (!list) return;
				doc.querySelector(".sm-pip-title").textContent = t("panel.title") + " · " + t("panel.count", { n: snapshot.rows.length });
				const filterButton = doc.querySelector(".sm-pip-filter");
				if (filterButton) {
					filterButton.textContent = t(snapshot.showAll ? "panel.filterAll" : "panel.filterActive");
					filterButton.title = t(snapshot.showAll ? "panel.filterAllTip" : "panel.filterActiveTip");
					if (filterButton.classList) filterButton.classList.toggle("on", snapshot.showAll === true);
				}
				list.textContent = "";
				if (snapshot.rows.length === 0) {
					const empty = doc.createElement("div");
					empty.className = "sm-pip-empty";
					empty.textContent = t(snapshot.totalCount > 0 ? "panel.emptyActive" : "panel.empty");
					list.appendChild(empty);
					return;
				}
				for (const row of snapshot.rows) {
					const item = doc.createElement("button");
					item.type = "button";
					item.className = "sm-pip-row" + (row.blank ? " blank" : "") + (row.child ? " child" : "");
					item.title = row.cwd || row.title;
					// A parent that owns sub-agents gets a twisty; a child gets an
					// indent spacer, so the dot column lines up across both.
					if (row.child) {
						const spacer = doc.createElement("span");
						spacer.className = "sm-pip-twisty-spacer";
						item.appendChild(spacer);
					} else if (row.childCount > 0) {
						const twisty = doc.createElement("span");
						twisty.className = "sm-pip-twisty";
						twisty.textContent = row.collapsed ? "▶" : "▼";
						twisty.title = t(row.collapsed ? "panel.expandChildren" : "panel.collapseChildren");
						twisty.addEventListener("click", (event) => {
							event.stopPropagation();
							toggleChildren(row.id);
						});
						item.appendChild(twisty);
					} else {
						const spacer = doc.createElement("span");
						spacer.className = "sm-pip-twisty-spacer";
						item.appendChild(spacer);
					}
					const dot = doc.createElement("span");
					dot.className = row.state === "running" ? "sm-live" : "sm-dot sm-dot-" + row.state;
					const title = doc.createElement("span");
					title.className = "sm-pip-row-title";
					title.textContent = row.childCount > 0 ? row.title + " ·" + row.childCount : row.title;
					const state = doc.createElement("span");
					state.className = "sm-pip-row-state";
					state.textContent = t(STATES[row.state].key);
					state.style.color = rootToken(STATES[row.state].tone);
					item.appendChild(dot);
					item.appendChild(title);
					item.appendChild(state);
					item.addEventListener("click", () => openSession(row.id));
					list.appendChild(item);
				}
			}

			/**
			 * Resolve one `--dsw-alias-*` token to its computed value, so the
			 * detached document (which shares tokens only as copied variables)
			 * can color inline styles that the stylesheet cannot reach.
			 */
			function rootToken(name) {
				try {
					return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
				} catch {
					return undefined;
				}
			}

			// --- panel commands -----------------------------------------------------

			/** Toggle system notifications; the first enable asks permission. */
			function toggleNotify() {
				const next = !source.getSnapshot().notifyOn;
				writeFlag(LS_NOTIFY, next ? "1" : "0");
				publish({ notifyOn: next });
				if (next) ensureNotifyPermission();
				pushState();
			}

			/** Show or hide the in-app panel (the detached window is default). */
			function togglePanel() {
				const next = !source.getSnapshot().panelOpen;
				writeFlag(LS_PANEL, next ? "1" : "0");
				publish({ panelOpen: next });
			}

			/** Collapse the panel to its header. */
			function toggleCollapsed() {
				const next = !source.getSnapshot().collapsed;
				writeFlag(LS_COLLAPSED, next ? "1" : "0");
				publish({ collapsed: next });
			}

			/** Switch between the active-only view and the full session list. */
			function toggleShowAll() {
				const next = !source.getSnapshot().showAll;
				writeFlag(LS_SHOWALL, next ? "1" : "0");
				// The filter decides which rows exist now that parents and their
				// children are interleaved, so this re-derives the whole set
				// rather than re-filtering a stale one. rebuild() repaints the
				// panel and the detached window and pushes the snapshot.
				publish({ showAll: next });
				rebuild();
			}

			/**
			 * Set the panel's background alpha, clamped and persisted.
			 *
			 * Persisting on every change (not only on drag end) means a slider
			 * released outside the panel, or a closed tab, still keeps the value
			 * the user last saw.
			 * @param value - the requested alpha, clamped into the legible range.
			 */
			function setOpacity(value) {
				const next = clampOpacity(value);
				if (next === null) return;
				writeFlag(LS_OPACITY, String(next));
				publish({ opacity: next });
				renderPip();
				pushState();
			}

			/** Show or hide one parent's sub-agent rows, and remember the choice. */
			function toggleChildren(parentId) {
				if (collapsedParents.has(parentId)) collapsedParents.delete(parentId);
				else collapsedParents.add(parentId);
				try {
					writeFlag(LS_COLLAPSED_PARENTS, JSON.stringify([...collapsedParents]));
				} catch {}
				// rebuild() covers the panel, the detached window and the snapshot.
				rebuild();
			}

			/** Persist the dragged position. */
			function savePos() {
				const pos = source.getSnapshot().pos;
				if (pos) writeFlag(LS_POS, JSON.stringify(pos));
			}

			// --- the panel ----------------------------------------------------------

			/**
			 * The `sidebar.footer.action` entry: one row beside Settings that
			 * toggles the in-app card and the detached window. It is the plugin's
			 * only always-visible affordance, since the card itself starts hidden.
			 * @param props - framework shares; `t` is the locale seat.
			 * @returns the toggle row.
			 */
			function SidebarToggle(props) {
				const snapshot = useSnap(source);
				const translate = props.t || t;
				return e(
					"button",
					{
						type: "button",
						className: "sm-side",
						title: translate("panel.toggleTip"),
						onClick: () => {
							if (snapshot.detached) recall();
							else detach();
						},
						onContextMenu: (event) => {
							event.preventDefault();
							togglePanel();
						},
					},
					e("span", { className: "sm-side-dot" + (snapshot.detached ? " on" : "") }),
					translate(snapshot.detached ? "panel.attach" : "panel.detach"),
				);
			}

			/**
			 * The `shell.overlay` entry: the floating session card. Nothing
			 * renders while no session exists, so the overlay stays quiet on a
			 * fresh profile.
			 * @param props - framework shares; `t` is the locale seat.
			 * @returns the card, or null.
			 */
			function MonitorPanel(props) {
				const snapshot = useSnap(source);
				const translate = props.t || t;
				const pos = snapshot.pos || defaultPos();
				const drag = React.useRef(null);
				const rows = snapshot.rows;

				// Bridge for the unlikely case `ctx.sessions` is absent: the
				// framework still hands every component the global hook.
				const sessionsView = typeof props.useSessions === "function" ? props.useSessions((value) => value) : undefined;
				React.useEffect(() => {
					if (sessionsView) {
						fallbackList = sessionsView;
						rebuild();
					}
				}, [sessionsView]);

				// Hidden by default: the detached window is the product, and the
				// in-app card is the fallback the user opts into. The hooks above
				// still run, because the bridge and the notifications must keep
				// working while the card is off screen.
				if (!snapshot.panelOpen) return null;

				const header = e(
					"div",
					{
						className: "sm-head",
						onPointerDown: (event) => {
							if (event.button !== 0) return;
							if (event.target && event.target.closest && event.target.closest("button")) return;
							drag.current = { x: event.clientX, y: event.clientY, top: pos.top, left: pos.left };
							if (event.currentTarget && event.currentTarget.setPointerCapture) {
								try {
									event.currentTarget.setPointerCapture(event.pointerId);
								} catch {}
							}
						},
						onPointerMove: (event) => {
							const start = drag.current;
							if (!start) return;
							const maxLeft = Math.max(4, (window.innerWidth || 1280) - 80);
							const maxTop = Math.max(4, (window.innerHeight || 800) - 48);
							publish({
								pos: {
									top: Math.min(maxTop, Math.max(4, start.top + event.clientY - start.y)),
									left: Math.min(maxLeft, Math.max(4, start.left + event.clientX - start.x)),
								},
							});
						},
						onPointerUp: () => {
							if (!drag.current) return;
							drag.current = null;
							savePos();
						},
						onPointerCancel: () => {
							drag.current = null;
						},
					},
					e("span", { className: "sm-title" }, translate("panel.title")),
					e("span", { className: "sm-count", title: translate("panel.count", { n: rows.length }) }, String(rows.length)),
					e(
						"button",
						{
							type: "button",
							className: "sm-btn" + (snapshot.notifyOn ? " on" : ""),
							title: translate(snapshot.notifyOn ? "panel.notifyOn" : "panel.notifyOff"),
							onClick: toggleNotify,
						},
						translate(snapshot.notifyOn ? "panel.notifyOn" : "panel.notifyOff"),
					),
					e(
						"button",
						{
							type: "button",
							className: "sm-btn filter" + (snapshot.showAll ? " on" : ""),
							title: translate(snapshot.showAll ? "panel.filterAllTip" : "panel.filterActiveTip"),
							onClick: toggleShowAll,
						},
						translate(snapshot.showAll ? "panel.filterAll" : "panel.filterActive"),
					),
					e(
						"button",
						{
							type: "button",
							className: "sm-btn",
							title: translate("panel.detach"),
							onClick: detach,
						},
						translate(snapshot.detached ? "panel.attach" : "panel.detach"),
					),
					e(
						"button",
						{
							type: "button",
							className: "sm-btn",
							title: translate(snapshot.collapsed ? "panel.expand" : "panel.collapse"),
							onClick: toggleCollapsed,
						},
						translate(snapshot.collapsed ? "panel.expand" : "panel.collapse"),
					),
				);

				const body = snapshot.collapsed
					? null
					: e(
							"div",
							{ className: "sm-list" },
							rows.length === 0
								? e("div", { className: "sm-empty" }, translate(snapshot.totalCount > 0 ? "panel.emptyActive" : "panel.empty"))
								: rows.map((row) => {
										// A parent with children gets a twisty that toggles
										// them; a child gets an indent spacer instead, so the
										// dot column stays aligned across both kinds of row.
										const lead = row.child
											? e("span", { className: "sm-twisty-spacer", key: "lead" })
											: row.childCount > 0
												? e(
														"button",
														{
															key: "lead",
															type: "button",
															className: "sm-twisty",
															title: translate(row.collapsed ? "panel.expandChildren" : "panel.collapseChildren"),
															"aria-expanded": row.collapsed ? "false" : "true",
															onClick: (event) => {
																event.stopPropagation();
																toggleChildren(row.id);
															},
														},
														row.collapsed ? "▶" : "▼",
													)
												: e("span", { className: "sm-twisty-spacer", key: "lead" });
										return e(
											"button",
											{
												key: row.id,
												type: "button",
												className: "sm-row" + (row.blank ? " blank" : "") + (row.child ? " child" : ""),
												title: row.cwd || row.title,
												onClick: () => openSession(row.id),
											},
											lead,
											dotElement(row.state),
											e(
												"span",
												{ className: "sm-row-title" },
												row.title,
												// The child count is what tells a collapsed parent apart
												// from a session that simply has no sub-agents.
												row.childCount > 0 ? e("span", { className: "sm-row-kids" }, " ·" + row.childCount) : null,
											),
											e("span", { className: "sm-row-state", style: { color: STATES[row.state].tone } }, translate(STATES[row.state].key)),
										);
									}),
						);

				const legend = snapshot.collapsed
					? null
					: e(
							"div",
							{ className: "sm-legend" },
							Object.keys(STATES).map((key) =>
								e(
									"span",
									{ key, className: "sm-legend-item" },
									key === "running" ? e("span", { className: "sm-live" }) : e("span", { className: "sm-dot sm-dot-" + key }),
									translate(STATES[key].key),
								),
							),
						);

				const toast = snapshot.notice
					? e(Toast, {
							key: "sm-notice-" + snapshot.notice.seq,
							text: translate(snapshot.notice.kind) + (snapshot.notice.detail ? "：" + snapshot.notice.detail : ""),
							onDone: () => publish({ notice: null }),
						})
					: null;

				// The slider lives under the header rather than in it: the header
				// is the drag handle, and a drag target that is also a fine-grained
				// control makes both unreliable.
				const opacityRow = snapshot.collapsed
					? null
					: e(
							"div",
							{ className: "sm-opacity" },
							e("span", null, translate("panel.opacity")),
							e("input", {
								type: "range",
								min: String(OPACITY_MIN),
								max: String(OPACITY_MAX),
								step: "0.05",
								value: String(snapshot.opacity),
								title: translate("panel.opacityTip"),
								"aria-label": translate("panel.opacity"),
								onChange: (event) => setOpacity(event.target.value),
								onInput: (event) => setOpacity(event.target.value),
							}),
							e("span", { className: "sm-opacity-value" }, Math.round(snapshot.opacity * 100) + "%"),
						);

				// Only the background is translucent; text, dots and borders keep
				// their own opaque theme colors so the panel stays readable.
				return e(
					"div",
					{
						className: "sm-root",
						style: { top: pos.top + "px", left: pos.left + "px", background: panelBackground(snapshot.opacity) },
					},
					header,
					opacityRow,
					body,
					legend,
					toast,
				);
			}

			// --- wiring ------------------------------------------------------------

			const style = document.createElement("style");
			style.textContent = PANEL_CSS;
			document.head.appendChild(style);

			const unsubscribes = [];
			if (sessions && sessions.list && sessions.list.subscribe) unsubscribes.push(sessions.list.subscribe(rebuild));
			if (uiSession && uiSession.sessionStatus && uiSession.sessionStatus.subscribe) unsubscribes.push(uiSession.sessionStatus.subscribe(rebuild));
			if (typeof ctx.on === "function") ctx.on("locale/change", () => renderPip());

			// Remember the origin. A sandboxed frame reports the literal origin
			// "null", so anything that is not an http(s) origin is sent empty and
			// the host derives the address from its own Host header instead. The
			// runtime probe itself runs in openOnStart(), after the registrations.
			try {
				const origin = window.location && window.location.origin ? String(window.location.origin) : "";
				hostOrigin = /^https?:\/\/[^\s/]+$/i.test(origin) ? origin : "";
			} catch {}

			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "session-monitor",
						order: 100,
						locale: NS,
					},
					MonitorPanel,
				),
			);

			// The sidebar toggle is the panel's permanent entry point: with the
			// card hidden by default, a plugin with no visible affordance would
			// be impossible to reach or switch off from the app.
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "session-monitor",
						order: 100,
						locale: NS,
					},
					SidebarToggle,
				),
			);

			rebuild();

			// The detached window is the product, so it opens as soon as the
			// probe says this host can — the answer arrives after apply() runs,
			// which is why this waits on it rather than reading hostDesktop now.
			openOnStart();

			/**
			 * First run: open the detached window where the host supports it.
			 *
			 * The probe's answer arrives after apply() returns, so this runs from
			 * the probe's own continuation. Where no detached window is possible
			 * (a web host without Document PiP), the in-app card is shown instead
			 * of leaving the user with a silently inert plugin.
			 */
			function openOnStart() {
				Promise.resolve()
					.then(() => fetch(PROBE_URL, { credentials: "same-origin" }))
					.then((response) => response.json())
					.then((info) => {
						hostDesktop = !!(info && info.desktop);
						if (hostDesktop) {
							openNativeWindow(null);
							return;
						}
						if (!pipDetachable() && !readFlag(LS_PANEL)) publish({ panelOpen: true });
					})
					.catch(() => {});
			}

			ctx.effect(
				() => () => {
					for (const unsubscribe of unsubscribes) {
						try {
							unsubscribe();
						} catch {}
					}
					stopPendingPoll();
					if (nativeWindow) {
						nativeWindow = false;
						Promise.resolve()
							.then(() =>
								fetch(WINDOW_URL, {
									method: "POST",
									credentials: "same-origin",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({ action: "close" }),
								}),
							)
							.catch(() => {});
					}
					if (pipWindow) {
						try {
							pipWindow.close();
						} catch {}
					}
					style.remove();
				},
				"session-monitor: lifetime",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
