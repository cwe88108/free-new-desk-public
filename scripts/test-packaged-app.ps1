[CmdletBinding()]
param([string]$AppPath = '', [string]$ReleaseDir = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $ReleaseDir) { $ReleaseDir = Join-Path $root 'dist/releases' }
$sourcePackage = if ($AppPath) { Split-Path -Parent ([IO.Path]::GetFullPath($AppPath)) } else { Join-Path $ReleaseDir 'win-unpacked' }
if (-not (Test-Path (Join-Path $sourcePackage 'Free New Desk.exe'))) { throw "Packaged executable not found: $sourcePackage" }

. (Join-Path $PSScriptRoot 'windows-smoke-windows.ps1')

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$isolationRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ('free-new-desk-package-isolated-' + [guid]::NewGuid().ToString('N'))))
$packageDir = Join-Path $isolationRoot 'win-unpacked'
New-Item -ItemType Directory -Force -Path $isolationRoot | Out-Null
Copy-Item -LiteralPath $sourcePackage -Destination $packageDir -Recurse
$exe = Join-Path $packageDir 'Free New Desk.exe'
$smokeDir = Join-Path $tempRoot ('free-new-desk-packaged-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $smokeDir | Out-Null
$process = $null
try {
  Write-Host "Starting isolated packaged application renderer smoke test: $exe"
  $electronLog = Join-Path $smokeDir 'electron.log'
  $process = Start-Process -FilePath $exe -ArgumentList @('--user-data-dir="' + $smokeDir + '"', '--enable-logging', '--log-file="' + $electronLog + '"') -WindowStyle Normal -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $lastTitles = @()
  $readyAt = $null
  $readyWindow = [IntPtr]::Zero
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) { throw "Packaged application exited during startup with code $($process.ExitCode)." }
    $windows = [FreeNewDeskSmokeWindows]::VisibleForProcess($process.Id)
    $lastTitles = @($windows | ForEach-Object { $_.Title })
    $errorTitles = @($lastTitles -match '(?i)javascript.*error|renderer error|^error$')
    if ($errorTitles.Count -gt 0) { throw "Packaged application displayed an error window: $($errorTitles -join ', ')" }
    if ($readyAt) {
      $mounted = $windows | Where-Object { $_.Handle -eq $readyWindow } | Select-Object -First 1
      if (-not $mounted -or $mounted.Title -cne 'Free New Desk - Ready') {
        throw "Renderer window left Ready state after mount. Visible titles: '$($lastTitles -join "', '")'"
      }
      if (([DateTime]::UtcNow - $readyAt).TotalSeconds -ge 2) { Write-Host 'Packaged Electron renderer remained Ready for 2 seconds.'; return }
    } else {
      $mounted = $windows | Where-Object { $_.Title -ceq 'Free New Desk - Ready' } | Select-Object -First 1
      if ($mounted) {
        $readyWindow = $mounted.Handle
        $readyAt = [DateTime]::UtcNow
        Write-Host 'Packaged Electron renderer mounted; observing post-mount stability.'
      }
    }
  }
  throw "Packaged application renderer did not remain Ready within 30 seconds. Visible titles: '$($lastTitles -join "', '")'"
} catch {
  Write-Warning "Packaged smoke startup failed: $($_.Exception.Message)"
  $candidates = @(
    (Join-Path $smokeDir 'logs/app.log'),
    (Join-Path $smokeDir 'electron.log')
  )
  foreach ($logFile in ($candidates | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $logFile -PathType Leaf) {
      Write-Host "Startup diagnostic: $logFile"
      Get-Content -LiteralPath $logFile -Tail 50 -ErrorAction SilentlyContinue | ForEach-Object {
        $safe = $_ -replace 'https?://[^\s"\\]+','[REDACTED_URL]' -replace '(?i)(authorization|cookie|password|token)[\s:=]+[^\s,;]+','$1=[REDACTED]'
        Write-Host $safe
      }
    }
  }
  if ($process) { $process.Refresh(); Write-Host "Smoke process PID=$($process.Id) exited=$($process.HasExited)" }
  throw
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  $cleanupTarget = [IO.Path]::GetFullPath($isolationRoot)
  if (-not $cleanupTarget.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($cleanupTarget) -notmatch '^free-new-desk-package-isolated-[0-9a-f]{32}$') { throw "Refusing cleanup outside the dedicated temporary package directory: $cleanupTarget" }
  Remove-Item -LiteralPath $cleanupTarget -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Smoke data retained for diagnosis: $smokeDir"
}
