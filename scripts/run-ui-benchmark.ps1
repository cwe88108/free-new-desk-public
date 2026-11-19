[CmdletBinding()]
param([Parameter(Mandatory)][string]$ObservationRoot,[Parameter(Mandatory)][string]$RunDir,[Parameter(Mandatory)][string]$ElectronPath,[Parameter(Mandatory)][string]$NodePath,[int]$SourceCount=712,[int]$ExpectedOperations=150)
$ErrorActionPreference='Stop'
$sourceRoot=[IO.Path]::GetFullPath($ObservationRoot)
$runRoot=[IO.Path]::GetFullPath($RunDir)
$exe=[IO.Path]::GetFullPath($ElectronPath)
foreach ($required in @('apps/desktop/dist/renderer/index.html','apps/desktop/dist/main/bootstrap.js','apps/desktop/dist/preload/index.cjs')) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $required) -PathType Leaf)) { throw ('Missing benchmark build output: '+$required) }
}
# Refuse concurrent application instances instead of silently contaminating timings.
# Do not kill by name: a different Electron application may contain unsaved work.
$processInventory=@(Get-CimInstance Win32_Process -ErrorAction Stop)
$competingProcesses=@($processInventory | Where-Object {
  $_.Name -eq 'Free New Desk.exe' -or
  $_.Name -in @('PlayerHost.exe','player-host.exe') -or
  ($_.Name -eq 'electron.exe' -and ($_.ExecutablePath -eq $exe -or $_.CommandLine -match 'free-new-desk|perf-observation'))
} | Select-Object ProcessId,Name,ExecutablePath)
if ($competingProcesses.Count -gt 0) {
  throw ('Benchmark requires other Free New Desk/test instances to be closed first: '+($competingProcesses | ConvertTo-Json -Compress))
}
if (Test-Path -LiteralPath $runRoot) { throw 'Refusing an existing benchmark run directory' }
$provenance=Get-Content -LiteralPath (Join-Path $sourceRoot 'benchmark-observation.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $runRoot | Out-Null
@{checkedAt=[DateTime]::UtcNow.ToString('o');competingProcesses=$competingProcesses} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runRoot 'process-preflight.json')
$profile=Join-Path $runRoot 'profile'
& $NodePath (Join-Path $PSScriptRoot 'seed-ui-benchmark.mjs') $sourceRoot $profile $SourceCount
if ($LASTEXITCODE -ne 0) { throw 'Benchmark fixture creation failed' }
$oldSmoke=$env:FND_UI_SMOKE
$oldOutput=$env:FND_BENCH_OUTPUT
$oldCount=$env:FND_BENCH_SOURCE_COUNT
$process=$null
$completed=$false
$reason=''
$titles=@()
try {
  $env:FND_UI_SMOKE='1'
  $env:FND_BENCH_OUTPUT=Join-Path $runRoot 'result.json'
  $env:FND_BENCH_SOURCE_COUNT=[string]$SourceCount
  $process=Start-Process -FilePath $exe -ArgumentList @('"'+$sourceRoot+'"','--user-data-dir="'+$profile+'"','--enable-logging','--log-file="'+(Join-Path $runRoot 'electron.log')+'"') -WindowStyle Normal -RedirectStandardOutput (Join-Path $runRoot 'main.stdout.log') -RedirectStandardError (Join-Path $runRoot 'main.stderr.log') -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(240)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    $titles+=@{at=[DateTime]::UtcNow.ToString('o');title=$process.MainWindowTitle;exited=$process.HasExited}
    if ($process.HasExited) { throw ('Benchmark exited: '+$process.ExitCode) }
    if ($process.MainWindowTitle -match 'Renderer Error') { throw ('Benchmark renderer failed: '+$process.MainWindowTitle) }
    if ($process.MainWindowTitle -eq 'Free New Desk - Benchmark Complete') {
      $result=Get-Content -LiteralPath (Join-Path $runRoot 'result.json') -Raw | ConvertFrom-Json
      if (-not $result.completed -or @($result.samples.pageShellInteractiveMs).Count -ne $ExpectedOperations -or @($result.samples.rendererFrameGapMs).Count -lt 100) { throw 'Incomplete benchmark evidence' }
      $completed=$true;break
    }
  }
  if (-not $completed) { throw 'Benchmark timed out without complete evidence' }
} catch { $reason=$_.Exception.Message; throw }
finally {
  if ($process -and -not $process.HasExited) {
    $identity=Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.Id)
    if ($identity.ExecutablePath -eq $exe -and $identity.CommandLine.Contains($profile)) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
    else { throw 'Refusing mismatched benchmark process cleanup' }
  }
  if ($null -eq $oldSmoke) { Remove-Item Env:FND_UI_SMOKE -ErrorAction SilentlyContinue } else { $env:FND_UI_SMOKE=$oldSmoke }
  if ($null -eq $oldOutput) { Remove-Item Env:FND_BENCH_OUTPUT -ErrorAction SilentlyContinue } else { $env:FND_BENCH_OUTPUT=$oldOutput }
  if ($null -eq $oldCount) { Remove-Item Env:FND_BENCH_SOURCE_COUNT -ErrorAction SilentlyContinue } else { $env:FND_BENCH_SOURCE_COUNT=$oldCount }
  $titles | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runRoot 'titles.json')
  @{completed=$completed;reason=$reason;sourceCount=$SourceCount;expectedOperations=$ExpectedOperations;diagnostic=[bool]$provenance.diagnostic;observationRoot=$sourceRoot;sourceInventorySha256=$provenance.sourceInventorySha256;templateHashes=$provenance.templateHashes;prepareScriptSha256=$provenance.prepareScriptSha256;electronSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runRoot 'run.json')
}
