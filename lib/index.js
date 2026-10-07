/**
 * dsh-session-monitor, node half.
 *
 * Two jobs:
 *
 * 1. UI carrier — the same pattern as the shipped
 *    `@deepseek-ai/dsh-client-ui-open-in-app`: this entry puts a Loader row in
 *    the tree so the browser half, discovered through the package's
 *    `dsh.client` declaration and served from `exports["./client"]`, reaches
 *    the page.
 *
 * 2. The detached window. The browser half runs inside a sandboxed iframe in
 *    the desktop app, where Document Picture-in-Picture fails ("Internal error:
 *    no window") and `window.open` is blocked; the Host is only a plain-Node
 *    child of the app's main process, so `require('electron')` does not resolve
 *    either. On Windows the window is therefore a generated PowerShell WPF
 *    window: frameless, always-on-top, spawned with `node:child_process`.
 *
 * The window speaks a line-delimited JSON protocol on stdout (`ready`, `pong`,
 * `open`, `closed`) and reads its data by polling `GET /state`, which the
 * browser half keeps pushing. The Host answers a detach request only after the
 * window reported `ready` — a spawn that produces no window is reported as a
 * failure instead of a success.
 *
 * @module dsh-session-monitor
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Cordis function-plugin name. */
export const name = 'session-monitor';

/** Loopback routes under one prefix. */
const ROUTE = '/dsh-session-monitor';

/** Windows PowerShell, absolute (the path never moves on Windows). */
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Where the state endpoint lives, for the generated window script. */
const STATE_PATH = `${ROUTE}/state`;
const WINDOW_PATH = `${ROUTE}/window`;

/** Line protocol shared with the generated script. */
const PROTOCOL_VERSION = 1;
/** How long a fresh window gets to report `ready` before it counts as failed. */
const READY_TIMEOUT_MS = 3000;

/**
 * The detached-window program: a frameless always-on-top WPF window that
 * renders the session snapshot from the state route and reports its own
 * lifecycle as JSON lines on stdout. `__SM_ORIGIN__` is replaced with the
 * opener's origin right before the script is written to disk.
 */
const WINDOW_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$Origin,
  [string]$Lang = "zh"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework

