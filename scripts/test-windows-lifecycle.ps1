$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'dist/releases/win-unpacked/Free New Desk.exe'
if (-not (Test-Path $exe)) { throw "Packaged executable not found: $exe" }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeLifecycleSmoke {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

function Wait-AppWindow([System.Diagnostics.Process]$Process, [int]$Seconds = 45) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 150
    $Process.Refresh()
    if ($Process.HasExited) { throw "Application exited before a window was ready: $($Process.ExitCode)" }
    if ($Process.MainWindowHandle -ne [IntPtr]::Zero -and [NativeLifecycleSmoke]::IsWindowVisible($Process.MainWindowHandle)) { return }
  }
  throw 'Timed out waiting for packaged application window.'
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
  $primary = Start-Process -FilePath $exe -ArgumentList @("--user-data-dir=$profile") -PassThru
  Wait-AppWindow $primary

  $database = Join-Path $profile 'data/app.db'
  $log = Join-Path $profile 'logs/app.log'
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline -and (-not (Test-Path $database) -or -not (Test-Path $log))) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Path $database)) { throw 'Packaged startup did not create the SQLite database.' }
  if (-not (Test-Path $log)) { throw 'Packaged startup did not create the application log.' }

  $handle = $primary.MainWindowHandle
  if (-not [NativeLifecycleSmoke]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Failed to send WM_CLOSE to the main window.' }
  Start-Sleep -Seconds 2
  $primary.Refresh()
  if ($primary.HasExited) { throw 'Closing the main window exited the process instead of keeping the tray instance alive.' }
  if ([NativeLifecycleSmoke]::IsWindowVisible($handle)) { throw 'Main window remained visible after close-to-tray.' }

  Write-Host 'Starting a second instance to verify single-instance activation.'
  $second = Start-Process -FilePath $exe -ArgumentList @("--user-data-dir=$profile") -PassThru
  if (-not $second.WaitForExit(15000)) { throw 'Second instance did not exit after handing activation to the primary instance.' }
  if ($second.ExitCode -ne 0) { throw "Second instance exited with code $($second.ExitCode)." }

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 150
    $primary.Refresh()
    $visible = $primary.MainWindowHandle -ne [IntPtr]::Zero -and [NativeLifecycleSmoke]::IsWindowVisible($primary.MainWindowHandle)
  } while (-not $visible -and [DateTime]::UtcNow -lt $deadline)
  if (-not $visible) { throw 'Second-instance activation did not restore the tray-hidden main window.' }

  Write-Host 'Force-terminating the full process tree to test unclean-shutdown recovery.'
  Stop-ProcessTree $primary
  $primary = $null

  $recovered = Start-Process -FilePath $exe -ArgumentList @("--user-data-dir=$profile") -PassThru
  Wait-AppWindow $recovered
  Start-Sleep -Seconds 2
  if (-not (Test-Path $database)) { throw 'Existing SQLite configuration was lost during recovery startup.' }
  $logText = Get-Content $log -Raw
  if ($logText -notmatch 'detected previous unclean shutdown') { throw 'Recovery startup did not record the previous unclean shutdown.' }
  $lastReady = $logText.LastIndexOf('"message":"application ready"')
  if ($lastReady -lt 0) { throw 'Recovery startup did not record a new application-ready event.' }
  $recoveryTail = $logText.Substring($lastReady)
  if ($recoveryTail -match '(?i)startup failed|renderer process gone') { throw 'Recovery startup logged a new fatal startup or renderer failure after becoming ready.' }

  Write-Host 'Packaged lifecycle regression passed: existing profile, tray, single instance, forced termination and recovery.'
} finally {
  Stop-ProcessTree $second
  Stop-ProcessTree $primary
  Stop-ProcessTree $recovered
  Get-Process -Name 'Free New Desk' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process -Name 'player-host' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
}
