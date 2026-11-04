/**
 * Build a throwaway Electron runtime that boots OUR window program.
 *
 * The Host is a plain Node child of the desktop shell, so it cannot construct a
 * `BrowserWindow` itself. But the shell's own executable *is* an Electron
 * runtime, and a packaged Electron app boots `<exe-dir>/resources/app/` when no
 * `app.asar` sits beside it. So the monitor window is opened exactly the way the
 * main window is raised: by launching the shell's executable again — this time
 * against a mirrored runtime directory whose `resources/app` is this plugin's
 * window program.
 *
 * The mirror is built from HARD LINKS: a hard link is a second name for the same
 * bytes, so this costs a few directory entries instead of a 235 MB copy, nothing
 * is duplicated on disk, and the installed app is never modified. Copying is the
 * fallback when the scratch directory is on another volume.
 *
 * Shipping a private Electron runtime with the plugin would add ~200 MB to every
 * install; a PowerShell/WPF window is what this replaces.
 *
 * @module dsh-session-monitor/window-runtime
 */

import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Names that must NOT be mirrored.
 *
 * `resources/app.asar` is the real application: leaving it in place makes
 * Electron boot the actual DSH app instead of the monitor window — measured,
 * because `app.asar` takes precedence over `resources/app/`. `resources/runtime`
 * holds the whole Node/CLI payload (gigabytes of files) that a window program
 * never touches.
 */
const SKIP_TOP_LEVEL = new Set(['resources', 'locales']);

/** Inside `resources/`: the real app, its unpacked sidecar, and the fat runtime. */
const SKIP_RESOURCES = new Set(['app.asar', 'app.asar.unpacked', 'app-update.yml', 'default_app.asar', 'runtime']);

/**
 * Inside `resources/`: the only files the Electron bootstrap actually loads.
 * Everything else there belongs to the real application.
 */
const RESOURCE_FILES = new Set(['icon.png', 'tray.ico', 'elevate.exe']);

/**
 * Mirror one file: hard link when possible, copy when the volumes differ.
 * @param source - absolute source path.
 * @param target - absolute destination path.
 * @returns true when a name now exists at the target.
 */
function mirrorFile(source, target) {
	try {
		linkSync(source, target);
		return true;
	} catch {
		try {
			copyFileSync(source, target);
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Mirror every regular file of one directory (no recursion).
 * @param source - absolute source directory.
 * @param target - absolute destination directory.
 * @param keep - predicate over the entry name.
 * @returns the number of mirrored files.
 */
function mirrorFlat(source, target, keep) {
	let entries;
	try {
		entries = readdirSync(source, { withFileTypes: true });
	} catch {
		return 0;
	}
	mkdirSync(target, { recursive: true });
	let count = 0;
	for (const entry of entries) {
		if (!entry.isFile() || !keep(entry.name)) continue;
		if (mirrorFile(join(source, entry.name), join(target, entry.name))) count += 1;
	}
	return count;
}

/**
 * Locate the desktop shell's directory from its executable path.
 *
 * The Host's `process.execPath` is the shell's `DeepSeek Harness.exe`, because
 * the shell starts the Host as a child process. That is why this module needs no
 * configuration.
 * @param execPath - the Host's `process.execPath`.
 * @returns the directory containing the executable.
 */
export function shellDirectory(execPath) {
	return dirname(resolve(String(execPath || '')));
}

/**
 * Copy the window program's own files into `target`.
 * @param source - the plugin's `lib/window` directory.
 * @param target - `resources/app` of the mirror.
 */
function installWindowProgram(source, target) {
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		copyFileSync(join(source, entry.name), join(target, entry.name));
	}
	// A manifest is what turns the directory into an app. The name is fixed
	// because it also names the per-window `userData` folder Electron derives
	// from it.
	writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'dsh-session-monitor-window', version: '1.0.0', main: 'main.cjs' }, null, 2));
}

/**
 * Reflect the shell's Electron runtime into `target` and install our window
 * program as its application.
 *
 * Safe to call on every open: it only re-creates `resources/app` (a handful of
 * small files) and skips mirroring files that are already named at the target.
 *
 * @param options - `{ execPath, windowDirectory, workDirectory }`.
 * @returns `{ ok:true, executable, appDirectory, userData }` or `{ ok:false, error }`.
 */
export function prepareWindowRuntime(options) {
	const execPath = String(options.execPath || '');
	const windowDirectory = resolve(String(options.windowDirectory || ''));
	const workDirectory = resolve(String(options.workDirectory || ''));

	if (!existsSync(execPath)) return { ok: false, error: 'the desktop shell executable was not found at ' + execPath };
	if (!existsSync(windowDirectory)) return { ok: false, error: 'the window program was not found at ' + windowDirectory };
	if (workDirectory === '') return { ok: false, error: 'no writable work directory for the window runtime' };

	const sourceDirectory = dirname(execPath);
	const executable = join(workDirectory, execPath.slice(execPath.lastIndexOf('\\') + 1));
	const resources = join(workDirectory, 'resources');
	const appDirectory = join(resources, 'app');
	const userData = join(workDirectory, 'user-data');
	// Written OUTSIDE `resources/app`: the app directory is re-copied on every
	// open, while this file only has to survive the launch.
	const configPath = join(workDirectory, 'window-config.json');

	try {
		mkdirSync(workDirectory, { recursive: true });

		// 1. The executable, its DLLs, and the data blobs the Electron bootstrap
		//    reads before any app code runs (`*.pak`, `icudtl.dat`, snapshots...).
		//    All of them are top-level files.
		mirrorFlat(sourceDirectory, workDirectory, (name) => !SKIP_TOP_LEVEL.has(name));

		// 2. `locales/`: Chromium refuses to start without its own locale pak.
		mirrorFlat(join(sourceDirectory, 'locales'), join(workDirectory, 'locales'), () => true);

		// 3. `resources/`: every runtime file, then the window program. The real
		//    application (`app.asar`) and the fat CLI runtime are skipped.
		const sourceResources = join(sourceDirectory, 'resources');
		if (existsSync(sourceResources)) {
			mirrorFlat(sourceResources, resources, (name) => !SKIP_RESOURCES.has(name) && (RESOURCE_FILES.has(name) || /\.(pak|bin|json|dat)$/i.test(name)));
		}

		installWindowProgram(windowDirectory, appDirectory);
		mkdirSync(userData, { recursive: true });

		if (!existsSync(executable)) return { ok: false, error: 'the mirrored shell executable is missing: ' + executable };
		return { ok: true, executable, appDirectory, userData, configPath };
	} catch (error) {
		return { ok: false, error: 'prepare the window runtime: ' + String((error && error.message) || error) };
	}
}

/**
 * Remove a prepared runtime.
 *
 * Best effort: a leftover directory in the temp folder is harmless, while a
 * failed cleanup must never break closing the window. On Windows the running
 * executable cannot be deleted, so the caller removes the runtime only after the
 * window process exited.
 * @param workDirectory - the directory returned by `prepareWindowRuntime`.
 */
export function removeWindowRuntime(workDirectory) {
	if (!workDirectory) return;
	try {
		rmSync(workDirectory, { recursive: true, force: true });
	} catch {}
}

/** Whether a path is an existing directory (`true`) — used by the checks. */
export function isDirectory(directory) {
	try {
		return statSync(directory).isDirectory();
	} catch {
		return false;
	}
}
