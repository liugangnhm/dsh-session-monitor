/**
 * End-to-end check of the app-window raise, against a REAL Electron process.
 *
 * The plugin no longer manages windows with Win32 syscalls. It relaunches the
 * desktop shell's own executable, and the running instance does what it always
 * does for a second launch: `if (window.isMinimized()) window.restore();
 * window.show(); window.focus()`. That sequence lives in the shell, so the only
 * honest way to check the plugin's half is to run a real Electron app that
 * implements the same handler and prove the window actually comes back.
 *
 * The app under test is a throwaway one built from the installed Electron
 * runtime (hard links, no copy of the 246 MB executable), so:
 *
 *   - the user's DSH window is never touched;
 *   - `ELECTRON_RUN_AS_NODE` is inherited from this process on purpose, which
 *     is exactly the trap the production launcher must defuse — if it were not
 *     stripped, the child would run as Node, never reach Electron, and the
 *     probe window would stay minimized. The check fails in that case.
 *
 * Requirements: Windows and an installed desktop app. Override the runtime
 * directory with `DSH_ELECTRON_DIST` when it lives somewhere else.
 *
 *   node test/raise-e2e.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { raiseAppWindow } = await import(new URL("../lib/index.js", import.meta.url));

const failures = [];
const check = (label, condition) => {
	if (!condition) failures.push(label);
	console.log((condition ? "  ok   " : "  FAIL ") + label);
};

const DIST = process.env.DSH_ELECTRON_DIST || "C:\\Users\\lgnhm\\AppData\\Local\\Programs\\DeepSeek Harness";
const EXE_NAME = "DeepSeek Harness.exe";

if (process.platform !== "win32") {
	console.log("raise-e2e skipped: the desktop shell is Windows-only");
	process.exit(0);
}
if (!existsSync(join(DIST, EXE_NAME))) {
	console.log("raise-e2e skipped: no desktop shell at " + DIST);
	process.exit(0);
}

/** Hard-link or copy one file into the throwaway runtime. */
function mirror(source, target) {
	mkdirSync(dirname(target), { recursive: true });
	try {
		linkSync(source, target);
	} catch {
		// A different volume cannot hard-link; a copy is acceptable for the
		// small support files and impossible for the executable, so this is
		// only reached for the former.
		writeFileSync(target, readFileSync(source));
	}
}

const work = mkdtempSync(join(tmpdir(), "sm-raise-e2e-"));
const runtimeDir = join(work, "runtime");
const appDir = join(runtimeDir, "resources", "app");
const statePath = join(work, "probe-state.json");
let app = null;

