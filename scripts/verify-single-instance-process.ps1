[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$AppPath,[Parameter(Mandatory=$true)][string]$EvidenceDir)
$ErrorActionPreference='Stop'
$exe=[IO.Path]::GetFullPath($AppPath)
if(-not(Test-Path -LiteralPath $exe -PathType Leaf)){throw 'Candidate executable does not exist.'}
$evidence=[IO.Path]::GetFullPath($EvidenceDir)
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$profile=Join-Path $evidence ('single-instance-profile-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profile | Out-Null
$log=Join-Path $profile 'logs/app.log'
$timeline=[Collections.Generic.List[object]]::new()
$primary=$null
$second=$null
$recovered=$null
function Record([string]$Name,[object]$Detail){$timeline.Add(@{at=[DateTime]::UtcNow.ToString('o');event=$Name;detail=$Detail})}
function App-Events {
  if(Test-Path -LiteralPath $log){Get-Content -LiteralPath $log | ForEach-Object {try{$_ | ConvertFrom-Json}catch{}}}
}
try{
  # These launches exercise normal application startup; this probe sends no window or keyboard input.
  $primary=Start-Process -FilePath $exe -ArgumentList @('--user-data-dir="'+$profile+'"') -WindowStyle Hidden -PassThru
  Record 'primary-started' @{pid=$primary.Id;profile=$profile}
  $deadline=[DateTime]::UtcNow.AddSeconds(45)
  do{
    $primary.Refresh()
    if($primary.HasExited){throw "Primary exited during startup: $($primary.ExitCode)"}
    $ready=@(App-Events | Where-Object {$_.message -eq 'application ready'})
    if($ready.Count -gt 0){break}
    Start-Sleep -Milliseconds 200
  }while([DateTime]::UtcNow -lt $deadline)
  if($ready.Count -ne 1){throw 'Primary did not log exactly one application-ready event.'}
  Record 'primary-ready' @{pid=$primary.Id}
  $second=Start-Process -FilePath $exe -ArgumentList @('--user-data-dir="'+$profile+'"') -WindowStyle Hidden -PassThru
  Record 'second-started' @{pid=$second.Id}
  $watch=[Diagnostics.Stopwatch]::StartNew()
  if(-not $second.WaitForExit(15000)){throw 'Second instance did not exit within the existing 15-second budget.'}
  $watch.Stop()
  Record 'second-exited' @{pid=$second.Id;exitCode=$second.ExitCode;elapsedMs=$watch.Elapsed.TotalMilliseconds}
  if($second.ExitCode -ne 0){throw "Second instance exit code: $($second.ExitCode)"}
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  do{
    $activated=@(App-Events | Where-Object {$_.message -eq 'main window activated'})
    if($activated.Count -gt 0){break}
    Start-Sleep -Milliseconds 150
  }while([DateTime]::UtcNow -lt $deadline)
  $primary.Refresh()
  if($primary.HasExited){throw 'Primary exited during second-instance handoff.'}
  $events=@(App-Events)
  $created=@($events | Where-Object {$_.message -eq 'window created' -and $_.primary -eq $true})
  $ready=@($events | Where-Object {$_.message -eq 'application ready'})
  if($activated.Count -lt 1){throw 'Primary did not handle the second-instance activation request.'}
  if($created.Count -ne 1 -or $ready.Count -ne 1){throw 'Second startup created another primary window or initialized the profile again.'}
  if(@($events | Where-Object {$_.message -eq 'startup failed'}).Count){throw 'Candidate logged a startup failure.'}
  Record 'verified' @{primaryAlive=$true;primaryWindowCreations=$created.Count;applicationReadyEvents=$ready.Count;activationEvents=$activated.Count;guiVisibilityVerified=$false}
  & taskkill.exe /PID $primary.Id /T /F | Out-Null
  if(-not $primary.WaitForExit(15000)){throw 'Owned primary did not terminate for recovery verification.'}
  Record 'primary-force-terminated' @{pid=$primary.Id}
  $database=Join-Path $profile 'data/app.db'
  if(-not(Test-Path -LiteralPath $database -PathType Leaf)){throw 'Profile database disappeared before recovery.'}
  $recovered=Start-Process -FilePath $exe -ArgumentList @('--user-data-dir="'+$profile+'"') -WindowStyle Hidden -PassThru
  Record 'recovery-started' @{pid=$recovered.Id}
  $deadline=[DateTime]::UtcNow.AddSeconds(45)
  do{
    $recovered.Refresh()
    if($recovered.HasExited){throw "Recovery process exited during startup: $($recovered.ExitCode)"}
    $events=@(App-Events)
    $ready=@($events | Where-Object {$_.message -eq 'application ready'})
    $created=@($events | Where-Object {$_.message -eq 'window created' -and $_.primary -eq $true})
    if($ready.Count -eq 2 -and $created.Count -eq 2){break}
    Start-Sleep -Milliseconds 200
  }while([DateTime]::UtcNow -lt $deadline)
  if($ready.Count -ne 2 -or $created.Count -ne 2){throw 'Recovery did not initialize and create exactly one new primary window.'}
  if(-not(Test-Path -LiteralPath $database -PathType Leaf)){throw 'Recovery lost the profile database.'}
  if(@($events | Where-Object {$_.message -eq 'detected previous unclean shutdown'}).Count -ne 1){throw 'Recovery failed to read the previous unclean-shutdown marker from the existing database.'}
  if(@($events | Where-Object {$_.message -eq 'startup failed' -or $_.message -eq 'renderer process gone'}).Count){throw 'Recovery logged a fatal startup or renderer failure.'}
  Record 'recovery-verified' @{pid=$recovered.Id;databasePreserved=$true;uncleanShutdownDetected=$true;newPrimaryWindowCreations=1;guiVisibilityVerified=$false}
  Write-Output 'PASS: real packaged single-instance handoff and forced-termination recovery; GUI visibility not asserted.'
}finally{
  foreach($owned in @($second,$primary,$recovered)){
    if($owned){$owned.Refresh();if(-not $owned.HasExited){& taskkill.exe /PID $owned.Id /T /F | Out-Null;$owned.WaitForExit(15000) | Out-Null}}
  }
  $timeline | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'single-instance-process-evidence.json') -Encoding UTF8
  Write-Output "Evidence profile retained: $profile"
}
