$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = "free-new-desk-video-$PID"
$pipe = "\\.\pipe\$name"
$exe = Join-Path $root 'native\player-host\build\Release\player-host.exe'
$dll = Join-Path $root 'third_party\mpv\win-x64\libmpv-2.dll'
$targetDll = Join-Path (Split-Path $exe) 'libmpv-2.dll'
$video = Join-Path ([System.IO.Path]::GetTempPath()) ("free-new-desk-video-$PID.avi")
Copy-Item $dll $targetDll -Force

$width=160;$height=90;$fps=25;$seconds=12
& node (Join-Path $PSScriptRoot 'generate-test-avi.mjs') $video $width $height $fps $seconds
if($LASTEXITCODE -ne 0 -or -not (Test-Path $video)){throw 'Failed to generate controlled Y4M video'}

function Invoke-Player([hashtable]$Request,[int]$Timeout=10000){
  $client=[System.IO.Pipes.NamedPipeClientStream]::new('.',$name,[System.IO.Pipes.PipeDirection]::InOut)
  try{$client.Connect($Timeout);$writer=[IO.StreamWriter]::new($client);$writer.AutoFlush=$true;$reader=[IO.StreamReader]::new($client);$writer.WriteLine(($Request|ConvertTo-Json -Compress -Depth 6));return $reader.ReadLine()|ConvertFrom-Json}finally{$client.Dispose()}
}
function Wait-Loaded([string]$LoadId,[int]$TimeoutMs=30000){
  $deadline=[DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while([DateTime]::UtcNow -lt $deadline){$state=(Invoke-Player @{id='video-status';method='player.query';params=@{query='load-status'}}).result;if($state.loadId -eq $LoadId){if($state.status -eq 'loaded'){return};if($state.status -in @('failed','ended')){throw "Video load failed: $($state|ConvertTo-Json -Compress)"}};Start-Sleep -Milliseconds 75}
  throw "Timed out waiting for controlled video load $LoadId"
}
function Read-Stats(){return (Invoke-Player @{id='video-stats';method='player.query';params=@{query='stats'}}).result}
function Wait-Position([double]$Target,[double]$Tolerance=1.5,[int]$TimeoutMs=5000){
  $deadline=[DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while([DateTime]::UtcNow -lt $deadline){$stats=Read-Stats;if([Math]::Abs([double]$stats.position-$Target) -le $Tolerance){return $stats};Start-Sleep -Milliseconds 75}
  throw "Seek did not converge to $Target seconds"
}

$process=Start-Process -FilePath $exe -ArgumentList @('--pipe',$pipe,'--test-audio-output','null') -PassThru -WindowStyle Hidden
try{
  $mediaUri=([Uri]$video).AbsoluteUri
  $load=(Invoke-Player @{id='video-load';method='player.load';params=@{url=$mediaUri;profile='vod'}}).result
  if(-not $load.accepted -or -not $load.loadId){throw 'PlayerHost did not accept controlled video'}
  Wait-Loaded ([string]$load.loadId)
  $stats=Read-Stats
  if([int]$stats.width -ne $width -or [int]$stats.height -ne $height){throw "Unexpected video geometry: $($stats.width)x$($stats.height)"}
  if([double]$stats.duration -lt 10){throw "Controlled video duration too short: $($stats.duration)"}
  [void](Invoke-Player @{id='video-pause';method='player.command';params=@{command='pause';value=$true}})
  $duration=[double](Read-Stats).duration
  foreach($ratio in @(0.10,0.85,0.20)){$target=$duration*$ratio;$seek=(Invoke-Player @{id="seek-$ratio";method='player.command';params=@{command='seek';value=$target;absolute=$true;loadId=$load.loadId}}).result;if(-not $seek.ok){throw "Seek command failed at ratio ${ratio}: $($seek|ConvertTo-Json -Compress)"};[void](Wait-Position $target)}
  [void](Invoke-Player @{id='video-resume';method='player.command';params=@{command='pause';value=$false}})
  Start-Sleep -Milliseconds 250;$before=[double](Read-Stats).position;Start-Sleep -Milliseconds 900;$after=[double](Read-Stats).position
  if($after-$before -lt 0.5){throw "Playback clock did not advance: before=$before after=$after"}
  $final=Read-Stats
  Write-Host ("PlayerHost controlled-video validation passed: {0}x{1}, duration={2:N2}s, seek 10%->85%->20%, clock advanced {3:N2}s." -f $final.width,$final.height,$duration,($after-$before))
} finally {
  if($process -and -not $process.HasExited){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue}
  Remove-Item $video -Force -ErrorAction SilentlyContinue
}
