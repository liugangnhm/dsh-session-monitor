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
			"state.running": "运行中",
			"state.attention": "待处理",
			"state.done": "已完成",
			"state.idle": "空闲",
			"state.blank": "新会话",
			"pip.title": "DSH 会话监控",
			"pip.hint": "点击会话跳转 · 窗口始终置顶",
			"pip.recall": "收回",
			"toast.detachPopup": "已打开独立窗口（普通窗口、不置顶；DSH 最小化时仍在）",
			"toast.detachFailed": "外置窗口打开失败",
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
			"state.running": "Running",
			"state.attention": "Needs you",
			"state.done": "Done",
			"state.idle": "Idle",
			"state.blank": "New",
			"pip.title": "DSH Sessions",
			"pip.hint": "Click a session to open · always on top",
			"pip.recall": "Recall",
			"toast.detachPopup": "Opened a standalone window (normal, not always-on-top; survives minimizing the app)",
			"toast.detachFailed": "Could not open the detached window",
			"notify.title": "DSH Session monitor",
			"notify.done": "Session “{title}” finished",
			"notify.attention": "Session “{title}” needs you",
		};

		/** Persisted preferences (panel-local, no plugin config surface). */
		const LS_NOTIFY = "sm.notify";
		const LS_POS = "sm.pos";
		const LS_COLLAPSED = "sm.collapsed";
		const LS_SHOWALL = "sm.showAll";

		/** Loopback-only host-half route reporting native-window availability. */
		const PROBE_URL = "/dsh-session-monitor/probe";

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
		 * @param list - `SessionListState` from `ctx.sessions.list`, or null.
		 * @param statusMap - `SessionStatusSnapshot` when `ctx.uiSession` exists.
		 * @param localDone - id → deadline map for locally observed finishes.
		 * @returns display rows, attention first, then running, done, idle.
		 */
		function buildRows(list, statusMap, localDone) {
			if (!list || !list.byId) return [];
			const now = Date.now();
			const rows = [];
			for (const id of list.ids || []) {
				const summary = list.byId[id];
				if (!summary) continue;
				const status = statusMap ? statusMap.get(id) : undefined;
				rows.push({
					id,
					title: summary.displayTitle || String(id),
					cwd: typeof summary.cwd === "string" ? summary.cwd : "",
					blank: summary.blank === true,
					state: deriveState(summary, status, (localDone.get(id) || 0) > now),
					updatedAt: typeof summary.updatedAt === "number" ? summary.updatedAt : 0,
				});
			}
			rows.sort((left, right) => {
				const byRank = RANK[left.state] - RANK[right.state];
				if (byRank !== 0) return byRank;
				return right.updatedAt - left.updatedAt;
			});
			return rows;
		}

		/** Stable signature so an unchanged list never re-renders the panel. */
		function rowsSignature(rows) {
			let signature = "";
			for (const row of rows) signature += row.id + ":" + row.state + ":" + row.updatedAt + ":" + row.title + ";";
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
.sm-list{max-height:300px;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:2px}
.sm-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;border-radius:6px;padding:7px 8px;color:inherit;font:inherit;cursor:pointer}
.sm-row:hover{background:var(--dsw-alias-bg-layer-2,#292a2d)}
.sm-row-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-row-state{flex:none;font-size:11px}
.sm-row.blank .sm-row-title{color:var(--dsw-alias-label-secondary,#9aa0a6)}
.sm-empty{padding:12px 8px;color:var(--dsw-alias-label-secondary,#9aa0a6);text-align:center}
.sm-legend{display:flex;flex-wrap:wrap;gap:4px 10px;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l1,#3c4043);color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:11px}
.sm-legend-item{display:inline-flex;align-items:center;gap:4px}
.sm-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.sm-dot-running{background:var(--dsw-alias-brand-primary,#8ab4f8)}
.sm-dot-attention{background:var(--dsw-alias-state-warn-primary,#fdd663)}
.sm-dot-done{background:var(--dsw-alias-state-success-primary,#81c995)}
.sm-dot-idle{background:var(--dsw-alias-state-idle-primary,#9aa0a6)}
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
				const now = Date.now();
				if (list && list.byId) {
					for (const id of list.ids || []) {
						const summary = list.byId[id];
						if (!summary) continue;
						const running = summary.running === true;
						const previous = previousRunning.get(id);
						previousRunning.set(id, running);
						if (previous === true && running === false) localDone.set(id, now + DONE_WINDOW_MS);
					}
				}

				const rows = buildRows(list, statusMap, localDone);
				watchTransitions(statusMap, rows);
				const signature = rowsSignature(rows);
				if (signature !== lastSignature) {
					lastSignature = signature;
					lastRows = rows;
					applyFilter();
				}
				renderPip();
			}

			/**
			 * Project the full row set through the active-only filter: the
			 * default view keeps running, needs-you and unread-done rows and
			 * drops plain idle ones; the toggle keeps everything.
			 */
			function applyFilter() {
				const snapshot = source.getSnapshot();
				const rows = snapshot.showAll ? lastRows : lastRows.filter((row) => row.state !== "idle");
				let runningCount = 0;
				for (const row of lastRows) if (row.state === "running" || row.state === "attention") runningCount += 1;
				publish({ rows, runningCount, totalCount: lastRows.length });
			}

			// --- navigation -------------------------------------------------------

			/** Open one session's conversation and pull the app window forward. */
			function openSession(id) {
				localDone.delete(id);
				try {
					if (uiWorkspace && uiWorkspace.openSession) uiWorkspace.openSession(id);
				} catch {}
				try {
					window.focus();
				} catch {}
				rebuild();
			}

			// --- detached Picture-in-Picture window --------------------------------

			let pipWindow = null;

			/** Open the detached window, or recall it when already open. */
			function detach() {
				if (pipWindow) {
					recall();
					return;
				}
				if (pipDetachable()) {
					let request;
					try {
						// The call stays inside the click handler: Document PiP
						// requires a user activation, which a promise hop can lose.
						request = window.documentPictureInPicture.requestWindow({ width: 340, height: 460 });
					} catch (error) {
						openDetachedPopup(error);
						return;
					}
					Promise.resolve(request)
						.then((opened) => adoptDetached(opened))
						.catch((error) => openDetachedPopup(error));
					return;
				}
				openDetachedPopup(null);
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
			 * on top. This is the only detached window a sandboxed browser
			 * half can get when Document PiP refuses (e.g. inside the desktop
			 * shell, where it fails with "Internal error: no window").
			 */
			function openDetachedPopup(pipError) {
				const errors = [];
				if (pipError) errors.push(errorText(pipError));
				let opened = null;
				try {
					if (typeof window.open === "function") {
						opened = window.open("about:blank", "dsh-session-monitor", "popup=yes,width=360,height=480") || null;
					} else {
						errors.push("window.open unavailable");
					}
				} catch (error) {
					errors.push(errorText(error));
				}
				if (opened) {
					adoptDetached(opened);
					raiseNotice("toast.detachPopup");
					return;
				}
				if (errors.length === 0) errors.push("window.open blocked");
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
			 * let the host-half probe refine the same toast: it says whether
			 * this Host process could create a native window at all.
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
						const electron = info && info.electronApi ? "on" : "off";
						const reason = info && info.reason ? " (" + info.reason + ")" : "";
						publish({ notice: { kind: "toast.detachFailed", seq: noticeSeq, detail: detail + " | host electron=" + electron + reason } });
					})
					.catch(() => {});
			}

			/** Close the detached window and return to the in-app panel. */
			function recall() {
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
					item.className = "sm-pip-row" + (row.blank ? " blank" : "");
					item.title = row.cwd || row.title;
					const dot = doc.createElement("span");
					dot.className = row.state === "running" ? "sm-live" : "sm-dot sm-dot-" + row.state;
					const title = doc.createElement("span");
					title.className = "sm-pip-row-title";
					title.textContent = row.title;
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
				publish({ showAll: next });
				applyFilter();
				renderPip();
			}

			/** Persist the dragged position. */
			function savePos() {
				const pos = source.getSnapshot().pos;
				if (pos) writeFlag(LS_POS, JSON.stringify(pos));
			}

			// --- the panel ----------------------------------------------------------

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
								: rows.map((row) =>
										e(
											"button",
											{
												key: row.id,
												type: "button",
												className: "sm-row" + (row.blank ? " blank" : ""),
												title: row.cwd || row.title,
												onClick: () => openSession(row.id),
											},
											dotElement(row.state),
											e("span", { className: "sm-row-title" }, row.title),
											e("span", { className: "sm-row-state", style: { color: STATES[row.state].tone } }, translate(STATES[row.state].key)),
										),
									),
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

				return e("div", { className: "sm-root", style: { top: pos.top + "px", left: pos.left + "px" } }, header, body, legend, toast);
			}

			// --- wiring ------------------------------------------------------------

			const style = document.createElement("style");
			style.textContent = PANEL_CSS;
			document.head.appendChild(style);

			const unsubscribes = [];
			if (sessions && sessions.list && sessions.list.subscribe) unsubscribes.push(sessions.list.subscribe(rebuild));
			if (uiSession && uiSession.sessionStatus && uiSession.sessionStatus.subscribe) unsubscribes.push(uiSession.sessionStatus.subscribe(rebuild));
			if (typeof ctx.on === "function") ctx.on("locale/change", () => renderPip());

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

			rebuild();

			ctx.effect(
				() => () => {
					for (const unsubscribe of unsubscribes) {
						try {
							unsubscribe();
						} catch {}
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
