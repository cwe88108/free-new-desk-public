$ErrorActionPreference = 'Stop'
$name = "free-new-desk-ci-$PID"
$pipe = "\\.\pipe\$name"
$exe = Join-Path $PSScriptRoot '..\native\player-host\build\Release\player-host.exe'
$dll = Join-Path $PSScriptRoot '..\third_party\mpv\win-x64\libmpv-2.dll'
$targetDll = Join-Path (Split-Path $exe) 'libmpv-2.dll'
$wav = Join-Path ([System.IO.Path]::GetTempPath()) ("free-new-desk-player-$PID.wav")
Copy-Item $dll $targetDll -Force

# Generate a valid PCM WAV locally so player.load is tested without public-network dependencies.
$sampleRate = 8000
$channels = 1
$bitsPerSample = 16
$samples = $sampleRate * 10
$dataSize = $samples * $channels * ($bitsPerSample / 8)
$stream = [System.IO.File]::Create($wav)
$binary = [System.IO.BinaryWriter]::new($stream)
try {
  $binary.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
  $binary.Write([int](36 + $dataSize))
  $binary.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
  $binary.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
  $binary.Write([int]16)
  $binary.Write([int16]1)
  $binary.Write([int16]$channels)
  $binary.Write([int]$sampleRate)
  $binary.Write([int]($sampleRate * $channels * ($bitsPerSample / 8)))
  $binary.Write([int16]($channels * ($bitsPerSample / 8)))
  $binary.Write([int16]$bitsPerSample)
  $binary.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
  $binary.Write([int]$dataSize)
  for ($i = 0; $i -lt $samples; $i++) { $binary.Write([int16]0) }
} finally {
  $binary.Dispose()
  $stream.Dispose()
}

function Invoke-PlayerHostRequest([hashtable]$Request, [int]$Timeout = 10000) {
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $name, [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $client.Connect($Timeout)
    $writer = [System.IO.StreamWriter]::new($client); $writer.AutoFlush = $true
    $reader = [System.IO.StreamReader]::new($client)
    $writer.WriteLine(($Request | ConvertTo-Json -Compress -Depth 6))
    return $reader.ReadLine()
  } finally {
    $client.Dispose()
  }
}

$process = Start-Process -FilePath $exe -ArgumentList @('--pipe', $pipe, '--test-audio-output', 'null') -PassThru -WindowStyle Hidden
try {
  $ping = Invoke-PlayerHostRequest @{ id = 'ci-ping'; method = 'player.ping'; params = @{} }
  if ($ping -notmatch '"ok":true') { throw "PlayerHost ping failed: $ping" }

  # Reproduce the renderer's former stats/tracks/window-sync connection pressure at the pipe layer.
  # v1.3.5 exposed only one pipe instance, so concurrent clients could see ERROR_FILE_NOT_FOUND/ENOENT.
  if ($PSVersionTable.PSVersion.Major -ge 7) {
    $parallelResults = 1..12 | ForEach-Object -Parallel {
      $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $using:name, [System.IO.Pipes.PipeDirection]::InOut)
      try {
        $client.Connect(10000)
        $writer = [System.IO.StreamWriter]::new($client); $writer.AutoFlush = $true
        $reader = [System.IO.StreamReader]::new($client)
        $request = @{ id = "ci-parallel-$_"; method = 'player.ping'; params = @{} } | ConvertTo-Json -Compress -Depth 4
        $writer.WriteLine($request)
        $reader.ReadLine()
      } finally {
        $client.Dispose()
      }
    } -ThrottleLimit 12
    $badParallel = @($parallelResults | Where-Object { $_ -notmatch '"ok":true' })
    if ($parallelResults.Count -ne 12 -or $badParallel.Count -gt 0) { throw "PlayerHost concurrent pipe test failed: $($parallelResults -join '; ')" }
  }

  function Wait-Load([string]$LoadId, [int]$TimeoutMs = 30000) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
      $raw = Invoke-PlayerHostRequest @{ id = 'ci-load-status'; method = 'player.query'; params = @{ query = 'load-status' } }
      $parsed = $raw | ConvertFrom-Json
      if ($parsed.result.loadId -eq $LoadId) {
        if ($parsed.result.status -eq 'loaded') { return $parsed.result }
        if ($parsed.result.status -in @('failed','ended')) { throw "Async media load failed: $raw" }
      }
      Start-Sleep -Milliseconds 75
    }
    throw "Timed out waiting for async PlayerHost load $LoadId"
  }

  $mediaUri = ([System.Uri]$wav).AbsoluteUri
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $load = Invoke-PlayerHostRequest @{ id = 'ci-load'; method = 'player.load'; params = @{ url = $mediaUri; profile = 'vod' } }
  $watch.Stop()
  if ($watch.ElapsedMilliseconds -gt 200) { throw "player.load did not accept within 200ms: $($watch.ElapsedMilliseconds)ms" }
  $accepted = $load | ConvertFrom-Json
  if (-not $accepted.result.accepted -or -not $accepted.result.loadId) { throw "PlayerHost did not return async load acceptance: $load" }
  [void](Wait-Load ([string]$accepted.result.loadId))

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $stats = Invoke-PlayerHostRequest @{ id = 'ci-stats'; method = 'player.query'; params = @{ query = 'stats' } }
  $watch.Stop()
  if ($watch.ElapsedMilliseconds -gt 200 -or $stats -notmatch '"position"') { throw "PlayerHost stats responsiveness failed: $($watch.ElapsedMilliseconds)ms $stats" }

  $liveLoad = Invoke-PlayerHostRequest @{ id = 'ci-load-live-profile'; method = 'player.load'; params = @{ url = $mediaUri; profile = 'live' } }
  $liveAccepted = $liveLoad | ConvertFrom-Json
  [void](Wait-Load ([string]$liveAccepted.result.loadId))

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $stop = Invoke-PlayerHostRequest @{ id = 'ci-stop'; method = 'player.command'; params = @{ command = 'stop' } }
  $watch.Stop()
  if ($watch.ElapsedMilliseconds -gt 200 -or $stop -notmatch '"ok":true') { throw "PlayerHost stop exceeded 200ms or failed: $($watch.ElapsedMilliseconds)ms $stop" }

  # Missing media is accepted immediately, then transitions to failed asynchronously.
  $missing = Join-Path ([System.IO.Path]::GetTempPath()) ("free-new-desk-missing-$PID.mp4")
  Remove-Item $missing -Force -ErrorAction SilentlyContinue
  $missingUri = ([System.Uri]$missing).AbsoluteUri
  $failedAcceptedRaw = Invoke-PlayerHostRequest @{ id = 'ci-missing'; method = 'player.load'; params = @{ url = $missingUri } }
  $failedAccepted = $failedAcceptedRaw | ConvertFrom-Json
  if (-not $failedAccepted.result.accepted) { throw "PlayerHost did not asynchronously accept missing-media request: $failedAcceptedRaw" }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $sawFailure = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    $stateRaw = Invoke-PlayerHostRequest @{ id = 'ci-missing-status'; method = 'player.query'; params = @{ query = 'load-status' } }
    $state = ($stateRaw | ConvertFrom-Json).result
    if ($state.loadId -eq $failedAccepted.result.loadId -and $state.status -eq 'failed') { $sawFailure = $true; break }
    Start-Sleep -Milliseconds 75
  }
  if (-not $sawFailure) { throw 'Missing media never transitioned to failed async load state.' }

  Write-Host 'PlayerHost async accept/load-status, concurrent query, stop latency, real media and failure integration passed.'
} finally {
  if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
  Remove-Item $wav -Force -ErrorAction SilentlyContinue
}
