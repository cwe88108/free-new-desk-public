[CmdletBinding()]
param(
  [string]$AppPath = '',
  [string]$ReleaseDir = '',
  [string]$CaptureDir = '',
  [double]$Scale = 0,
  [switch]$HighContrast
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = if ($AppPath) { [IO.Path]::GetFullPath($AppPath) } elseif ($ReleaseDir) { Join-Path $ReleaseDir 'win-unpacked/Free New Desk.exe' } else { Join-Path $root 'dist/releases/win-unpacked/Free New Desk.exe' }
if (-not $CaptureDir) { $CaptureDir = if ($ReleaseDir) { Join-Path $ReleaseDir 'ui-smoke' } else { Join-Path $root 'dist/ui-smoke' } }
$captureDir = [IO.Path]::GetFullPath($CaptureDir)
$captureScale = if ($Scale -gt 0) { [string]$Scale } elseif ($env:FND_DPI_SCALE) { $env:FND_DPI_SCALE } else { '1' }
$captureHighContrast = $HighContrast -or $env:FND_HIGH_CONTRAST -eq '1'
$capturePrefix = 'scale-' + $captureScale.Replace('.', '-') + $(if ($captureHighContrast) { '-high-contrast' } else { '-normal' })
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Packaged executable not found: $exe" }

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeUiSmoke {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
[void][NativeUiSmoke]::SetProcessDpiAwarenessContext([IntPtr](-4))

function Get-VisiblePlayerHostChildren([IntPtr]$handle) {
  $items = New-Object 'System.Collections.Generic.List[System.IntPtr]'
  $callback = [NativeUiSmoke+EnumWindowsProc]{
    param([IntPtr]$child, [IntPtr]$unused)
    if ([NativeUiSmoke]::IsWindowVisible($child)) {
      [uint32]$childPid = 0
      [void][NativeUiSmoke]::GetWindowThreadProcessId($child, [ref]$childPid)
      if ($childPid -gt 0) {
        try {
          $childProcess = [System.Diagnostics.Process]::GetProcessById([int]$childPid)
          if ($childProcess.ProcessName -ieq 'player-host') { $items.Add($child) }
        } catch { }
      }
    }
    return $true
  }
  [void][NativeUiSmoke]::EnumChildWindows($handle, $callback, [IntPtr]::Zero)
  return @($items)
}

function Capture-Window([IntPtr]$handle, [string]$key) {
  if ($env:FND_CAPTURE_IMAGES -eq '0') { return }
  $rect = New-Object NativeUiSmoke+RECT
  if (-not [NativeUiSmoke]::GetWindowRect($handle, [ref]$rect)) { throw "GetWindowRect failed for $key" }
  $width = [Math]::Max(1, $rect.Right - $rect.Left)
  $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $hdc = $graphics.GetHdc()
    try {
      if (-not [NativeUiSmoke]::PrintWindow($handle, $hdc, 2)) { throw "PrintWindow failed for $key" }
    } finally { $graphics.ReleaseHdc($hdc) }
    $targetWidth = 640
    $targetHeight = [Math]::Max(1, [int]($height * ($targetWidth / [double]$width)))
    $small = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    try {
      $g2.DrawImage($bitmap, 0, 0, $targetWidth, $targetHeight)
      $target = Join-Path $captureDir ($capturePrefix + '-' + $key + '.jpg')
      $jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
      if (-not $jpeg) { throw 'JPEG encoder is unavailable on the Windows runner.' }
      $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
      try {
        $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]70)
        $small.Save($target, $jpeg, $parameters)
      } finally { $parameters.Dispose() }
      Write-Host "UI screenshot saved: $target"
    } finally { $g2.Dispose(); $small.Dispose() }
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

$expected = @('home','vod','live','music','player','search','favorites','history','sources','settings')
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$smokeDir = Join-Path ([System.IO.Path]::GetTempPath()) ('free-new-desk-ui-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $smokeDir | Out-Null
if ($env:FND_CAPTURE_IMAGES -ne '0') {
  New-Item -ItemType Directory -Force -Path $captureDir | Out-Null
}
$process = $null
$previousSmoke = $env:FND_UI_SMOKE
try {
  $env:FND_UI_SMOKE = '1'
  $dpiScale = $captureScale
  $arguments = @('--user-data-dir="' + $smokeDir + '"', "--force-device-scale-factor=$dpiScale")
  $highContrastEnabled = $captureHighContrast
  if ($highContrastEnabled) { $arguments += '--force-high-contrast' }
  Write-Host "Starting packaged UI navigation smoke test at scale $dpiScale (high contrast: $highContrastEnabled): $exe"
  $process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  $lastTitle = ''
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 120
    $process.Refresh()
    if ($process.HasExited) { throw "Packaged application exited during UI smoke with code $($process.ExitCode)." }
    $lastTitle = $process.MainWindowTitle
    if ($lastTitle -match '(?i)javascript.*error|renderer error|^error$') { throw "Packaged application displayed an error window: $lastTitle" }
    if ($lastTitle -match '^Free New Desk - Smoke:(.+)$') {
      $key = $Matches[1]
      if ($expected -notcontains $key) { throw "Unexpected UI smoke route marker: $key" }
      $firstCapture = $seen.Add($key)
      if ($true) {
        if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw "Main window handle missing for smoke route: $key" }
        [void][NativeUiSmoke]::SetForegroundWindow($process.MainWindowHandle)
        Start-Sleep -Milliseconds 180
        $process.Refresh()
        if ($process.MainWindowTitle -ne $lastTitle) { continue }
        $visibleNativePlayers = @(Get-VisiblePlayerHostChildren $process.MainWindowHandle)
        if ($key -eq 'player' -and $visibleNativePlayers.Count -lt 1) {
          $surfaceDeadline = [DateTime]::UtcNow.AddSeconds(2)
          while ([DateTime]::UtcNow -lt $surfaceDeadline -and $visibleNativePlayers.Count -lt 1) {
            Start-Sleep -Milliseconds 100
            $visibleNativePlayers = @(Get-VisiblePlayerHostChildren $process.MainWindowHandle)
          }
        }
        if ($key -eq 'player' -and $visibleNativePlayers.Count -lt 1) {
          throw 'Player route rendered without a visible embedded player-host child window.'
        }
        if ($key -ne 'player' -and $seen.Contains('player') -and $visibleNativePlayers.Count -gt 0) {
          throw "Native player-host window remained visible after leaving Player route: $key"
        }
        $mainRect = New-Object NativeUiSmoke+RECT
        if (-not [NativeUiSmoke]::GetWindowRect($process.MainWindowHandle, [ref]$mainRect)) { throw "Unable to read main window geometry at $key" }
        $mainWidth = $mainRect.Right - $mainRect.Left
        $mainHeight = $mainRect.Bottom - $mainRect.Top
        if ($mainWidth -lt 1280 -or $mainHeight -lt 720) { throw "Main window violated its 1280x720 minimum geometry at scale $dpiScale on ${key}: actual ${mainWidth}x${mainHeight}" }
        foreach ($nativePlayer in $visibleNativePlayers) {
          $playerRect = New-Object NativeUiSmoke+RECT
          if (-not [NativeUiSmoke]::GetWindowRect($nativePlayer, [ref]$playerRect)) { throw 'Unable to read player-host geometry.' }
          if ($playerRect.Left -lt ($mainRect.Left - 2) -or $playerRect.Top -lt ($mainRect.Top - 2) -or $playerRect.Right -gt ($mainRect.Right + 2) -or $playerRect.Bottom -gt ($mainRect.Bottom + 2)) {
            throw "PlayerHost escaped the application bounds at scale ${dpiScale}: main=($($mainRect.Left),$($mainRect.Top),$($mainRect.Right),$($mainRect.Bottom)); player=($($playerRect.Left),$($playerRect.Top),$($playerRect.Right),$($playerRect.Bottom))"
          }
          if (($playerRect.Right - $playerRect.Left) -lt 100 -or ($playerRect.Bottom - $playerRect.Top) -lt 80) { throw "PlayerHost surface collapsed at scale $dpiScale on ${key}: ($($playerRect.Left),$($playerRect.Top),$($playerRect.Right),$($playerRect.Bottom))." }
        }
        if ($firstCapture) { Capture-Window $process.MainWindowHandle $key; Write-Host "UI route rendered and captured: $key" } else { Write-Host "UI route re-validated dynamically: $key" }
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
      }
    }
    if ($lastTitle -eq 'Free New Desk - UI Smoke Complete') {
      $missing = @($expected | Where-Object { -not $seen.Contains($_) })
      if ($missing.Count -gt 0) { throw "UI smoke completed but routes were not captured: $($missing -join ', ')" }
      Write-Host "Packaged UI navigation smoke passed at scale ${dpiScale}: $($expected.Count) primary pages rendered; navigation <=100ms, native surface route release <=200ms, player visibility/geometry, and renderer health were enforced by the packaged app."
      return
    }
  }
  throw "Packaged UI smoke made no progress before the watchdog expired. Last title: '$lastTitle'; captured: $([string]::Join(',', $seen))"
} finally {
  if ($null -eq $previousSmoke) { Remove-Item Env:FND_UI_SMOKE -ErrorAction SilentlyContinue } else { $env:FND_UI_SMOKE = $previousSmoke }
  # Flush is requested by the renderer only after the measured operation settles.
  # A hung/crashed renderer may not acknowledge it; retain partial stage evidence then.
  $flushDeadline = [DateTime]::UtcNow.AddSeconds(2)
  $flushAcknowledged = $false
  do {
    $flushAcknowledged = @(Get-ChildItem -LiteralPath $smokeDir -Filter 'surface-timing-flushed.json' -Recurse -File -ErrorAction SilentlyContinue).Count -gt 0
    if ($flushAcknowledged -or -not $process -or $process.HasExited) { break }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $flushDeadline)
  Write-Host "Surface timing flush acknowledged: $flushAcknowledged (false means partial evidence only)"
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  # Persist only numeric surface stage diagnostics, never the app log/database/URLs.
  # This finally path runs after failures too, including scales with image capture disabled.
  # Node preserves ISO timestamp strings; PowerShell ConvertFrom-Json can turn
  # them into DateTime objects and silently reject every line in a string filter.
  $collector = Join-Path $PSScriptRoot 'collect-surface-timing.mjs'
  $previousExitCode = $LASTEXITCODE
  $collectorExitCode = 1
  try {
    & node $collector $smokeDir $captureDir $capturePrefix ($flushAcknowledged.ToString().ToLowerInvariant())
    $collectorExitCode = $LASTEXITCODE
  } catch {
    Write-Warning 'Surface timing collector could not run; evidence is unavailable.'
  } finally {
    $global:LASTEXITCODE = $previousExitCode
  }
  if ($collectorExitCode -ne 0) { Write-Warning 'Surface timing evidence is incomplete or collection failed. Inspect the surface-evidence report; a flush ACK alone does not prove collection.' }
  $performanceFiles = @(Get-ChildItem -LiteralPath $smokeDir -Filter 'performance-runtime.json' -Recurse -File -ErrorAction SilentlyContinue)
  if ($performanceFiles.Count -ne 1) { throw 'Expected exactly one sanitized performance-runtime.json from the packaged UI smoke.' }
  $performance = Get-Content -LiteralPath $performanceFiles[0].FullName -Raw | ConvertFrom-Json
  if ($performance.schemaVersion -ne 1 -or $performance.workload -ne 'packaged-ui-smoke-v1' -or $performance.durationMs -le 0) { throw 'Packaged UI performance telemetry envelope is invalid.' }
  if ($performance.counters.playbackStatsIpcCalls -le 0 -or $performance.uiMetrics.navigationMs.count -lt 8 -or $performance.uiMetrics.rendererFrameP95Ms.count -lt 1) { throw 'Packaged UI performance telemetry is missing navigation, playback IPC, or frame samples.' }
  $performanceOutput = Join-Path $captureDir ($capturePrefix + '-performance.json')
  Copy-Item -LiteralPath $performanceFiles[0].FullName -Destination $performanceOutput -Force
  Write-Host ("Performance evidence: durationMs={0}, playbackStatsIpcCalls={1}, playerHostStatsQueryCalls={2}, navigationP95Ms={3}, frameP95Ms={4}, frameOver33MsRate={5}" -f $performance.durationMs, $performance.counters.playbackStatsIpcCalls, $performance.counters.playerHostStatsQueryCalls, $performance.uiMetrics.navigationMs.p95, $performance.uiMetrics.rendererFrameP95Ms.p95, $performance.uiMetrics.rendererFrameOver33MsRate.p95)
  Write-Host "Smoke data retained for diagnosis: $smokeDir"
}