$script:out = [Console]::Out
function Send([string]$Kind, $Extra) {
  try {
    $message = [ordered]@{
      protocolVersion = 1
      kind = $Kind
      timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    if ($Extra) { foreach ($key in $Extra.Keys) { $message[$key] = $Extra[$key] } }
    $script:out.WriteLine(($message | ConvertTo-Json -Compress))
    $script:out.Flush()
  } catch {
    # A broken stdout pipe means the Host is gone; the poll watchdog closes us.
  }
}

$zh = @{
  Title = "DSH 会话监控"
  Empty = "暂无活跃会话"
  Hint = "点击会话跳转 · 窗口始终置顶"
  States = @{ running = "运行中"; attention = "待处理"; done = "已完成"; idle = "空闲" }
}
$en = @{
  Title = "DSH Sessions"
  Empty = "No active sessions"
  Hint = "Click a session to open · always on top"
  States = @{ running = "Running"; attention = "Needs you"; done = "Done"; idle = "Idle" }
}
$L = if ($Lang -eq "en") { $en } else { $zh }
$tones = @{ running = "#FF8AB4F8"; attention = "#FFFDD663"; done = "#FF81C995"; idle = "#FF9AA0A6" }
$brush = [System.Windows.Media.BrushConverter]::new()

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="340" Height="480" MinWidth="240" MinHeight="180"
        WindowStartupLocation="Manual"
        WindowStyle="None" ResizeMode="CanResize" Topmost="True" ShowInTaskbar="False"
        Background="#FF202124" Foreground="#FFE8EAED" FontFamily="Segoe UI" TextOptions.TextFormattingMode="Display">
  <Border BorderBrush="#FF3C4043" BorderThickness="1">
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="36"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="24"/>
      </Grid.RowDefinitions>
      <Grid Grid.Row="0" Background="#FF292A2D" x:Name="Header">
        <TextBlock x:Name="TitleText" Text="" Foreground="#FFE8EAED" FontSize="12" Margin="10,0" VerticalAlignment="Center"/>
        <Button x:Name="CloseButton" Content="&#215;" HorizontalAlignment="Right" Width="30" Height="22" Margin="0,0,6,0"
                Background="Transparent" Foreground="#FFE8EAED" BorderThickness="0" FontSize="14" Cursor="Hand" Focusable="False"/>
      </Grid>
      <ScrollViewer Grid.Row="1" VerticalScrollBarVisibility="Auto" Padding="0,4">
        <StackPanel x:Name="List"/>
      </ScrollViewer>
      <ResizeGrip Grid.Row="1" Width="14" Height="14" HorizontalAlignment="Right" VerticalAlignment="Bottom" Opacity="0.5"/>
      <TextBlock Grid.Row="2" x:Name="HintText" Text="" Foreground="#FF9AA0A6" FontSize="11" Margin="10,0" VerticalAlignment="Center"/>
    </Grid>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$titleText = $window.FindName("TitleText")
$hintText = $window.FindName("HintText")
$closeButton = $window.FindName("CloseButton")
$header = $window.FindName("Header")
$list = $window.FindName("List")

$titleText.Text = $L.Title
$hintText.Text = $L.Hint
$work = [System.Windows.SystemParameters]::WorkArea
$window.Left = $work.Width - $window.Width - 24
$window.Top = 64

$script:signature = ""
$script:failures = 0

function New-Row($row) {
  $state = "idle"
  if ($row.state -and $L.States.ContainsKey([string]$row.state)) { $state = [string]$row.state }
  $grid = New-Object System.Windows.Controls.Grid
  $grid.Margin = New-Object System.Windows.Thickness 8, 3, 8, 3
  $grid.Cursor = [System.Windows.Input.Cursors]::Hand
  foreach ($spec in @(@(20), @(1, "Star"), @("Auto"))) {
    $column = New-Object System.Windows.Controls.ColumnDefinition
    if ($spec[0] -eq 1) { $column.Width = New-Object System.Windows.GridLength $spec[0], $spec[1] }
    else { $column.Width = $spec[0] }
    $grid.ColumnDefinitions.Add($column) | Out-Null
  }
  $dot = New-Object System.Windows.Shapes.Ellipse
  $dot.Width = 8
  $dot.Height = 8
  $dot.VerticalAlignment = "Center"
  $dot.Fill = $brush.ConvertFromString($tones[$state])
  if ($state -eq "running") {
    $pulse = New-Object System.Windows.Media.Animation.DoubleAnimation(0.35, 1.0, (New-Object System.Windows.Duration ([TimeSpan]::FromSeconds(0.6))))
    $pulse.AutoReverse = $true
    $pulse.RepeatMode = "Forever"
    $dot.BeginAnimation([System.Windows.Shapes.Shape]::OpacityProperty, $pulse)
  }
  [System.Windows.Controls.Grid]::SetColumn($dot, 0)
  $grid.AddChild($dot)
  $label = New-Object System.Windows.Controls.TextBlock
  $label.Text = [string]$row.title
  $label.Margin = New-Object System.Windows.Thickness 8, 0, 8, 0
  $label.VerticalAlignment = "Center"
  $label.TextTrimming = "CharacterEllipsis"
  if ($row.blank -eq $true) { $label.Foreground = $brush.ConvertFromString("#FF9AA0A6") }
  [System.Windows.Controls.Grid]::SetColumn($label, 1)
  $grid.AddChild($label)
  $stateText = New-Object System.Windows.Controls.TextBlock
  $stateText.Text = $L.States[$state]
  $stateText.FontSize = 11
  $stateText.VerticalAlignment = "Center"
  $stateText.Foreground = $brush.ConvertFromString($tones[$state])
  [System.Windows.Controls.Grid]::SetColumn($stateText, 2)
  $grid.AddChild($stateText)
  $grid.Add_MouseLeftButtonUp({
    param($sender, $event)
    Send "open" @{ id = [string]$row.id }
  })
  return $grid
}

function Update-List {
  try {
    $response = Invoke-WebRequest -Uri ($Origin + "__SM_STATE_PATH__") -Method GET -TimeoutSec 4 -UseBasicParsing
    $script:failures = 0
    $data = $response.Content | ConvertFrom-Json
    $rows = @()
    if ($data.rows) { $rows = @($data.rows) }
    $signature = (($rows | ForEach-Object { [string]$_.id + ":" + [string]$_.state }) -join "|")
    if ($signature -eq $script:signature) { return }
    $script:signature = $signature
    $list.Children.Clear()
    if ($rows.Count -eq 0) {
      $empty = New-Object System.Windows.Controls.TextBlock
      $empty.Text = $L.Empty
      $empty.Foreground = $brush.ConvertFromString("#FF9AA0A6")
      $empty.HorizontalAlignment = "Center"
      $empty.Margin = New-Object System.Windows.Thickness 0, 16, 0, 0
      $list.AddChild($empty)
      return
    }
    foreach ($row in $rows) { $list.AddChild((New-Row $row)) }
  } catch {
    # Ten consecutive failures mean the Host is gone: close instead of orphaning.
    $script:failures += 1
    if ($script:failures -ge 10) { $window.Close() }
  }
}

$stateTimer = New-Object System.Windows.Threading.DispatcherTimer
$stateTimer.Interval = [TimeSpan]::FromSeconds(1)
$stateTimer.Add_Tick({ Update-List })
$stateTimer.Start()

$pongTimer = New-Object System.Windows.Threading.DispatcherTimer
$pongTimer.Interval = [TimeSpan]::FromSeconds(5)
$pongTimer.Add_Tick({ Send "pong" $null })
$pongTimer.Start()

$header.Add_MouseLeftButtonDown({
  param($sender, $event)
  if ($event.OriginalSource -isnot [System.Windows.Controls.Button]) {
    try { $window.DragMove() } catch {}
  }
})
$closeButton.Add_Click({ $window.Close() })
# The readiness handshake is the Host's proof that a window really exists.
$window.Add_ContentRendered({ Send "ready" $null })
$window.Add_Closed({
  $stateTimer.Stop()
  $pongTimer.Stop()
  Send "closed" $null
  [Environment]::Exit(0)
})

Update-List
$window.ShowDialog() | Out-Null
`;

/** Only loopback callers may use these routes; they expose host internals. */
function isLocalRequest(request) {
	const host = String((request && request.headers && request.headers.host) || '');
	return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host.startsWith('[::1]:');
}

/**
 * Pick the origin the window must poll for state.
 *
 * The request's own Host header wins: it is the address the browser half just
 * reached this Host through, so the window can reach it by construction. The
 * client's `location.origin` is only a fallback, because the browser half runs
 * inside a sandboxed iframe where that value is the literal string `"null"` —
 * handing that to the window made every state poll fail, and the window's
 * orphan guard closed it a few seconds after it appeared.
 *
 * @param request - the incoming window-control request.
 * @param provided - the browser half's reported origin, if any.
 * @returns an `http://host[:port]` origin, or an empty string when neither
 *   source yields one (the caller must refuse to open a window then).
 */
function resolveWindowOrigin(request, provided) {
	const candidate = typeof provided === 'string' ? provided.trim().replace(/\/+$/, '') : '';
	if (/^https?:\/\/[^\s/]+$/i.test(candidate)) return candidate;
	const host = String((request && request.headers && request.headers.host) || '').trim();
	if (host !== '' && /^[^\s/]+$/.test(host)) return `http://${host}`;
	return '';
}

/** Read one JSON request body, capped, rejecting on malformed input. */
function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		let raw = '';
		request.on('data', (chunk) => {
			raw += chunk;
			if (raw.length > 1e6) {
				reject(new Error('body too large'));
				request.destroy();
			}
		});
		request.on('end', () => {
			if (!raw) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch (error) {
				reject(error);
			}
		});
		request.on('error', reject);
	});
}

