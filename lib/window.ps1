<#
  dsh-session-monitor - detached always-on-top window.

  Started by the plugin's Host half (lib/index.js) with node:child_process and
  driven over stdout as line-delimited JSON:

    ready    the WPF content rendered; this is the Host's proof a window exists
    pong     heartbeat answer (every 5s)
    open     a row was clicked: { id }
    command  a header button was clicked: { action: toggle-filter | toggle-notify }
    children a parent's twisty was clicked: { action: toggle-children, id }
    closed   the window is going away

  It reads its data from the Host's loopback routes, passed in as parameters so
  this file can also be run by hand for debugging:

    powershell -NoProfile -ExecutionPolicy Bypass -STA -File lib/window.ps1 `
      -Origin http://127.0.0.1:19387

  NOTE: this file must keep its UTF-8 BOM. Windows PowerShell 5.1 reads a
  BOM-less script as ANSI and mangles every non-ASCII label; the Host checks
  the BOM and runs a repaired copy from temp if an editor ever strips it.
#>
param(
  [Parameter(Mandatory = $true)][string]$Origin,
  [string]$StatePath = "/dsh-session-monitor/state",
  [string]$OpenPath = "/dsh-session-monitor/open",
  [string]$CommandPath = "/dsh-session-monitor/command",
  [string]$Lang = "zh"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework

$script:out = [Console]::Out

<#
  Write one protocol line. A broken stdout pipe means the Host is gone; the
  poll watchdog closes the window in that case.
#>
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
  }
}

$zh = @{
  Title = "DSH 会话监控"
  Empty = "暂无活跃会话"
  EmptyAll = "暂无会话"
  Hint = "点击会话跳转 · 窗口始终置顶"
  # The label states the view that is ON, and the count makes the switch
  # verifiable: "活跃 1/215" is a fact the user can check at a glance.
  FilterActive = "活跃"
  FilterAll = "全部"
  NotifyOn = "通知开"
  NotifyOff = "通知关"
  OpacityTip = "背景透明度（只影响背景，文字保持清晰）"
  States = @{ running = "运行中"; attention = "待处理"; done = "已完成"; idle = "空闲" }
}
$en = @{
  Title = "DSH Sessions"
  Empty = "No active sessions"
  EmptyAll = "No sessions"
  Hint = "Click a session to open · always on top"
  FilterActive = "Active"
  FilterAll = "All"
  NotifyOn = "Notify"
  NotifyOff = "Muted"
  OpacityTip = "Background opacity (background only; text stays sharp)"
  States = @{ running = "Running"; attention = "Needs you"; done = "Done"; idle = "Idle" }
}
$L = if ($Lang -eq "en") { $en } else { $zh }
$tones = @{ running = "#FF8AB4F8"; attention = "#FFFDD663"; done = "#FF81C995"; idle = "#FF9AA0A6" }
$brush = [System.Windows.Media.BrushConverter]::new()

# The window chrome is translucent (see AllowsTransparency below); the panel
# surface itself is painted from this base color at the state's alpha, so only
# the background fades while labels, dots and borders keep full contrast.
$surfaceRgb = @(0x20, 0x21, 0x24)
$surfaceBorder = "#FF3C4043"

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="340" Height="480" MinWidth="260" MinHeight="180"
        WindowStartupLocation="Manual"
        WindowStyle="None" ResizeMode="CanResize" Topmost="True" ShowInTaskbar="False"
        AllowsTransparency="True" Background="#00000000"
        Foreground="#FFE8EAED" FontFamily="Segoe UI" TextOptions.TextFormattingMode="Display">
  <Border x:Name="Shell" BorderBrush="#FF3C4043" BorderThickness="1" CornerRadius="8" Background="#FF202124">
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="36"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="24"/>
      </Grid.RowDefinitions>
      <Grid Grid.Row="0" Background="#FF292A2D">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <TextBlock Grid.Column="0" x:Name="DragArea" Text="" Foreground="#FFE8EAED" FontSize="12" Margin="10,0" VerticalAlignment="Center" Background="Transparent"/>
        <StackPanel Grid.Column="1" Orientation="Horizontal" Margin="0,0,4,0" VerticalAlignment="Center">
          <Button x:Name="FilterButton" Content="" Width="46" Height="22" Margin="0,0,4,0"
                  Background="Transparent" Foreground="#FF8AB4F8" BorderThickness="1" BorderBrush="#FF3C4043"
                  FontSize="11" Cursor="Hand" Focusable="False"/>
          <Button x:Name="NotifyButton" Content="" Width="52" Height="22" Margin="0,0,4,0"
                  Background="Transparent" Foreground="#FF81C995" BorderThickness="1" BorderBrush="#FF3C4043"
                  FontSize="11" Cursor="Hand" Focusable="False"/>
          <Button x:Name="CloseButton" Content="&#215;" Width="28" Height="22"
                  Background="Transparent" Foreground="#FFE8EAED" BorderThickness="0" FontSize="14" Cursor="Hand" Focusable="False"/>
        </StackPanel>
      </Grid>
      <ScrollViewer Grid.Row="1" VerticalScrollBarVisibility="Auto" Padding="0,4">
        <StackPanel x:Name="List"/>
      </ScrollViewer>
      <ResizeGrip Grid.Row="1" Width="14" Height="14" HorizontalAlignment="Right" VerticalAlignment="Bottom" Opacity="0.5"/>
      <Grid Grid.Row="2">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <TextBlock Grid.Column="0" x:Name="HintText" Text="" Foreground="#FF9AA0A6" FontSize="11" Margin="10,0" VerticalAlignment="Center"/>
        <StackPanel Grid.Column="1" Orientation="Horizontal" Margin="0,0,8,0" VerticalAlignment="Center">
          <Slider x:Name="OpacitySlider" Width="64" Height="16" Minimum="0.2" Maximum="1" Value="1"
                  VerticalAlignment="Center" Focusable="False" IsMoveToPointEnabled="True"/>
          <TextBlock x:Name="OpacityText" Text="100%" Foreground="#FF9AA0A6" FontSize="11"
                     Width="34" Margin="6,0,0,0" VerticalAlignment="Center" TextAlignment="Right"/>
        </StackPanel>
      </Grid>
    </Grid>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$dragArea = $window.FindName("DragArea")
$hintText = $window.FindName("HintText")
$closeButton = $window.FindName("CloseButton")
$filterButton = $window.FindName("FilterButton")
$notifyButton = $window.FindName("NotifyButton")
$list = $window.FindName("List")
$shell = $window.FindName("Shell")
$opacitySlider = $window.FindName("OpacitySlider")
$opacityText = $window.FindName("OpacityText")

$dragArea.Text = $L.Title
$hintText.Text = $L.Hint
$filterButton.Content = $L.FilterActive
$notifyButton.Content = $L.NotifyOn
$opacitySlider.ToolTip = $L.OpacityTip
# A real title even though the frame is borderless: it is what lets a user (and
# any window-finding tool, including this package's own checks) identify the
# window in a task list or an automation probe.
$window.Title = $L.Title
$work = [System.Windows.SystemParameters]::WorkArea
$window.Left = $work.Width - $window.Width - 24
$window.Top = 64

$script:signature = ""
$script:failures = 0
$script:showAll = $false
$script:notifyOn = $true
# True while a poll is programmatically moving the slider, so ValueChanged can
# tell an incoming setting from a user drag.
$script:syncingOpacity = $false

<#
  Paint the panel surface at one background alpha.

  Only `$shell.Background` carries the alpha. Every label, dot and border keeps
  its own opaque brush, which is what makes a see-through panel still readable;
  the window itself is transparent (AllowsTransparency) so the faded surface is
  what the desktop shows through.
#>
function Set-PanelAlpha([double]$Alpha) {
  $clamped = [Math]::Min(1.0, [Math]::Max(0.2, $Alpha))
  $byte = [byte][Math]::Round($clamped * 255)
  $shell.Background = $brush.ConvertFromString(("#{0:X2}{1:X2}{2:X2}{3:X2}" -f $byte, $surfaceRgb[0], $surfaceRgb[1], $surfaceRgb[2]))
  $opacityText.Text = ("{0}%" -f [int][Math]::Round($clamped * 100))
  return $clamped
}

<#
  Report a header action to the Host. The browser half owns both settings, so
  the window asks rather than decides: it just reflects what comes back in the
  next state push.
#>
function Send-Command([string]$Action) {
  Send "command" @{ action = $Action }
  try {
    $payload = @{ action = $Action } | ConvertTo-Json -Compress
    Invoke-WebRequest -Uri ($Origin + $CommandPath) -Method POST -ContentType "application/json" -Body $payload -TimeoutSec 4 -UseBasicParsing | Out-Null
  } catch {
  }
}

<#
  Report one twisty click, and one slider move.

  Both travel on two independent transports for the same reason a row click
  does: the browser half owns the collapse set and the alpha, and a control that
  silently goes nowhere reads as a broken button.
#>
function Send-Children([string]$Id) {
  Send "children" @{ action = "toggle-children"; id = $Id }
  try {
    $payload = @{ action = "toggle-children"; id = $Id } | ConvertTo-Json -Compress
    Invoke-WebRequest -Uri ($Origin + $CommandPath) -Method POST -ContentType "application/json" -Body $payload -TimeoutSec 4 -UseBasicParsing | Out-Null
  } catch {
  }
}

function Send-Opacity([double]$Value) {
  Send "opacity" @{ value = $Value }
  try {
    $payload = @{ action = "set-opacity"; value = $Value } | ConvertTo-Json -Compress
    Invoke-WebRequest -Uri ($Origin + $CommandPath) -Method POST -ContentType "application/json" -Body $payload -TimeoutSec 4 -UseBasicParsing | Out-Null
  } catch {
  }
}

# >>> testable
<#
  Paint one header toggle.

  On and off must be distinguishable at a glance - a subtle text change is not
  enough for a user asking "did the notification button work?": the on state
  gets a filled background plus bright text, the off state goes muted.
#>
function Set-ToggleLook($Button, [bool]$On) {
  if ($On) {
    $Button.Background = $brush.ConvertFromString("#FF2A3A2C")
    $Button.BorderBrush = $brush.ConvertFromString("#FF81C995")
    $Button.Foreground = $brush.ConvertFromString("#FF81C995")
  } else {
    $Button.Background = [System.Windows.Media.Brushes]::Transparent
    $Button.BorderBrush = $brush.ConvertFromString("#FF5F6368")
    $Button.Foreground = $brush.ConvertFromString("#FF9AA0A6")
  }
}

<#
  Build one session row. Kept between the testable markers so the row check can
  exercise it directly: every display state must render, because a throw here is
  swallowed by the poll's own catch and shows up as an empty window.

  A sub-agent row is indented under its parent and carries the same three
  columns, so a child's own state dot lines up with its parent's.
#>
function New-Row($row) {
  $state = "idle"
  if ($row.state -and $L.States.ContainsKey([string]$row.state)) { $state = [string]$row.state }
  $isChild = ($row.child -eq $true)
  $childCount = 0
  if ($row.childCount) { $childCount = [int]$row.childCount }
  $grid = New-Object System.Windows.Controls.Grid
  if ($isChild) {
    $grid.Margin = New-Object System.Windows.Thickness 26, 2, 8, 2
  } else {
    $grid.Margin = New-Object System.Windows.Thickness 8, 3, 8, 3
  }
  $grid.Cursor = [System.Windows.Input.Cursors]::Hand
  # A hit-testable background: without one, clicks land in the gaps between the
  # dot and the labels and never reach this row at all.
  $grid.Background = [System.Windows.Media.Brushes]::Transparent
  foreach ($spec in @(@(14), @(20), @(1, "Star"), @("Auto"))) {
    $column = New-Object System.Windows.Controls.ColumnDefinition
    if ($spec[0] -eq 1) { $column.Width = New-Object System.Windows.GridLength $spec[0], $spec[1] }
    else { $column.Width = $spec[0] }
    $grid.ColumnDefinitions.Add($column) | Out-Null
  }
  # Column 0: a twisty for a parent that owns sub-agents, otherwise a spacer so
  # every dot stays in the same column.
  if (-not $isChild -and $childCount -gt 0) {
    $twisty = New-Object System.Windows.Controls.TextBlock
    $twisty.Text = if ($row.collapsed -eq $true) { [char]0x25B6 } else { [char]0x25BC }
    $twisty.FontSize = 8
    $twisty.Foreground = $brush.ConvertFromString("#FF9AA0A6")
    $twisty.VerticalAlignment = "Center"
    $twisty.HorizontalAlignment = "Center"
    $twisty.Cursor = [System.Windows.Input.Cursors]::Hand
    # MouseUp, and GetNewClosure because a PowerShell scriptblock does not
    # capture the enclosing function's locals.
    $twisty.Add_MouseUp({
      param($sender, $event)
      $event.Handled = $true
      Send-Children ([string]$row.id)
    }.GetNewClosure())
    [System.Windows.Controls.Grid]::SetColumn($twisty, 0)
    $grid.AddChild($twisty)
  } else {
    $spacer = New-Object System.Windows.Controls.Border
    $spacer.Width = 14
    [System.Windows.Controls.Grid]::SetColumn($spacer, 0)
    $grid.AddChild($spacer)
  }
  $dot = New-Object System.Windows.Shapes.Ellipse
  $dot.Width = 8
  $dot.Height = 8
  $dot.VerticalAlignment = "Center"
  $dot.HorizontalAlignment = "Center"
  $dot.Fill = $brush.ConvertFromString($tones[$state])
  if ($state -eq "running") {
    # Pulses through a Storyboard: PowerShell cannot set RepeatMode on a
    # Timeline, and the throw used to be swallowed into an empty window.
    $pulse = New-Object System.Windows.Media.Animation.DoubleAnimation
    $pulse.From = 0.35
    $pulse.To = 1.0
    $pulse.Duration = New-Object System.Windows.Duration ([TimeSpan]::FromSeconds(0.6))
    $pulse.AutoReverse = $true
    $storyboard = New-Object System.Windows.Media.Animation.Storyboard
    [System.Windows.Media.Animation.Storyboard]::SetTarget($pulse, $dot)
    [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($pulse, (New-Object System.Windows.PropertyPath "Opacity"))
    $storyboard.Children.Add($pulse) | Out-Null
    $storyboard.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
    $storyboard.Begin() | Out-Null
  }
  [System.Windows.Controls.Grid]::SetColumn($dot, 1)
  $grid.AddChild($dot)
  $label = New-Object System.Windows.Controls.TextBlock
  # The child count is what distinguishes a collapsed parent from a session
  # that simply has no sub-agents.
  if ($childCount -gt 0 -and -not $isChild) {
    $label.Text = [string]$row.title + "  ·" + $childCount
  } else {
    $label.Text = [string]$row.title
  }
  $label.Margin = New-Object System.Windows.Thickness 8, 0, 8, 0
  $label.VerticalAlignment = "Center"
  $label.TextTrimming = "CharacterEllipsis"
  if ($row.blank -eq $true -or $isChild) { $label.Foreground = $brush.ConvertFromString("#FF9AA0A6") }
  [System.Windows.Controls.Grid]::SetColumn($label, 2)
  $grid.AddChild($label)
  $stateText = New-Object System.Windows.Controls.TextBlock
  $stateText.Text = $L.States[$state]
  $stateText.FontSize = 11
  $stateText.VerticalAlignment = "Center"
  $stateText.Foreground = $brush.ConvertFromString($tones[$state])
  [System.Windows.Controls.Grid]::SetColumn($stateText, 3)
  $grid.AddChild($stateText)
  # MouseUp, not MouseLeftButtonUp: the latter is a DIRECT routed event, so a
  # click landing on the dot or a label never reaches the row. GetNewClosure is
  # required because a PowerShell scriptblock does not capture the enclosing
  # function's locals, which left the id empty and the Host dropped it.
  $grid.Add_MouseUp({
    param($sender, $event)
    Send "open" @{ id = [string]$row.id }
    try {
      $payload = @{ id = [string]$row.id } | ConvertTo-Json -Compress
      Invoke-WebRequest -Uri ($Origin + $OpenPath) -Method POST -ContentType "application/json" -Body $payload -TimeoutSec 4 -UseBasicParsing | Out-Null
    } catch {
    }
  }.GetNewClosure())
  return $grid
}
# <<< testable

<# Repaint the header buttons and the list from one state snapshot. #>
function Update-List {
  try {
    $response = Invoke-WebRequest -Uri ($Origin + $StatePath) -Method GET -TimeoutSec 4 -UseBasicParsing
    $script:failures = 0
    $data = $response.Content | ConvertFrom-Json

    # The buttons mirror the browser half's settings and are repainted on EVERY
    # poll, not only when the value changes: a button that updates conditionally
    # gives no feedback at all when its state already matches, which reads as
    # "the button does nothing".
    $showAll = ($data.showAll -eq $true)
    $script:showAll = $showAll
    $filterButton.Content = if ($showAll) { $L.FilterAll } else { $L.FilterActive }
    Set-ToggleLook -Button $filterButton -On $showAll

    $notifyOn = ($data.notifyOn -ne $false)
    $script:notifyOn = $notifyOn
    $notifyButton.Content = if ($notifyOn) { $L.NotifyOn } else { $L.NotifyOff }
    Set-ToggleLook -Button $notifyButton -On $notifyOn

    # The alpha follows the browser half's saved setting. The slider is only
    # moved when the incoming value differs, and the programmatic move is
    # guarded so it cannot echo back as a user edit.
    $alpha = 1.0
    if ($data.opacity -ne $null) { $alpha = [double]$data.opacity }
    if ([Math]::Abs($opacitySlider.Value - $alpha) -gt 0.001) {
      $script:syncingOpacity = $true
      try {
        $opacitySlider.Value = [Math]::Min(1.0, [Math]::Max(0.2, $alpha))
      } finally {
        $script:syncingOpacity = $false
      }
    }
    Set-PanelAlpha $alpha | Out-Null

    $rows = @()
    if ($data.rows) { $rows = @($data.rows) }
    $total = if ($data.totalCount) { [int]$data.totalCount } else { $rows.Count }

    # The hint carries the counts, so the filter's effect is verifiable without
    # counting rows by eye: the browser half pushes the filtered rows and the
    # unfiltered total together.
    $hintText.Text = $L.Hint + "  ·  " + $rows.Count + "/" + $total

    # The child/childCount facts belong in the signature: a parent gaining a
    # sub-agent, or a collapse, changes the list without changing any state.
    $signature = (($rows | ForEach-Object {
      [string]$_.id + ":" + [string]$_.state + ":" + [string]$_.child + ":" + [string]$_.childCount + ":" + [string]$_.collapsed
    }) -join "|")
    if ($signature -eq $script:signature) { return }
    $script:signature = $signature
    $list.Children.Clear()
    if ($rows.Count -eq 0) {
      $empty = New-Object System.Windows.Controls.TextBlock
      $empty.Text = if ($showAll) { $L.EmptyAll } else { $L.Empty }
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

# Dragging is confined to the title area, so the header buttons never have to
# be distinguished from a drag by inspecting the event source.
$dragArea.Add_MouseLeftButtonDown({
  try { $window.DragMove() } catch {}
})
$filterButton.Add_Click({ Send-Command "toggle-filter" })
$notifyButton.Add_Click({ Send-Command "toggle-notify" })
$closeButton.Add_Click({ $window.Close() })

# The slider reports its value on every move, so the panel fades as it is
# dragged. The browser half owns the setting (and persists it); this only shows
# the change immediately and reports it.
$opacitySlider.Add_ValueChanged({
  # A poll that moved the slider to match the saved setting is not a user edit;
  # echoing it back would make the two halves fight over the value.
  if ($script:syncingOpacity -eq $true) { return }
  $value = Set-PanelAlpha $opacitySlider.Value
  Send-Opacity $value
})
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
