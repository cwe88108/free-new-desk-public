$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sourcePackage = Join-Path $root 'dist/releases/win-unpacked'
if (-not (Test-Path (Join-Path $sourcePackage 'Free New Desk.exe'))) { throw "Packaged executable not found: $sourcePackage" }

$isolationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('free-new-desk-package-isolated-' + [guid]::NewGuid().ToString('N'))
$packageDir = Join-Path $isolationRoot 'win-unpacked'
New-Item -ItemType Directory -Force -Path $isolationRoot | Out-Null
Copy-Item -Path $sourcePackage -Destination $packageDir -Recurse
$exe = Join-Path $packageDir 'Free New Desk.exe'
$smokeDir = Join-Path ([System.IO.Path]::GetTempPath()) ('free-new-desk-packaged-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $smokeDir | Out-Null
$process = $null
try {
  Write-Host "Starting isolated packaged application renderer smoke test: $exe"
  $process = Start-Process -FilePath $exe -ArgumentList @("--user-data-dir=$smokeDir") -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $lastTitle = ''
  $readyAt = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) { throw "Packaged application exited during startup with code $($process.ExitCode)." }
    $lastTitle = $process.MainWindowTitle
    if ($lastTitle -match '(?i)javascript.*error|renderer error|^error$') { throw "Packaged application displayed an error window: $lastTitle" }
    if ($lastTitle -eq 'Free New Desk - Ready') {
      if (-not $readyAt) { $readyAt = [DateTime]::UtcNow; Write-Host 'Packaged Electron renderer mounted; observing post-mount stability.' }
      if (([DateTime]::UtcNow - $readyAt).TotalSeconds -ge 2) { Write-Host 'Packaged Electron renderer remained Ready for 2 seconds.'; return }
    } elseif ($readyAt) { throw "Renderer left Ready state after mount. Current title: '$lastTitle'" }
  }  throw "Packaged application renderer did not remain Ready within 30 seconds. Last window title: '$lastTitle'"
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -Path $isolationRoot -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Smoke data retained for diagnosis: $smokeDir"
}