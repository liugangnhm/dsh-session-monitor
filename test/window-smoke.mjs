/**
 * Regression check for the detached window's generated PowerShell script.
 *
 * The script lives as a template literal inside `lib/index.js`; this check
 * extracts it exactly the way the host does (placeholder substitution plus
 * the UTF-8 BOM Windows PowerShell 5.1 needs) and parse-checks it with the
 * PowerShell language parser.
 *
 *   node test/window-smoke.mjs          # parse check only
 *   node test/window-smoke.mjs --run    # also run the window for 4 seconds
 *
 * `--run` flashes a real always-on-top window on your screen and needs a
 * state server: it starts `test/smoke-server.mjs` on 127.0.0.1:39999 and
 * points the window at it.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "lib", "index.js");
const smokeOrigin = "http://127.0.0.1:39999";

const source = readFileSync(hostPath, "utf8");
const match = source.match(/const WINDOW_SCRIPT = String\.raw`([\s\S]*?)`;/);
if (!match) {
	console.error("window-smoke: WINDOW_SCRIPT block not found in lib/index.js");
	process.exitCode = 1;
} else {
	const script =
		"\uFEFF" +
		match[1]
			.replace(/__SM_ORIGIN__/g, smokeOrigin)
			.replace(/__SM_STATE_PATH__/g, "/dsh-session-monitor/state")
			.replace(/__SM_OPEN_PATH__/g, "/dsh-session-monitor/open")
			.replace(/__SM_WINDOW_PATH__/g, "/dsh-session-monitor/window");
	const directory = mkdtempSync(join(tmpdir(), "sm-window-check-"));
	const scriptPath = join(directory, "window.ps1");
	writeFileSync(scriptPath, script, "utf8");

	const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
	const parsed = spawnSync(
		powershell,
		[
			"-NoProfile",
			"-Command",
			`$errors = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors); if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { 'PARSE ' + $_.Extent.StartLineNumber + ': ' + $_.Message }; exit 1 } else { 'ok' }`,
		],
		{ encoding: "utf8" },
	);
	const output = String(parsed.stdout || "") + String(parsed.stderr || "");
	if (parsed.status === 0 && output.includes("ok")) {
		console.log("window-smoke: generated script parses under Windows PowerShell 5.1");
	} else {
		console.error("window-smoke: generated script failed to parse:\n" + output);
		process.exitCode = 1;
	}

	if (process.argv.includes("--run") && process.platform === "win32") {
		const server = spawn(process.execPath, [join(here, "smoke-server.mjs")], { stdio: "ignore", windowsHide: true });
		await new Promise((resolve) => setTimeout(resolve, 800));
		const window = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", scriptPath, "-Origin", smokeOrigin], {
			detached: false,
			stdio: "ignore",
			windowsHide: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 4000));
		const alive = window.exitCode === null && window.signalCode === null;
		try {
			spawnSync("taskkill", ["/pid", String(window.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		} catch {}
		try {
			server.kill();
		} catch {}
		if (alive) {
			console.log("window-smoke: the window stayed up for 4s (close it if it lingered)");
		} else {
			console.error("window-smoke: the window exited early — inspect the script manually");
			process.exitCode = 1;
		}
	}
}
