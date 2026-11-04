/**
 * Checks for the localisation path into the detached window.
 *
 * The window is a separate Electron process, so it cannot ask the app what
 * language it is showing: it gets a string table the Host writes for it. The
 * chain has three links and each one failed silently once:
 *
 *   browser half (`ctx.locale.getLocale().active`)  →  Host (`/window` body)
 *   →  `lib/window/strings.json`  →  the window's labels
 *
 * A break in the chain does not throw. It falls back to hardcoded English, which
 * is exactly what a Chinese user saw. These checks pin every link.
 *
 * Usage: node test/window-locale.test.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

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

const zh = JSON.parse(readFileSync(join(root, "locale", "zh.json"), "utf8"));
const en = JSON.parse(readFileSync(join(root, "locale", "en.json"), "utf8"));

// --- every label the window can draw has a translation -------------------------
//
// This is the list `writeWindowStrings()` builds. Adding a label to the renderer
// without adding it here is how English leaked into a Chinese panel, so the list
// is spelled out and compared against the locale files rather than trusted.
const WINDOW_LABELS = {
	title: "pip.title",
	hint: "pip.hint",
	filterActive: "panel.filterActive",
	filterAll: "panel.filterAll",
	filterActiveTip: "panel.filterActiveTip",
	filterAllTip: "panel.filterAllTip",
	notifyOn: "panel.notifyOn",
	notifyOff: "panel.notifyOff",
	empty: "panel.emptyActive",
	emptyAll: "panel.empty",
	opacityTip: "panel.opacityTip",
	collapseChildren: "panel.collapseChildren",
	expandChildren: "panel.expandChildren",
	minimize: "window.minimize",
	maximize: "window.maximize",
	restore: "window.restore",
	close: "window.close",
	running: "state.running",
	attention: "state.attention",
	done: "state.done",
	idle: "state.idle",
};

for (const [field, key] of Object.entries(WINDOW_LABELS)) {
	check(`zh.json translates the window label ${field} (${key})`, typeof zh[key] === "string" && zh[key] !== "");
	check(`en.json translates the window label ${field} (${key})`, typeof en[key] === "string" && en[key] !== "");
}

// Chinese must actually differ from English for the labels a user reads first;
// a copy-paste of the English text would satisfy "non-empty" but not the user.
for (const key of ["pip.title", "panel.filterActive", "panel.filterAll", "window.close", "state.running"]) {
	check(`${key} is really translated (zh differs from en)`, zh[key] !== en[key]);
}
check("the Chinese window title is Chinese", /[\u4e00-\u9fff]/.test(zh["pip.title"]));
check("the Chinese states are Chinese", /[\u4e00-\u9fff]/.test(zh["state.running"]) && /[\u4e00-\u9fff]/.test(zh["state.attention"]));

// --- the Host's string table covers the same fields ----------------------------
//
// `writeWindowStrings` is private to lib/index.js, so its source is read and the
// `pick(...)` calls it makes are extracted: the check fails if the two lists ever
// diverge, in either direction.
const hostSource = readFileSync(join(root, "lib", "index.js"), "utf8");
const block = hostSource.match(/function writeWindowStrings\([\s\S]*?\n\}/);
check("writeWindowStrings is present in lib/index.js", block !== null);
if (block) {
	const picked = [...block[0].matchAll(/(\w+): pick\('([^']+)'/g)].map((m) => ({ field: m[1], key: m[2] }));
	check("writeWindowStrings picks a label for every window field", picked.length === Object.keys(WINDOW_LABELS).length);
	for (const [field, key] of Object.entries(WINDOW_LABELS)) {
		const hit = picked.find((entry) => entry.field === field);
		check(`writeWindowStrings maps ${field} -> ${key}`, hit !== undefined && hit.key === key);
	}
}

// --- the language decision -----------------------------------------------------
//
// `windowLanguage` must take the app's reported language, and must not depend on
// an environment variable that does not exist on Windows (measured: both
// DSH_LOCALE and LANG are empty in the shell's Host process).
const langBlock = hostSource.match(/function windowLanguage\(reported\) \{[\s\S]*?\n\}/);
check("windowLanguage takes a reported language", langBlock !== null);
if (langBlock) {
	const body = langBlock[0];
	const fn = new Function("process", `${body}\nreturn windowLanguage;`)({ env: {} });
	check("a Chinese locale id selects Chinese", fn("zh") === "zh");
	check("a regional Chinese id selects Chinese", fn("zh-CN") === "zh");
	check("a Chinese script id selects Chinese", fn("zh-Hans") === "zh");
	check("an English id selects English", fn("en") === "en");
	check("an unrelated id selects English", fn("ja-JP") === "en");
	check("a missing report selects English rather than throwing", fn(undefined) === "en");
	// With no report at all and no environment, it must not claim Chinese by
	// accident — and, more importantly, must not throw.
	check("an empty report is safe", fn("") === "en");
}

// --- the renderer uses the table, not literals ---------------------------------
//
// A hardcoded English tooltip is invisible to every other check: the panel looks
// translated while the window-control buttons are not.
const rendererSource = readFileSync(join(root, "lib", "window", "renderer.js"), "utf8");
check("the minimize button's label comes from the table", /dom\.minimize\.(title|ariaLabel)\s*=\s*strings\.minimize/.test(rendererSource));
check("the maximize button's label comes from the table", /dom\.maximize\.(title|ariaLabel)\s*=\s*strings\.maximize/.test(rendererSource));
check("the close button's label comes from the table", /dom\.close\.(title|ariaLabel)\s*=\s*strings\.close/.test(rendererSource));
check("no hardcoded English aria-label survives", !/ariaLabel\s*=\s*['"]/.test(rendererSource));

// --- the window's own fallback mirrors the same field set ----------------------
const mainSource = readFileSync(join(root, "lib", "window", "main.cjs"), "utf8");
const fallbackBlock = mainSource.match(/const fallback = \{[\s\S]*?\n\t\};/);
check("the window ships an English fallback table", fallbackBlock !== null);
if (fallbackBlock) {
	for (const field of Object.keys(WINDOW_LABELS)) {
		check(`the fallback table covers ${field}`, new RegExp(`\\b${field}:`).test(fallbackBlock[0]));
	}
}

// --- the dictionary files agree with each other --------------------------------
const zhKeys = Object.keys(zh).filter((key) => key !== "meta").sort();
const enKeys = Object.keys(en).filter((key) => key !== "meta").sort();
check("zh.json and en.json define the same keys", JSON.stringify(zhKeys) === JSON.stringify(enKeys));

if (failures > 0) {
	console.error("\nwindow-locale check failed:");
	console.error(" - " + failures + " check(s) failed");
	process.exitCode = 1;
} else {
	console.log("\nwindow-locale check passed");
}
