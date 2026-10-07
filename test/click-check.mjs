/**
 * Regression check for row clicks.
 *
 * Clicking a row must hand the Host the session id — by two transports
 * (a stdout `open` line and a loopback POST), because a click that silently
 * does nothing is the worst failure mode this plugin has had.
 *
 * It runs the generated script's real `New-Row`, replaces `Send` with a
 * recorder, stands up a throwaway HTTP listener in place of the Host, then
 * raises a genuine `MouseLeftButtonUp` routed event on the row.
 *
 * Raising the event (rather than fetching a delegate off the element) is the
 * point: it exercises WPF's own routing, which is what a real click does.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "index.js"), "utf8");
const match = source.match(/const WINDOW_SCRIPT = String\.raw`([\s\S]*?)`;/);

const failures = [];
const check = (label, condition) => {
	if (!condition) failures.push(label);
};

if (!match) {
	check("WINDOW_SCRIPT is present in lib/index.js", false);
} else {
	const script = match[1];
	const slice = script.slice(script.indexOf("$zh = @{"), script.indexOf("function Update-List"));

	// A stand-in Host: records what the click posts.
	const posted = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			posted.push(body);
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"ok":true}');
		});
	});
	await new Promise((resolve) => server.listen(39998, "127.0.0.1", resolve));

	const driver = `
Add-Type -AssemblyName PresentationFramework
$brush = [System.Windows.Media.BrushConverter]::new()
$window = New-Object System.Windows.Window

# Intercept the stdout transport instead of writing to a pipe.
$script:sent = @()
function Send([string]$Kind, $Extra) {
  $script:sent += ($Kind + ":" + [string]$Extra["id"])
}

${slice}
$row = [pscustomobject]@{ id = "session-abc123"; title = "测试会话"; state = "running"; blank = $false }
$element = New-Row $row

# Give the visual a parent so WPF routing can run, then click for real.
# ($Host is a read-only PowerShell variable, hence the name.)
$panel = New-Object System.Windows.Controls.Grid
$panel.Children.Add($element) | Out-Null
$window.Content = $panel

# Raise the click ON A CHILD (the label), which is where a real click lands:
# the row must still receive it. A direct routed event (MouseLeftButtonUp)
# would stop at the child - that was the original "clicking does nothing".
$child = $element.Children[1]
$eventArgs = New-Object System.Windows.Input.MouseButtonEventArgs(
  [System.Windows.Input.Mouse]::PrimaryDevice, [Environment]::TickCount, [System.Windows.Input.MouseButton]::Left)
$eventArgs.RoutedEvent = [System.Windows.UIElement]::MouseUpEvent
$child.RaiseEvent($eventArgs)

Write-Output ("stdout=" + ($script:sent -join ","))
`;

	const path = join(tmpdir(), "sm-clickcheck.ps1");
	writeFileSync(path, "\uFEFF" + driver.replace(/__SM_ORIGIN__/g, "http://127.0.0.1:39998"), "utf8");
	const result = spawnSync(
		"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		["-NoProfile", "-STA", "-File", path],
		{ encoding: "utf8" },
	);
	const output = String(result.stdout || "");
	const stdoutLine = /stdout=(.*)/.exec(output);
	const stderr = String(result.stderr || "").trim();

	// The stdout line is the primary transport and the one this check can
	// observe without a WPF message pump (Invoke-WebRequest needs the
	// dispatcher, which a headless parse run does not have).
	check("a click on a child row element reaches the row's handler", !!stdoutLine && stdoutLine[1].includes("open:session-abc123"));

	if (failures.length > 0) {
		if (stdoutLine) console.error("stdout transport:", stdoutLine[1] || "(nothing)");
		console.error("posted bodies:", posted.join(" | ") || "(none - expected without a message pump)");
		if (stderr) console.error("stderr:", stderr.split("\n").slice(0, 6).join("\n"));
	}

	server.close();
}

if (failures.length > 0) {
	console.error("click-check failed:");
	for (const failure of failures) console.error(" - " + failure);
	process.exitCode = 1;
} else {
	console.log("click-check passed (a click anywhere in a row carries its session id)");
}
