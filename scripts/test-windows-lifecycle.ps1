[CmdletBinding()]
param([string]$AppPath = '', [string]$ReleaseDir = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = if ($AppPath) { [IO.Path]::GetFullPath($AppPath) } elseif ($ReleaseDir) { Join-Path $ReleaseDir 'win-unpacked/Free New Desk.exe' } else { Join-Path $root 'dist/releases/win-unpacked/Free New Desk.exe' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Packaged executable not found: $exe" }

. (Join-Path $PSScriptRoot 'windows-smoke-windows.ps1')

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeLifecycleSmoke {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
"@

function Wait-AppWindow([System.Diagnostics.Process]$Process, [int]$Seconds = 45, [IntPtr]$ExpectedHandle = [IntPtr]::Zero) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 150
    $Process.Refresh()
    if ($Process.HasExited) { throw "Application exited before a window was ready: $($Process.ExitCode)" }
    $windows = [FreeNewDeskSmokeWindows]::VisibleForProcess($Process.Id)
    foreach ($window in $windows) {
      if ($window.Title -match '(?i)javascript.*error|renderer error|^error$') { throw "Packaged application displayed an error window: $($window.Title)" }
    }
    foreach ($window in $windows) {
      if ($window.Title -ceq 'Free New Desk - Ready' -and ($ExpectedHandle -eq [IntPtr]::Zero -or $window.Handle -eq $ExpectedHandle)) {
        return $window.Handle
      }
    }
  }
  throw 'Timed out waiting for the expected packaged application window to become visible and Ready.'
}

function Stop-ProcessTree([System.Diagnostics.Process]$Process) {
  if ($Process -and -not $Process.HasExited) {
    & taskkill.exe /PID $Process.Id /T /F | Out-Null
    $Process.WaitForExit(15000) | Out-Null
  }
}

$profile = Join-Path ([System.IO.Path]::GetTempPath()) ('free-new-desk-lifecycle-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$primary = $null
$second = $null
$recovered = $null
try {
  Write-Host 'Starting packaged application with a fresh profile.'
  $primary = Start-Process -FilePath $exe -ArgumentList @('--user-data-dir="' + $profile + '"') -PassThru
  $handle = Wait-AppWindow $primary

  $database = Join-Path $profile 'data/app.db'
  $log = Join-Path $profile 'logs/app.log'
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline -and (-not (Test-Path $database) -or -not (Test-Path $log))) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Path $database)) { throw 'Packaged startup did not create the SQLite database.' }
  if (-not (Test-Path $log)) { throw 'Packaged startup did not create the application log.' }

  if (-not [NativeLifecycleSmoke]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Failed to send WM_CLOSE to the main window.' }
  Start-Sleep -Seconds 2
  $primary.Refresh()
  if ($primary.HasExited) { throw 'Closing the main window exited the process instead of keeping the tray instance alive.' }
  if ([NativeLifecycleSmoke]::IsWindowVisible($handle)) { throw 'Main window remained visible after close-to-tray.' }

  Write-Host 'Starting a second instance to verify single-instance activation.'
  $second = Start-Process -FilePath $exe -ArgumentList @('--user-data-dir="' + $profile + '"') -PassThru
  if (-not $second.WaitForExit(15000)) { throw 'Second instance did not exit after handing activation to the primary instance.' }
  if ($second.ExitCode -ne 0) { throw "Second instance exited with code $($second.ExitCode)." }

  $null = Wait-AppWindow $primary -Seconds 15 -ExpectedHandle $handle
  $existingLog = @(Get-Content -LiteralPath $log)

  Write-Host 'Force-terminating the full process tree to test unclean-shutdown recovery.'
  Stop-ProcessTree $primary
  if (-not $primary.HasExited) { throw 'Primary instance did not exit after forced termination.' }
  $primary = $null

  $recovered = Start-Process -FilePath $exe -ArgumentList @('--user-data-dir="' + $profile + '"') -PassThru
  $null = Wait-AppWindow $recovered
  Start-Sleep -Seconds 2
  if (-not (Test-Path $database)) { throw 'Existing SQLite configuration was lost during recovery startup.' }
  $recoveryLog = @(Get-Content -LiteralPath $log | Select-Object -Skip $existingLog.Count)
  if (@($recoveryLog -match '"message":"detected previous unclean shutdown"').Count -ne 1) { throw 'Recovery startup did not record exactly one new unclean-shutdown event.' }
  if (@($recoveryLog -match '"message":"application ready"').Count -ne 1) { throw 'Recovery startup did not record exactly one new application-ready event.' }
  if (@($recoveryLog -match '(?i)startup failed|renderer process gone').Count -gt 0) { throw 'Recovery startup logged a new fatal startup or renderer failure.' }

  Write-Host 'Packaged lifecycle regression passed: existing profile, tray, single instance, forced termination and recovery.'
} finally {
  Stop-ProcessTree $second
  Stop-ProcessTree $primary
  Stop-ProcessTree $recovered
  Write-Host "Lifecycle data retained for diagnosis: $profile"
}
