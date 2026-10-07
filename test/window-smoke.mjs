/**
 * Regression check for the detached window program.
 *
 * The window is a generated PowerShell script living as a template literal in
 * `lib/index.js`. This check extracts it exactly the way the host does (the
 * same placeholder substitution plus the UTF-8 BOM Windows PowerShell 5.1
 * needs), parse-checks it, and — with `--run` — starts it against a mock state
 * server to assert the readiness handshake.
 *
 * The handshake is the point: the first version of this window reported a
 * successful spawn while the PowerShell process exited before any window
 * existed. `ready` on stdout is the only honest proof that a window is up.
 *
 *   node test/window-smoke.mjs          # parse check only
 *   node test/window-smoke.mjs --run    # also assert the ready handshake
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "lib", "index.js");
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const smokeOrigin = "http://127.0.0.1:39999";

const failures = [];
const check = (label, condition) => {
	if (!condition) failures.push(label);
};

const source = readFileSync(hostPath, "utf8");
const match = source.match(/const WINDOW_SCRIPT = String\.raw`([\s\S]*?)`;/);

if (!match) {
	check("WINDOW_SCRIPT template is present in lib/index.js", false);
} else {
	const script =
		"\uFEFF" +
		match[1]
			.replace(/__SM_ORIGIN__/g, smokeOrigin)
			.replace(/__SM_STATE_PATH__/g, "/dsh-session-monitor/state");
	const directory = mkdtempSync(join(tmpdir(), "sm-window-check-"));
	const scriptPath = join(directory, "window.ps1");
	writeFileSync(scriptPath, script, "utf8");

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
	check("generated script parses under Windows PowerShell 5.1", parsed.status === 0 && output.includes("ok"));
	if (!output.includes("ok")) console.error(output);

	if (process.argv.includes("--run") && process.platform === "win32") {
		const server = spawn(process.execPath, [join(here, "smoke-server.mjs")], { stdio: "ignore", windowsHide: true });
		await new Promise((resolve) => setTimeout(resolve, 800));

		const window = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", scriptPath, "-Origin", smokeOrigin], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const lines = [];
		const stderrLines = [];
		createInterface({ input: window.stdout }).on("line", (line) => lines.push(line));
		createInterface({ input: window.stderr }).on("line", (line) => stderrLines.push(line));

		// The window reports `ready` once its WPF content actually rendered.
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			if (lines.some((line) => line.includes('"kind":"ready"'))) break;
			if (window.exitCode !== null) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		const ready = lines.some((line) => line.includes('"kind":"ready"'));
		check("the window reports ready (a real window exists)", ready);
		if (!ready) {
			console.error("window stdout:", lines.join("\n") || "(nothing)");
			console.error("window stderr:", stderrLines.join("\n") || "(nothing)");
		}
		try {
			spawnSync("taskkill", ["/pid", String(window.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		} catch {}
		try {
			server.kill();
		} catch {}
	}
}

if (failures.length > 0) {
	console.error("window-smoke failed:");
	for (const failure of failures) console.error(" - " + failure);
	process.exitCode = 1;
} else {
	console.log("window-smoke: generated script parses" + (process.argv.includes("--run") ? " and reports ready" : ""));
}
