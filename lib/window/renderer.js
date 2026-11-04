/**
 * The monitor window's renderer.
 *
 * A pure view over the snapshots the main process polls from the Host: it owns
 * no session state, computes no status, and talks to nothing but its own main
 * process. Rebuilding the list only when the drawn facts change is what keeps
 * the panel from flickering — a full repaint on every push was the visible
 * symptom of the old window.
 *
 * @module dsh-session-monitor/window/renderer
 */
'use strict';

(function () {
	const shared = window.SmWindowShared;
	const bridge = window.monitorWindow;
	const strings = bridge.bootstrap().strings || {};

	/** Last drawn signature; the list is rebuilt only when this changes. */
	let signature = '';
	/** The user's own alpha and when they set it, so a stale push cannot undo it. */
	let localOpacity = null;
	/** The alpha this window last applied/asked for; the anti-loop marker. */
	let appliedOpacity = null;
	/** True while a pushed alpha is moving the slider. */
	let syncingOpacity = false;

	const dom = {
		drag: document.getElementById('drag'),
		filter: document.getElementById('filter'),
		notify: document.getElementById('notify'),
		minimize: document.getElementById('minimize'),
		maximize: document.getElementById('maximize'),
		close: document.getElementById('close'),
		list: document.getElementById('list'),
		hint: document.getElementById('hint'),
		opacity: document.getElementById('opacity'),
		opacityValue: document.getElementById('opacity-value'),
		grip: document.getElementById('grip'),
	};

	// --- static labels ----------------------------------------------------------

	document.title = strings.title;
	dom.drag.textContent = strings.title;
	dom.drag.title = strings.title;
	dom.minimize.ariaLabel = strings.title ? 'Minimize' : 'Minimize';
	dom.opacity.title = strings.opacityTip;

	// --- the header -------------------------------------------------------------

	/**
	 * Paint one toggle button.
	 *
	 * Repainted on EVERY push, not only when the value changes: a button that
	 * updates conditionally gives no feedback at all when its state already
	 * matches, which reads as "the button does nothing".
	 * @param element - the button.
	 * @param on - whether the setting is on.
	 * @param text - the label to show.
	 */
	function paintToggle(element, on, text) {
		element.textContent = text;
		element.classList.toggle('on', !!on);
		element.setAttribute('aria-pressed', on ? 'true' : 'false');
	}

	// --- the list ---------------------------------------------------------------

	/**
	 * Build one row.
	 * @param row - one normalized snapshot row.
	 * @returns the row element.
	 */
	function buildRow(row) {
		const state = shared.stateOf(row);
		const element = document.createElement('div');
		element.className = 'row' + (row.child === true ? ' child' : '') + (row.blank === true || row.child === true ? ' muted' : '');
		element.setAttribute('role', 'listitem');
		element.dataset.id = String(row.id || '');

		// Column 0: a twisty for a parent with sub-agents, otherwise a spacer so
		// every dot stays in the same column.
		const lead = document.createElement('div');
		const childCount = typeof row.childCount === 'number' ? row.childCount : 0;
		if (row.child !== true && childCount > 0) {
			lead.className = 'twisty';
			lead.textContent = row.collapsed === true ? '\u25B6' : '\u25BC';
			lead.addEventListener('click', (event) => {
				// The twisty is inside the row: without this, collapsing would also
				// open the session.
				event.stopPropagation();
				bridge.toggleChildren(String(row.id || ''));
			});
		}
		element.appendChild(lead);

		const dot = document.createElement('div');
		dot.className = 'dot ' + state;
		element.appendChild(dot);

		const label = document.createElement('div');
		label.className = 'label';
		label.textContent = shared.rowLabel(row);
		label.title = label.textContent;
		element.appendChild(label);

		const stateText = document.createElement('div');
		stateText.className = 'state ' + state;
		stateText.textContent = strings[state] || state;
		element.appendChild(stateText);

		element.addEventListener('click', () => {
			bridge.openSession(String(row.id || ''));
		});
		return element;
	}

	/**
	 * Draw a snapshot.
	 *
	 * The signature gate is the anti-flicker core: identical snapshots produce
	 * no DOM work at all, so the panel is completely still while nothing changes.
	 * @param snapshot - `{rows, showAll, totalCount}` from the main process.
	 */
	function render(snapshot) {
		const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
		const showAll = snapshot.showAll === true;

		paintToggle(dom.filter, showAll, showAll ? strings.filterAll : strings.filterActive);
		paintToggle(dom.notify, snapshot.notifyOn !== false, snapshot.notifyOn !== false ? strings.notifyOn : strings.notifyOff);
		dom.hint.textContent = shared.formatHint(strings.hint, rows.length, snapshot.totalCount);

		if (typeof snapshot.opacity === 'number' && shared.acceptsRemoteOpacity(localOpacity, snapshot.opacity, Date.now())) {
			const alpha = shared.clampOpacity(snapshot.opacity);
			// Track what this window last asked for, so the very same push does
			// not trigger another request. Without this the panel re-published
			// its alpha on every poll (measured: one `opacity` line per second,
			// forever) — a feedback loop between this window and the Host.
			if (Math.abs(appliedOpacity - alpha) > 0.001) {
				appliedOpacity = alpha;
				if (Math.abs(dom.opacity.valueAsNumber - alpha) > 0.001) {
					syncingOpacity = true;
					try {
						dom.opacity.value = String(alpha);
					} finally {
						syncingOpacity = false;
					}
				}
				paintOpacityLabel(alpha);
				// The window alpha lives in the main process; the renderer asks.
				bridge.setOpacity(alpha);
			}
		}

		const next = shared.rowsSignature(rows, showAll);
		if (next === signature) return;
		signature = next;

		dom.list.textContent = '';
		if (rows.length === 0) {
			const empty = document.createElement('div');
			empty.id = 'empty';
			empty.textContent = showAll ? strings.emptyAll : strings.empty;
			dom.list.appendChild(empty);
			return;
		}
		const fragment = document.createDocumentFragment();
		for (const row of rows) fragment.appendChild(buildRow(row));
		dom.list.appendChild(fragment);
	}

	// --- opacity ----------------------------------------------------------------

	/** Show the alpha as a percentage. @param alpha - 0.2..1 */
	function paintOpacityLabel(alpha) {
		dom.opacityValue.textContent = Math.round(alpha * 100) + '%';
	}

	dom.opacity.addEventListener('input', () => {
		if (syncingOpacity) return;
		const alpha = shared.clampOpacity(dom.opacity.valueAsNumber);
		paintOpacityLabel(alpha);
		// Record the user's own change BEFORE publishing it: until the Host
		// echoes it back, polls must leave both the slider and the window alone.
		localOpacity = { value: alpha, at: Date.now() };
		appliedOpacity = alpha;
		bridge.setOpacity(alpha);
	});

	{
		// Seed from the saved value: the first push carries the same number, and
		// treating it as a change would re-publish it for no reason.
		const seed = shared.clampOpacity(bridge.bootstrap().opacity);
		appliedOpacity = seed;
		dom.opacity.value = String(seed);
		paintOpacityLabel(seed);
	}

	// --- header wiring ----------------------------------------------------------

	dom.filter.addEventListener('click', () => bridge.command('toggle-filter'));
	dom.notify.addEventListener('click', () => bridge.command('toggle-notify'));
	dom.minimize.addEventListener('click', () => bridge.windowAction('minimize'));
	dom.maximize.addEventListener('click', () => bridge.windowAction('maximize'));
	dom.close.addEventListener('click', () => bridge.windowAction('close'));

	// Double-clicking the drag area is the platform-standard maximize gesture.
	dom.drag.addEventListener('dblclick', () => bridge.windowAction('maximize'));

	// --- incoming pushes --------------------------------------------------------

	bridge.subscribe('state', (snapshot) => {
		if (snapshot && typeof snapshot === 'object') render(snapshot);
	});

	bridge.subscribe('host-gone', () => {
		dom.hint.textContent = '';
	});
})();
