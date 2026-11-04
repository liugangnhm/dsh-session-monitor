/**
 * DOM-free logic shared by the monitor window's main process, its renderer,
 * and the offline tests.
 *
 * Loaded three ways, which is why it is written as a tiny UMD shim rather than
 * an ES module: the renderer gets it as a classic `<script>` (Chromium refuses
 * module scripts over `file://`), the Electron main process `require`s it, and
 * the tests import the CommonJS export.
 *
 * Everything here is a pure function over plain data, so the rules that used to
 * be buried inside a PowerShell script — which state key a row maps to, how the
 * opacity guard behaves, how a saved rectangle is clamped onto a changed monitor
 * layout — can be checked without a browser.
 *
 * @module dsh-session-monitor/window/shared
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === 'object' && module && module.exports) module.exports = api;
	else root.SmWindowShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	/** Alpha bounds: the floor keeps a translucent panel legible. */
	const OPACITY_MIN = 0.2;
	const OPACITY_MAX = 1;
	/**
	 * How long the window's own alpha outranks a pushed one.
	 *
	 * The user drags the slider → this window applies it immediately → the host
	 * learns about it only when the browser half next drains (up to ~0.7 s) and
	 * pushes the new snapshot back. Without this guard the next push still
	 * carries the OLD value and the slider snaps home the moment the user lets
	 * go. That bug is why the guard exists at all.
	 */
	const REMOTE_OPACITY_GRACE_MS = 4000;

	/** Smallest rectangle the window may be clamped to. */
	const MIN_WIDTH = 260;
	const MIN_HEIGHT = 180;
	/** Size used the first time the window opens (no saved rectangle). */
	const DEFAULT_WIDTH = 340;
	const DEFAULT_HEIGHT = 480;
	/**
	 * Z-order levels that actually produce a topmost window, most aggressive
	 * first.
	 *
	 * Measured on Electron 44.7.0 for Windows by reading `WS_EX_TOPMOST` back
	 * from Win32: the plain `setAlwaysOnTop(true)` call and the constructor's
	 * `alwaysOnTop: true` option both leave the bit CLEAR, as do the `floating`
	 * and `status` levels. Only these levels set it. The main process therefore
	 * walks this list until the bit is verifiably set instead of trusting one
	 * call — "the panel says always-on-top but sinks behind other windows" was a
	 * real defect, and an unverified `setAlwaysOnTop` is what caused it.
	 */
	const TOPMOST_LEVELS = ['screen-saver', 'pop-up-menu', 'normal'];

	/** Row states, in the order the panel ranks them. */
	const STATE_KEYS = ['attention', 'running', 'done', 'idle'];
	const DEFAULT_STATE = 'idle';

	/**
	 * The display state for one row.
	 * @param row - one normalized snapshot row.
	 * @returns one of STATE_KEYS.
	 */
	function stateOf(row) {
		const value = row && typeof row.state === 'string' ? row.state : '';
		return STATE_KEYS.indexOf(value) >= 0 ? value : DEFAULT_STATE;
	}

	/**
	 * Clamp any candidate alpha into the legible range.
	 * @param value - number or numeric string.
	 * @returns a finite alpha in [OPACITY_MIN, OPACITY_MAX].
	 */
	function clampOpacity(value) {
		const number = typeof value === 'number' ? value : Number.parseFloat(String(value));
		if (!Number.isFinite(number)) return OPACITY_MAX;
		return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, number));
	}

	/**
	 * The row's visible label: the title, plus the sub-agent count a parent
	 * carries. The count is what distinguishes a collapsed parent from a
	 * session that simply has no sub-agents.
	 * @param row - one normalized snapshot row.
	 * @returns display text.
	 */
	function rowLabel(row) {
		const title = row && typeof row.title === 'string' && row.title !== '' ? row.title : String((row && row.id) || '');
		const count = row && row.child !== true && typeof row.childCount === 'number' && row.childCount > 0 ? row.childCount : 0;
		return count > 0 ? title + '  ·' + count : title;
	}

	/**
	 * A comparable signature of everything the list draws.
	 *
	 * The renderer rebuilds the list only when this changes. Rebuilding on every
	 * push is what makes a monitor window flicker while nothing has changed, so
	 * the signature deliberately includes the facts that alter the tree —
	 * hierarchy, child counts, collapse — and not just the state.
	 * @param rows - normalized snapshot rows.
	 * @param showAll - the active/all view flag.
	 * @returns one string.
	 */
	function rowsSignature(rows, showAll) {
		const list = Array.isArray(rows) ? rows : [];
		const parts = [];
		for (const row of list) {
			parts.push(
				[
					String((row && row.id) || ''),
					stateOf(row),
					row && row.child === true ? 'c' : 'p',
					row && row.childCount ? String(row.childCount) : '0',
					row && row.collapsed === true ? 'x' : 'o',
				].join(':'),
			);
		}
		return (showAll ? 'all|' : 'active|') + parts.join('|');
	}

	/**
	 * Fit a saved window rectangle onto a display.
	 *
	 * A saved position can point at a monitor that is no longer connected, so
	 * the result keeps at least a grabbable strip on screen instead of putting
	 * the window where nobody can reach it.
	 * @param bounds - saved `{x,y,width,height}`, or null for the default corner.
	 * @param workArea - the target display's work area.
	 * @param minimum - optional `{width,height}` floor.
	 * @returns `{x,y,width,height}` integers.
	 */
	function clampBounds(bounds, workArea, minimum) {
		const minWidth = (minimum && minimum.width) || MIN_WIDTH;
		const minHeight = (minimum && minimum.height) || MIN_HEIGHT;
		const area =
			workArea && Number.isFinite(workArea.width) && workArea.width > 0 && Number.isFinite(workArea.height)
				? workArea
				: { x: 0, y: 0, width: 1280, height: 800 };
		const width = Math.round(Math.min(Math.max(Number(bounds && bounds.width) || DEFAULT_WIDTH, minWidth), area.width));
		const height = Math.round(Math.min(Math.max(Number(bounds && bounds.height) || DEFAULT_HEIGHT, minHeight), area.height));
		const fallbackX = area.x + Math.max(0, area.width - width - 24);
		const fallbackY = area.y + 64;
		let x = Number.isFinite(bounds && bounds.x) ? Math.round(bounds.x) : fallbackX;
		let y = Number.isFinite(bounds && bounds.y) ? Math.round(bounds.y) : fallbackY;
		const margin = 48;
		x = Math.min(Math.max(x, area.x - width + margin), area.x + area.width - margin);
		y = Math.min(Math.max(y, area.y - height + margin), area.y + area.height - margin);
		return { x, y, width, height };
	}

	/**
	 * Whether a pushed alpha may replace this window's own value.
	 * @param local - `{value, at}` recorded when the user last moved the slider, or null.
	 * @param alpha - the alpha the host pushed.
	 * @param now - current epoch milliseconds.
	 * @returns true when the pushed value should win.
	 */
	function acceptsRemoteOpacity(local, alpha, now) {
		const next = clampOpacity(alpha);
		if (!local || !Number.isFinite(local.at)) return true;
		// The host caught up: the two agree and normal pushing resumes.
		if (Math.abs(local.value - next) <= 0.001) return true;
		return now - local.at > REMOTE_OPACITY_GRACE_MS;
	}

	/**
	 * The footer line: the localized hint plus the counts that make the filter's
	 * effect checkable at a glance.
	 * @param hint - localized hint text.
	 * @param shown - rows currently drawn.
	 * @param total - rows the catalog holds.
	 * @returns one line of text.
	 */
	function formatHint(hint, shown, total) {
		const visible = Number.isFinite(shown) ? shown : 0;
		const all = Number.isFinite(total) ? total : visible;
		return String(hint || '') + '  ·  ' + visible + '/' + all;
	}

	return {
		OPACITY_MIN,
		OPACITY_MAX,
		REMOTE_OPACITY_GRACE_MS,
		MIN_WIDTH,
		MIN_HEIGHT,
		DEFAULT_WIDTH,
		DEFAULT_HEIGHT,
		TOPMOST_LEVELS,
		STATE_KEYS,
		stateOf,
		clampOpacity,
		rowLabel,
		rowsSignature,
		clampBounds,
		acceptsRemoteOpacity,
		formatHint,
	};
});