/** Coerce one browser-half snapshot into the window's row shape. */
function normalizeState(state) {
	const rows = Array.isArray(state && state.rows)
		? state.rows.map((row) => ({
				id: String(row.id),
				title: typeof row.title === 'string' && row.title !== '' ? row.title : String(row.id),
				state: typeof row.state === 'string' ? row.state : 'idle',
				blank: row.blank === true,
				updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
			}))
		: [];
	return {
		rows,
		runningCount: typeof (state && state.runningCount) === 'number' ? state.runningCount : 0,
		showAll: !!(state && state.showAll),
		totalCount: typeof (state && state.totalCount) === 'number' ? state.totalCount : rows.length,
	};
}

// --- the detached window ----------------------------------------------------------

let windowChild = null;
/** True once the window reported `ready`; the honest "a window exists" fact. */
let windowReady = false;
let windowState = { rows: [], runningCount: 0, showAll: false, totalCount: 0 };
/** Last stderr lines, quoted back when a window fails to come up. */
const windowStderr = [];
/** Resolvers waiting for the readiness handshake. */
let readyWaiters = [];
/** Session ids a window asked to open, drained by the browser half. */
const pendingOpens = [];

/** Read one protocol line from the window's stdout. */
function handleWindowLine(line) {
	if (!line || !line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (!message || message.protocolVersion !== PROTOCOL_VERSION) return;
	if (message.kind === 'ready') {
		windowReady = true;
		const waiters = readyWaiters;
		readyWaiters = [];
		for (const resolve of waiters) resolve(true);
		return;
	}
	if (message.kind === 'pong') return;
	if (message.kind === 'open') {
		if (typeof message.id === 'string' && message.id !== '') pendingOpens.push(message.id);
		return;
	}
	if (message.kind === 'closed') {
		windowReady = false;
	}
}

/** Resolve every readiness waiter with the given outcome. */
function settleReady(value) {
	if (readyWaiters.length === 0) return;
	const waiters = readyWaiters;
	readyWaiters = [];
	for (const resolve of waiters) resolve(value);
}

/** Wait for the readiness handshake, bounded by the caller's patience. */
function waitForReady(timeoutMs) {
	if (windowReady) return Promise.resolve(true);
	return new Promise((resolve) => {
		readyWaiters.push(resolve);
		const timer = setTimeout(() => {
			readyWaiters = readyWaiters.filter((waiter) => waiter !== resolve);
			resolve(false);
		}, timeoutMs);
		timer.unref?.();
	});
}

/** One report for the browser half's diagnostics and path choice. */
function environmentReport() {
	const powershell = process.platform === 'win32' && existsSync(POWERSHELL);
	return {
		ok: true,
		desktop: typeof process.versions.electron === 'string',
		electronRuntime: typeof process.versions.electron === 'string' ? process.versions.electron : null,
		platform: process.platform,
		powershell,
		open: windowReady,
		reason: powershell ? '' : process.platform === 'win32' ? 'powershell not found' : 'native window is Windows-only',
	};
}

/**
 * Spawn the always-on-top WPF window and wait for its readiness handshake.
 *
 * `detached` is deliberately absent: a detached PowerShell with no console of
 * its own exits before the WPF message loop starts (measured, exit code 0),
 * which is exactly the "spawn reported ok, no window appeared" failure.
 */
async function openWindow(origin) {
	if (windowChild && windowReady) return { ok: true, open: true, mode: 'powershell' };
	if (windowChild) {
		// A previous attempt is still starting: reuse its handshake.
		const ready = await waitForReady(READY_TIMEOUT_MS);
		if (ready) return { ok: true, open: true, mode: 'powershell' };
		closeWindow();
	}
	if (process.platform !== 'win32' || !existsSync(POWERSHELL)) {
		return { ok: false, open: false, error: 'native window unavailable: ' + environmentReport().reason };
	}
	let scriptPath;
	try {
		const directory = mkdtempSync(join(tmpdir(), 'sm-window-'));
		scriptPath = join(directory, 'window.ps1');
		const script = WINDOW_SCRIPT.replace(/__SM_ORIGIN__/g, String(origin || '')).replace(
			/__SM_STATE_PATH__/g,
			STATE_PATH,
		);
		// The BOM is load-bearing: Windows PowerShell 5.1 reads a BOM-less
		// .ps1 as ANSI and mangles every non-ASCII label in the script.
		writeFileSync(scriptPath, '\uFEFF' + script, 'utf8');
	} catch (error) {
		return { ok: false, open: false, error: 'window script: ' + String((error && error.message) || error) };
	}
	windowStderr.length = 0;
	let child;
	try {
		child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath, '-Origin', String(origin || '')], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
	} catch (error) {
		return { ok: false, open: false, error: 'spawn powershell: ' + String((error && error.message) || error) };
	}
	windowChild = child;
	windowReady = false;
	child.stdin?.on('error', () => {});
	child.stdout?.on('error', () => {});
	child.stderr?.on('error', () => {});
	createInterface({ input: child.stdout }).on('line', handleWindowLine);
	createInterface({ input: child.stderr }).on('line', (line) => {
		const text = String(line || '').trim();
		if (!text) return;
		windowStderr.push(text);
		if (windowStderr.length > 8) windowStderr.shift();
	});
	child.on('error', (error) => {
		if (windowChild === child) {
			windowChild = null;
			windowReady = false;
		}
		windowStderr.push(String((error && error.message) || error));
		settleReady(false);
	});
	child.on('exit', () => {
		if (windowChild === child) {
			windowChild = null;
			windowReady = false;
		}
		settleReady(false);
	});

	const ready = await waitForReady(READY_TIMEOUT_MS);
	if (!ready) {
		const detail = windowStderr.length > 0 ? windowStderr.join(' | ') : 'no readiness handshake';
		closeWindow();
		return { ok: false, open: false, error: 'window did not start: ' + detail };
	}
	return { ok: true, open: true, mode: 'powershell' };
}

