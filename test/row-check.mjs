/**
 * Regression check for the window's row builder across every display state.
 *
 * `New-Row` builds one row per session. It used to throw on the running state
 * (`RepeatMode` is not settable through PowerShell's dynamic member lookup),
 * and `Update-List` wrapped the whole loop in a `catch` — so a single running
 * session produced an empty window, incremented the orphan guard ten times,
 * and closed the window a few seconds after it appeared. Nothing was logged
 * anywhere, which is why this check exists: it calls the builder directly and
 * reports the exception instead of swallowing it.
 *
 * The builder is extracted from `lib/index.js` the same way the host and the
 * window smoke test do it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "index.js"), "utf8");
const match = source.match(/const WINDOW_SCRIPT = String\.raw`([\s\S]*?)`;/);

if (!match) {
	console.error("row-check: WINDOW_SCRIPT not found in lib/index.js");
	process.exitCode = 1;
} else {
	// Everything from the dictionary block through the end of New-Row, plus a
	// driver that builds one row per display state, including an unknown one.
	const script = match[1];
	const from = script.indexOf("$zh = @{");
	const to = script.indexOf("function Update-List");
	const slice = script.slice(from, to);

	const driver = `
Add-Type -AssemblyName PresentationFramework
$brush = [System.Windows.Media.BrushConverter]::new()
$window = New-Object System.Windows.Window
${slice}
$rows = @(
  [pscustomobject]@{ id = "s1"; title = "运行中的会话"; state = "running"; blank = $false },
  [pscustomobject]@{ id = "s2"; title = "等待审批的会话"; state = "attention"; blank = $false },
  [pscustomobject]@{ id = "s3"; title = "已完成的会话"; state = "done"; blank = $false },
  [pscustomobject]@{ id = "s4"; title = "空闲的会话"; state = "idle"; blank = $true },
  [pscustomobject]@{ id = "s5"; title = "未知状态的会话"; state = "bogus"; blank = $false }
)
$failed = 0
foreach ($row in $rows) {
  try {
    $element = New-Row $row
    if ($element.Children.Count -lt 3) { $failed += 1; Write-Output ("SHORT " + $row.state) }
    else { Write-Output ("OK   " + $row.state) }
  } catch {
    $failed += 1
    Write-Output ("FAIL " + $row.state + " -> " + $_.Exception.Message)
  }
}
exit $failed
`;

	const path = join(tmpdir(), "sm-rowcheck.ps1");
	writeFileSync(path, "\uFEFF" + driver, "utf8");
	const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-STA", "-File", path], {
		encoding: "utf8",
	});
	const output = String(result.stdout || "").trim();
	const stderr = String(result.stderr || "").trim();
	console.log(output);
	if (result.status !== 0) {
		console.error("row-check failed: the row builder threw or produced short rows");
		if (stderr) console.error(stderr);
		process.exitCode = 1;
	} else {
		console.log("row-check passed (every display state renders a row)");
	}
}
