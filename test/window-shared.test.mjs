/**
 * Offline checks for the monitor window's pure logic (`lib/window/shared.js`).
 *
 * These are the rules that used to live inside the PowerShell window script,
 * where they could only be exercised by spawning a real window. Keeping them as
 * plain functions is what makes each one checkable here in milliseconds — and
 * each of them corresponds to a defect that was actually visible to a user:
 *
 *  - the opacity guard (the slider snapping home after a drag),
 *  - the row signature (the panel repainting while nothing changed),
 *  - the bounds clamp (a window reopening on a monitor that is gone),
 *  - the sub-agent label (a collapsed parent looking like a childless session).
 *
 * Usage: node test/window-shared.test.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const shared = require(join(here, "..", "lib", "window", "shared.js"));

let failures = 0;
function check(label, ok) {
	if (ok) {
		console.log("  ok   " + label);
		return true;
	}
	failures += 1;
	console.log("  FAIL " + label);
	return false;
}

// --- state mapping -----------------------------------------------------------

check("a known state passes through", shared.stateOf({ state: "running" }) === "running");
check("an unknown state falls back to idle", shared.stateOf({ state: "exploded" }) === "idle");
check("a missing state falls back to idle", shared.stateOf({}) === "idle");
check("a non-string state falls back to idle", shared.stateOf({ state: 42 }) === "idle");
check("all four states are recognized", ["attention", "running", "done", "idle"].every((key) => shared.stateOf({ state: key }) === key));

// --- opacity -----------------------------------------------------------------

check("alpha is clamped at the floor", shared.clampOpacity(0.05) === shared.OPACITY_MIN);
check("alpha is clamped at the ceiling", shared.clampOpacity(3) === shared.OPACITY_MAX);
check("alpha accepts a numeric string", shared.clampOpacity("0.5") === 0.5);
check("alpha rejects garbage", shared.clampOpacity("abc") === shared.OPACITY_MAX);

// The user drags the slider, then the Host pushes the value it had before the
// drag arrived. Adopting it would snap the slider home — the measured bug.
const now = 1_000_000;
const local = { value: 0.35, at: now };
check("a stale push does not override a fresh local change", shared.acceptsRemoteOpacity(local, 1, now + 100) === false);
check("the host catching up is accepted", shared.acceptsRemoteOpacity(local, 0.35, now + 100) === true);
check("the guard expires instead of blocking forever", shared.acceptsRemoteOpacity(local, 1, now + shared.REMOTE_OPACITY_GRACE_MS + 1) === true);
check("with no local change any push is accepted", shared.acceptsRemoteOpacity(null, 0.6, now) === true);

// --- labels ------------------------------------------------------------------

check("a plain row shows its title", shared.rowLabel({ id: "a", title: "Alpha" }) === "Alpha");
check("a parent shows its sub-agent count", shared.rowLabel({ id: "a", title: "Alpha", childCount: 2 }) === "Alpha  ·2");
check("a child row does not repeat the count", shared.rowLabel({ id: "a", title: "Alpha", child: true, childCount: 2 }) === "Alpha");
check("a zero count is omitted", shared.rowLabel({ id: "a", title: "Alpha", childCount: 0 }) === "Alpha");
check("a titleless row falls back to its id", shared.rowLabel({ id: "sess-9" }) === "sess-9");

// --- the anti-flicker signature ----------------------------------------------

const rows = [
	{ id: "p", title: "Parent", state: "running", childCount: 1, collapsed: false },
	{ id: "c", title: "Child", state: "idle", child: true },
];
const base = shared.rowsSignature(rows, false);
check("an identical snapshot produces an identical signature", shared.rowsSignature([...rows], false) === base);
check("a title change alone does not rebuild the list", shared.rowsSignature([{ ...rows[0], title: "Renamed" }, rows[1]], false) === base);
check("a state change does rebuild", shared.rowsSignature([{ ...rows[0], state: "done" }, rows[1]], false) !== base);
check("a collapse does rebuild", shared.rowsSignature([{ ...rows[0], collapsed: true }, rows[1]], false) !== base);
check("a new sub-agent count does rebuild", shared.rowsSignature([{ ...rows[0], childCount: 3 }, rows[1]], false) !== base);
check("switching the filter does rebuild", shared.rowsSignature(rows, true) !== base);
check("row order matters", shared.rowsSignature([rows[1], rows[0]], false) !== base);

// --- bounds ------------------------------------------------------------------

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const first = shared.clampBounds(null, area, { width: 260, height: 180 });
check("a first open uses the intended default size", first.width === shared.DEFAULT_WIDTH && first.height === shared.DEFAULT_HEIGHT);
check("a first open lands inside the work area", first.x >= 0 && first.y >= 0 && first.x + first.width <= area.width && first.y + first.height <= area.height);

const saved = { x: 100, y: 120, width: 400, height: 500 };
check("a saved rectangle is restored verbatim", JSON.stringify(shared.clampBounds(saved, area, {})) === JSON.stringify(saved));

// A monitor that is gone: the saved rectangle points far off the display.
const offscreen = shared.clampBounds({ x: 5000, y: 4000, width: 400, height: 500 }, area, {});
check("an off-screen save is pulled back a grabbable margin", offscreen.x < area.width && offscreen.y < area.height);
check("an off-screen save keeps part of the window on screen", offscreen.x + offscreen.width > area.x && offscreen.y + offscreen.height > area.y);

const huge = shared.clampBounds({ x: 0, y: 0, width: 4000, height: 3000 }, area, {});
check("an oversized save shrinks to the work area", huge.width === area.width && huge.height === area.height);

const tiny = shared.clampBounds({ x: 10, y: 10, width: 20, height: 20 }, area, { width: 260, height: 180 });
check("an undersized save grows to the minimum", tiny.width === 260 && tiny.height === 180);

const negative = shared.clampBounds({ x: -300, y: -200, width: 340, height: 480 }, area, {});
check("a save off the top-left is pulled back", negative.x >= area.x - negative.width + 48 && negative.y >= area.y - negative.height + 48);

// --- footer ------------------------------------------------------------------

check("the footer carries both counts", shared.formatHint("hint", 2, 5) === "hint  ·  2/5");
check("a missing total falls back to the shown count", shared.formatHint("hint", 3, undefined) === "hint  ·  3/3");

if (failures > 0) {
	console.error("\nwindow-shared check failed:");
	console.error(" - " + failures + " check(s) failed");
	process.exitCode = 1;
} else {
	console.log("\nwindow-shared check passed");
}