/** Close the detached window, however it is still alive. */
function closeWindow() {
	const child = windowChild;
	windowChild = null;
	windowReady = false;
	settleReady(false);
	if (child && child.pid) {
		try {
			spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
		} catch {}
	}
}

// --- routes ---------------------------------------------------------------------

/**
 * Host plugin body: register the window-control routes once the webServer is
 * composed. `ctx.inject` waits for the service instead of reading it at
 * effect time, when the base layer has not published it yet.
 * @param ctx - host root context.
 */
export function apply(ctx) {
	ctx.inject(['webServer'], (hostCtx) => {
		hostCtx.effect(() => {
			const webServer = hostCtx.get('webServer');
			if (!webServer || typeof webServer.register !== 'function') return;
			const disposers = [];
			const register = (path, handler) => {
				disposers.push(webServer.register({ kind: 'exact', path, handler }));
			};
			const sendJson = (response, code, payload) => {
				response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
				response.end(JSON.stringify(payload));
			};

			register(`${ROUTE}/probe`, (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				sendJson(response, 200, environmentReport());
			});

			register(WINDOW_PATH, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					if (body.action === 'close') {
						closeWindow();
						return sendJson(response, 200, { ok: true, open: false });
					}
					if (body.state) windowState = normalizeState(body.state);
					const origin = resolveWindowOrigin(request, body.origin);
					if (origin === '') {
						return sendJson(response, 200, { ok: false, open: false, error: 'no reachable origin for the window' });
					}
					const result = await openWindow(origin);
					return sendJson(response, 200, result);
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			register(STATE_PATH, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method === 'GET') {
					return sendJson(response, 200, { ok: true, ...windowState, open: windowReady });
				}
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'GET, POST' });
				try {
					const body = await readJsonBody(request);
					if (body.state) windowState = normalizeState(body.state);
					return sendJson(response, 200, { ok: true });
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			register(`${ROUTE}/pending`, (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				sendJson(response, 200, { ok: true, items: pendingOpens.slice(), open: windowReady });
			});

			register(`${ROUTE}/consume`, async (request, response) => {
				if (!isLocalRequest(request)) return sendJson(response, 403, { ok: false, message: 'forbidden' });
				if (request.method !== 'POST') return sendJson(response, 405, { allow: 'POST' });
				try {
					const body = await readJsonBody(request);
					const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
					for (let index = pendingOpens.length - 1; index >= 0; index -= 1) {
						if (ids.includes(pendingOpens[index])) pendingOpens.splice(index, 1);
					}
					return sendJson(response, 200, { ok: true });
				} catch (error) {
					return sendJson(response, 400, { ok: false, error: String((error && error.message) || error) });
				}
			});

			return () => {
				for (const dispose of disposers) {
					try {
						dispose();
					} catch {}
				}
				closeWindow();
			};
		}, 'session-monitor: window routes');
	});
}