try {
	// --- a minimal Electron runtime, hard-linked from the installed one -------
	for (const entry of readdirSync(DIST)) {
		const source = join(DIST, entry);
		if (!statSync(source).isFile()) continue;
		mirror(source, join(runtimeDir, entry));
	}
	for (const locale of readdirSync(join(DIST, "locales"))) {
		mirror(join(DIST, "locales", locale), join(runtimeDir, "locales", locale));
	}
	mkdirSync(appDir, { recursive: true });
	writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "sm-raise-probe", version: "1.0.0", main: "main.cjs" }));

	// --- the host: the same handler the real shell runs ----------------------
	//
	// Kept deliberately small: the point is the IPC/OS hand-off, not product
	// behavior. Every step is written to `statePath` so this process can assert
	// what the window actually did — a claim in a log line is not evidence.
	writeFileSync(
		join(appDir, "main.cjs"),
		`const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const write = (patch) => {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
  fs.writeFileSync(statePath, JSON.stringify({ ...current, ...patch }));
};
write({ booted: true, electron: process.versions.electron });
if (!app.requestSingleInstanceLock()) {
  write({ secondInstance: true });
  app.quit();
} else {
  let win = null;
  app.on("second-instance", () => {
    write({ raiseRequested: true });
    if (win === null || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    setTimeout(() => {
      write({ minimized: win.isMinimized(), visible: win.isVisible(), focused: win.isFocused() });
      setTimeout(() => app.quit(), 150);
    }, 500);
  });
  app.whenReady().then(async () => {
    win = new BrowserWindow({ width: 320, height: 220, show: false, title: "sm-raise-probe" });
    await win.loadURL("data:text/html,<h1>raise probe</h1>");
    win.showInactive();
    setTimeout(() => {
      win.minimize();
      write({ minimized: win.isMinimized(), visible: win.isVisible(), focused: win.isFocused() });
    }, 400);
  }).catch((error) => write({ error: String(error && error.stack ? error.stack : error) }));
}`,
	);

	// --- start the probe and wait for its minimized steady state -------------
	app = spawn(join(runtimeDir, EXE_NAME), [], {
		cwd: runtimeDir,
		// No ELECTRON_RUN_AS_NODE here: this is the app itself, started the
		// way a user starts it.
		env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "ELECTRON_RUN_AS_NODE")),
		stdio: "ignore",
	});

	const deadline = Date.now() + 30000;
	let state = {};
	while (Date.now() < deadline) {
		try {
			state = JSON.parse(readFileSync(statePath, "utf8"));
		} catch {}
		if (state.error) break;
		if (state.booted === true && state.minimized === true) break;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	check("the probe Electron app started", state.booted === true);
	check("the probe window is minimized before the raise", state.minimized === true);
	if (state.error) console.error("    probe said:", String(state.error).slice(0, 300));

	// --- the plugin's own launcher, with the Host's real environment --------
	//
	// `process.env` still carries ELECTRON_RUN_AS_NODE=1 (this test runs inside
	// the Host, which the shell starts in Node mode). Handing it over verbatim
	// is the regression guard: the launcher must strip it, or the child never
	// becomes Electron.
	const result = await raiseAppWindow({
		execPath: join(runtimeDir, EXE_NAME),
		env: process.env,
		// In production the Host runs under ELECTRON_RUN_AS_NODE, where
		// `process.versions.electron` is set and this default is used. This
		// check runs under plain Node, so the fact is passed explicitly — the
		// rest of the launcher (env stripping, deep link, exit handling) is the
		// production code path.
		electronVersion: "test",
		platform: "win32",
		timeoutMs: 20000,
	});
	check("the launcher reports the Electron restore path", result.ok === true && result.action === "electron:restore-show-focus");

	// --- the window really came back ----------------------------------------
	//
	// The probe writes restore/show/focus together, so waiting on the two
	// substantive facts also means the focus fact (reported only for
	// diagnosis) has been written.
	const raisedDeadline = Date.now() + 15000;
	let raised = {};
	while (Date.now() < raisedDeadline) {
		try {
			raised = JSON.parse(readFileSync(statePath, "utf8"));
		} catch {}
		if (raised.minimized === false && raised.visible === true) break;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	check("the running instance received the raise", raised.raiseRequested === true);
	check("Electron restored the minimized window", raised.minimized === false);
	check("Electron made the window visible", raised.visible === true);
	// Focus is the OS foreground policy's call, not the plugin's: Windows may
	// refuse SetForegroundWindow for a process that did not receive the last
	// input. Restore + show are the substantive, verifiable outcomes; focus is
	// reported for diagnosis but is not asserted as guaranteed.
	console.log("  info  focused=" + String(raised.focused) + " (subject to the Windows foreground policy)");
	if (raised.focused !== true) console.error("    last probe state:", JSON.stringify(raised).slice(0, 400));
} finally {
	try {
		if (app && !app.killed) app.kill();
	} catch {}
	// The probe quits itself after reporting; give it a moment so the file
	// handles inside the temp directory are released before removal.
	await new Promise((resolve) => setTimeout(resolve, 500));
	try {
		rmSync(work, { recursive: true, force: true });
	} catch {}
}

if (failures.length > 0) {
	console.error("\nraise-e2e failed:");
	for (const failure of failures) console.error(" - " + failure);
	process.exit(1);
}
console.log("\nraise-e2e passed");
process.exit(0);
