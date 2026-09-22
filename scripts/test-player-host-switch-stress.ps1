$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$name="free-new-desk-switch-$PID";$pipe="\\.\pipe\$name"
$exe=Join-Path $root 'native\player-host\build\Release\player-host.exe'
$dll=Join-Path $root 'third_party\mpv\win-x64\libmpv-2.dll';Copy-Item $dll (Join-Path (Split-Path $exe) 'libmpv-2.dll') -Force
$video=Join-Path ([IO.Path]::GetTempPath()) ("free-new-desk-switch-$PID.avi")
& node (Join-Path $PSScriptRoot 'generate-test-avi.mjs') $video 160 90 25 12
if($LASTEXITCODE -ne 0){throw 'Controlled AVI generation failed'}
function Invoke-Player([hashtable]$Request,[int]$Timeout=10000){
 $client=[IO.Pipes.NamedPipeClientStream]::new('.',$name,[IO.Pipes.PipeDirection]::InOut)
 try{$client.Connect($Timeout);$writer=[IO.StreamWriter]::new($client);$writer.AutoFlush=$true;$reader=[IO.StreamReader]::new($client);$writer.WriteLine(($Request|ConvertTo-Json -Compress -Depth 6));return $reader.ReadLine()|ConvertFrom-Json}finally{$client.Dispose()}
}
function Wait-Loaded([string]$LoadId,[int]$TimeoutMs=30000){
 $deadline=[DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
 while([DateTime]::UtcNow -lt $deadline){$state=(Invoke-Player @{id='switch-status';method='player.query';params=@{query='load-status'}}).result;if($state.loadId -eq $LoadId){if($state.status -eq 'loaded'){return};if($state.status -eq 'failed'){throw "Load failed: $($state.error)"}};Start-Sleep -Milliseconds 50}
 throw "Timed out waiting for final switch $LoadId"
}
$process=Start-Process -FilePath $exe -ArgumentList @('--pipe',$pipe,'--test-audio-output','null') -PassThru -WindowStyle Hidden
try{
 [void](Invoke-Player @{id='stress-ping';method='player.ping';params=@{}})
 $process.Refresh();$baseline=[long]$process.WorkingSet64;$mediaUri=([Uri]$video).AbsoluteUri;$lastLoad=''
 for($i=1;$i -le 100;$i++){
  $watch=[Diagnostics.Stopwatch]::StartNew();$accepted=(Invoke-Player @{id="switch-$i";method='player.load';params=@{url=$mediaUri;profile='vod'}}).result;$watch.Stop()
  if(-not $accepted.accepted -or -not $accepted.loadId){throw "Switch $i was not accepted"}
  if($watch.ElapsedMilliseconds -gt 250){throw "Switch $i accept exceeded 250ms: $($watch.ElapsedMilliseconds)ms"}
  $lastLoad=[string]$accepted.loadId
  if(($i%10)-eq 0){$state=(Invoke-Player @{id="query-$i";method='player.query';params=@{query='load-status'}}).result;if(-not $state.loadId){throw "Switch $i lost load state"}}
 }
 Wait-Loaded $lastLoad
 $process.Refresh();$after=[long]$process.WorkingSet64;$growth=$after-$baseline
 if($growth -gt 536870912){throw "PlayerHost working set grew by more than 512 MiB after 100 switches: $growth"}
 $stop=(Invoke-Player @{id='stress-stop';method='player.command';params=@{command='stop'}}).result;if(-not $stop.ok){throw 'PlayerHost stop failed after stress'}
 $ping=(Invoke-Player @{id='stress-ping-final';method='player.ping';params=@{}}).result;if(-not $ping.ok){throw 'PlayerHost became unresponsive after stress'}
 Write-Host ("PlayerHost 100-switch stress passed: baseline={0:N1} MiB, final={1:N1} MiB, growth={2:N1} MiB." -f ($baseline/1MB),($after/1MB),($growth/1MB))
} finally {if($process -and -not $process.HasExited){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue};Remove-Item $video -Force -ErrorAction SilentlyContinue}
