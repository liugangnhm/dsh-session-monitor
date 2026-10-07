/**
 * Regression checks for the detached window program (`lib/window.ps1`).
 *
 * The window is a real PowerShell file now, not a template inside JavaScript:
 * it can be run by hand for debugging, and these checks read it directly
 * instead of scraping a string out of `lib/index.js`.
 *
 * Three guards, each pinned to a bug that actually shipped:
 *
 *  - the file keeps its UTF-8 BOM (PowerShell 5.1 reads a BOM-less .ps1 as ANSI
 *    and mangles every non-Chinese-ASCII label into mojibake);
 *  - it parses under Windows PowerShell 5.1;
 *  - every display state's row builds, and a click anywhere in a row carries
 *    the session id on both transports.
 *
 *   node test/window-check.mjs          # static checks
 *   node test/window-check.mjs --run    # also assert the ready handshake
 */
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "lib", "window.ps1");
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const smokeOrigin = "http://127.0.0.1:39999";

const failures = [];
const check = (label, condition) => {
	if (!condition) failures.push(label);
};

const raw = readFileSync(scriptPath);
const text = raw.toString("utf8");

check(
	"window.ps1 carries the UTF-8 BOM PowerShell 5.1 needs",
	raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
);
check("window.ps1 takes its endpoints as parameters", /\[string\]\$StatePath/.test(text) && /\[string\]\$OpenPath/.test(text));
check("window.ps1 handles row clicks with a bubbled event", /Add_MouseUp/.test(text));
check("window.ps1 captures the clicked row's id", /GetNewClosure\(\)/.test(text));
check("window.ps1 keeps the running pulse on a Storyboard", /RepeatBehavior\]::Forever/.test(text));
check("window.ps1 reports ready, commands and its own close", /Send "ready"/.test(text) && /Send "command"/.test(text) && /Send "closed"/.test(text));
// The header toggles must repaint on EVERY poll and show their state. A button
// that only updates when its value changed gives no feedback at all when the
// state already matches, which the user reads as "the button does nothing".
check(
	"the header toggles repaint on every poll",
	/Set-ToggleLook -Button \$filterButton/.test(text) && !/\$showAll -ne \$script:showAll/.test(text),
);
check(
	"a toggle's on state is visually distinct, not just different text",
	/function Set-ToggleLook/.test(text) && /Background = \$brush\.ConvertFromString/.test(text),
);
check("the hint carries the visible/total counts", /\$rows\.Count \+ "\/" \+ \$total/.test(text));

// Parse with the interpreter that actually runs it.
const parsed = spawnSync(
	powershell,
	[
		"-NoProfile",
		"-Command",
		`$errors = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors); if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { 'PARSE ' + $_.Extent.StartLineNumber + ': ' + $_.Message }; exit 1 } else { 'ok' }`,
	],
	{ encoding: "utf8" },
);
const parseOutput = String(parsed.stdout || "") + String(parsed.stderr || "");
check("window.ps1 parses under Windows PowerShell 5.1", parsed.status === 0 && parseOutput.includes("ok"));
if (!parseOutput.includes("ok")) console.error(parseOutput);

if (failures.length === 0) {
	// Row building and click delivery, driven through the real script.
	const posted = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			posted.push(body);
			response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			response.end('{"ok":true}');
		});
	});
	await new Promise((resolve) => server.listen(39998, "127.0.0.1", resolve));

	const rowSource = text.slice(text.indexOf("# >>> testable"), text.indexOf("# <<< testable"));
	const driver = `
Add-Type -AssemblyName PresentationFramework
$brush = [System.Windows.Media.BrushConverter]::new()
${text.slice(text.indexOf("$zh = @{"), text.indexOf("[xml]$xaml"))}
$window = New-Object System.Windows.Window
$script:sent = @()
function Send([string]$Kind, $Extra) { $script:sent += ($Kind + ":" + [string]$Extra["id"]) }
${rowSource}
$failed = 0
foreach ($state in @("running", "attention", "done", "idle", "bogus")) {
  try {
    $element = New-Row ([pscustomobject]@{ id = "row-" + $state; title = "会话 " + $state; state = $state; blank = $false })
    if ($element.Children.Count -lt 3) { $failed += 1; Write-Output ("SHORT " + $state) }
    else { Write-Output ("OK " + $state) }
  } catch {
    $failed += 1
    Write-Output ("FAIL " + $state + " -> " + $_.Exception.Message)
  }
}

# Click on a CHILD element, which is where a real click lands: it must bubble
# to the row, and the handler must still know its session id.
$row = [pscustomobject]@{ id = "click-me"; title = "点击会话"; state = "running"; blank = $false }
$element = New-Row $row
$panel = New-Object System.Windows.Controls.Grid
$panel.Children.Add($element) | Out-Null
$window.Content = $panel
$args = New-Object System.Windows.Input.MouseButtonEventArgs(
  [System.Windows.Input.Mouse]::PrimaryDevice, [Environment]::TickCount, [System.Windows.Input.MouseButton]::Left)
$args.RoutedEvent = [System.Windows.UIElement]::MouseUpEvent
$element.Children[1].RaiseEvent($args)
Write-Output ("sent=" + ($script:sent -join ","))
exit $failed
`;

	const path = join(here, "..", "..", "window-check.ps1");
	const { writeFileSync, mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const driverPath = join(mkdtempSync(join(tmpdir(), "sm-rowcheck-")), "row-check.ps1");
	writeFileSync(driverPath, "\uFEFF" + driver.replaceAll("$Origin", smokeOrigin), "utf8");

	const result = spawnSync(powershell, ["-NoProfile", "-STA", "-File", driverPath], { encoding: "utf8" });
	const output = String(result.stdout || "");
	console.log(output.trim());
	check("every display state builds a row", result.status === 0);
	check("a click on a child element carries its session id", /sent=.*open:click-me/.test(output));
	if (result.status !== 0) {
		console.error(String(result.stderr || "").split("\n").slice(0, 8).join("\n"));
	}
	server.close();
	void path;

	if (process.argv.includes("--run") && process.platform === "win32") {
		const smoke = spawn(process.execPath, [join(here, "smoke-server.mjs")], { stdio: "ignore", windowsHide: true });
		await new Promise((resolve) => setTimeout(resolve, 800));
		const window = spawn(
			powershell,
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", scriptPath, "-Origin", smokeOrigin],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		const lines = [];
		const stderrLines = [];
		createInterface({ input: window.stdout }).on("line", (line) => lines.push(line));
		createInterface({ input: window.stderr }).on("line", (line) => stderrLines.push(line));
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
			smoke.kill();
		} catch {}
	}
}

if (failures.length > 0) {
	console.error("window-check failed:");
	for (const failure of failures) console.error(" - " + failure);
	process.exitCode = 1;
} else {
	console.log("window-check passed");
}
