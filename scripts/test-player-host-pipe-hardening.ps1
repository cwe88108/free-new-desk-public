param([string]$Executable, [string]$EvidencePath)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Executable) { $Executable = Join-Path $root 'native/player-host/build/Release/player-host.exe' }
$name = 'free-new-desk-pipe-test-' + [Guid]::NewGuid().ToString('N')
$pipe = '\\.\pipe\' + $name
$wav = Join-Path ([IO.Path]::GetTempPath()) ($name + '.wav')
$checks = [Collections.Generic.List[object]]::new()
$clients = [Collections.Generic.List[IO.Pipes.NamedPipeClientStream]]::new()
$process = $null
$collision = $null

if (-not ('PlayerPipeSecurityCheck' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PlayerPipeSecurityCheck {
  [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr h,uint type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr sd);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd,uint revision,uint info,out IntPtr text,out uint length);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disabled,IntPtr disabledSids,uint deleted,IntPtr deletedPrivileges,uint restricted,[In] SidAndAttributes[] restrictedSids,out IntPtr result);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateWellKnownSid(int type,IntPtr domain,IntPtr sid,ref uint size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint processId);
  public static uint ServerProcessId(IntPtr pipe) {
    uint processId;
    if(!GetNamedPipeServerProcessId(pipe,out processId))throw new Win32Exception();
    return processId;
  }
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
  public static string Dacl(IntPtr handle) {
    IntPtr owner,group,dacl,sacl,descriptor;
    uint error=GetSecurityInfo(handle,6,4,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0)throw new Win32Exception((int)error);
    IntPtr text=IntPtr.Zero;
    try {
      uint length;
      if(!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor,1,4,out text,out length))throw new Win32Exception();
      return Marshal.PtrToStringUni(text);
    } finally {if(text!=IntPtr.Zero)LocalFree(text);LocalFree(descriptor);}
  }
  public static int RestrictedOpenError(string name) {
    IntPtr token=IntPtr.Zero,restricted=IntPtr.Zero,sid=Marshal.AllocHGlobal(68);
    bool impersonating=false;
    try {
      if(!OpenProcessToken(GetCurrentProcess(),14,out token))throw new Win32Exception();
      uint size=68;
      if(!CreateWellKnownSid(1,IntPtr.Zero,sid,ref size))throw new Win32Exception();
      var sids=new[]{new SidAndAttributes{Sid=sid}};
      if(!CreateRestrictedToken(token,1,0,IntPtr.Zero,0,IntPtr.Zero,1,sids,out restricted))throw new Win32Exception();
      if(!ImpersonateLoggedOnUser(restricted))throw new Win32Exception();
      impersonating=true;
      IntPtr client=CreateFile(name,0xC0000000,0,IntPtr.Zero,3,0,IntPtr.Zero);
      int error=Marshal.GetLastWin32Error();
      if(client!=new IntPtr(-1)){CloseHandle(client);return 0;}
      return error;
    } finally {
      if(impersonating)RevertToSelf();
      if(restricted!=IntPtr.Zero)CloseHandle(restricted);
      if(token!=IntPtr.Zero)CloseHandle(token);
      Marshal.FreeHGlobal(sid);
    }
  }
  public static int RemoteOpenError(string name) {
    IntPtr client=CreateFile(name,0xC0000000,0,IntPtr.Zero,3,0,IntPtr.Zero);
    int error=Marshal.GetLastWin32Error();
    if(client!=new IntPtr(-1)){CloseHandle(client);return 0;}
    return error;
  }
}
'@
}

function New-TestClient {
  $client = [IO.Pipes.NamedPipeClientStream]::new('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
  try { $client.Connect(10000); return $client } catch { $client.Dispose(); throw }
}
function Write-Frame($Client, [string]$Text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  $write = $Client.WriteAsync($bytes, 0, $bytes.Length)
  if (-not $write.Wait(5000)) { throw 'Pipe write exceeded 5 seconds.' }
}
function Read-Line($Client, [int]$Timeout = 5000) {
  $reader = [IO.StreamReader]::new($Client, [Text.Encoding]::UTF8, $false, 4096, $true)
  try {
    $read = $reader.ReadLineAsync()
    if (-not $read.Wait($Timeout)) { throw 'Pipe response exceeded timeout.' }
    return $read.GetAwaiter().GetResult()
  } finally { $reader.Dispose() }
}
function Invoke-TestRequest([hashtable]$Request) {
  $client = New-TestClient
  try {
    Write-Frame $client (($Request | ConvertTo-Json -Depth 8 -Compress) + "`n")
    $raw = Read-Line $client
    if (-not $raw) { throw 'Normal request was disconnected.' }
    $parsed = $raw | ConvertFrom-Json
    if ($parsed.error) { throw $parsed.error.message }
    return $parsed
  } finally { $client.Dispose() }
}
function Assert-Disconnected($Client) {
  $buffer = [byte[]]::new(1)
  $read = $Client.ReadAsync($buffer, 0, 1)
  try {
    if (-not $read.Wait(3500)) { throw 'Host did not recycle the client within 3.5 seconds.' }
    if ($read.GetAwaiter().GetResult() -ne 0) { throw 'Host answered a rejected frame.' }
  } catch {
    if ($_.Exception.ToString() -notmatch 'broken|closed|断开|关闭') { throw }
  }
}

function Assert-OriginalPipeOwner {
  if ($process.HasExited) { throw "Original PlayerHost exited: $($process.ExitCode)" }
  $client = New-TestClient
  try {
    $ownerId = [PlayerPipeSecurityCheck]::ServerProcessId($client.SafePipeHandle.DangerousGetHandle())
    if ($ownerId -ne $process.Id) { throw "Pipe owner changed: expected $($process.Id), got $ownerId" }
    Write-Frame $client ('{"id":"owner-check","method":"player.ping"}' + "`n")
    $reply = Read-Line $client | ConvertFrom-Json
    if ($reply.id -ne 'owner-check' -or -not $reply.result.ok) { throw 'Original pipe owner stopped responding.' }
    return $ownerId
  } finally { $client.Dispose() }
}

try {
  $sourceDll = Join-Path $root 'third_party/mpv/win-x64/libmpv-2.dll'
  $targetDll = Join-Path (Split-Path $Executable) 'libmpv-2.dll'
  if (Test-Path -LiteralPath $targetDll) {
    if ((Get-FileHash -LiteralPath $sourceDll -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $targetDll -Algorithm SHA256).Hash) { throw 'Native test DLL differs from the prepared runtime; prepare the runtime before testing.' }
  } else { Copy-Item -LiteralPath $sourceDll -Destination $targetDll }
  $process = Start-Process -FilePath $Executable -ArgumentList @('--pipe', $pipe, '--test-audio-output', 'null') -PassThru -WindowStyle Hidden
  $ping = Invoke-TestRequest @{ id='hardening-ready'; method='player.ping'; params=@{} }
  if (-not $ping.result.ok) { throw 'Test PlayerHost did not initialize.' }

  $aclClient = New-TestClient
  try {
    $sddl = [PlayerPipeSecurityCheck]::Dacl($aclClient.SafePipeHandle.DangerousGetHandle())
    $acl = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($acl.DiscretionaryAcl.Count -ne 1 -or $acl.DiscretionaryAcl[0].SecurityIdentifier.Value -ne $sid -or $acl.DiscretionaryAcl[0].AceType -ne [Security.AccessControl.AceType]::AccessAllowed) { throw "Pipe ACL exposes additional identities: $sddl" }
    $checks.Add(@{ name='current-user-only ACL'; passed=$true; sddl=$sddl })
  } finally { $aclClient.Dispose() }
  $denied = [PlayerPipeSecurityCheck]::RestrictedOpenError($pipe)
  if ($denied -ne 5) { throw "Restricted token pipe access was not denied: $denied" }
  $checks.Add(@{ name='restricted identity rejected'; passed=$true; win32Error=$denied })
  $remoteDenied = [PlayerPipeSecurityCheck]::RemoteOpenError(('\\127.0.0.1\pipe\' + $name))
  $checks.Add(@{ name='remote loopback rejected'; passed=($remoteDenied -eq 5); win32Error=$remoteDenied; expectedWin32Error=5 })
  if ($remoteDenied -ne 5) { Write-Warning "Remote loopback check did not return ERROR_ACCESS_DENIED: $remoteDenied. The overall test remains failed; continuing independent checks." }

  # Own the process handle directly, including when the duplicate exits immediately.
  # Do not retry failures or relax the 10 second deadline / exact exit-code assertion.
  $duplicateAttempts = @()
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $ownerBefore = Assert-OriginalPipeOwner
    $startInfo = [Diagnostics.ProcessStartInfo]::new((Resolve-Path $Executable).Path)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('--pipe', $pipe, '--test-audio-output', 'null')) { $startInfo.ArgumentList.Add($argument) }
    $collisionWatch = [Diagnostics.Stopwatch]::StartNew()
    $collision = [Diagnostics.Process]::Start($startInfo)
    $stderrRead = $collision.StandardError.ReadToEndAsync()
    $exited = $collision.WaitForExit(10000)
    $collisionWatch.Stop()
    $exitCode = if ($exited) { $collision.ExitCode } else { $null }
    try {
      if ($exited -and -not $stderrRead.IsCompleted) { [void]$stderrRead.Wait(1000) }
      $stderr = if ($stderrRead.IsCompleted) { $stderrRead.GetAwaiter().GetResult() } else { '<stderr still open>' }
    } catch { $stderr = '<stderr unavailable: ' + $_.Exception.Message + '>' }
    $observation = @{ attempt=$attempt; processId=$collision.Id; exited=$exited; exitCode=$exitCode; elapsedMs=$collisionWatch.ElapsedMilliseconds; originalProcessId=$ownerBefore; stderr=$stderr }
    # Write immediately, so evidence survives a failing assertion or later test.
    Write-Host ('Duplicate server observation: ' + ($observation | ConvertTo-Json -Compress))
    if (-not $exited) { throw "Duplicate server did not fail closed: attempt $attempt timed out after 10000 ms. stderr: $stderr" }
    if ($exitCode -ne 2) { throw "Duplicate server did not fail closed: attempt $attempt exited with $exitCode, expected 2. stderr: $stderr" }
    $observation.ownerAfter = Assert-OriginalPipeOwner
    Write-Host ('Duplicate server verified: ' + ($observation | ConvertTo-Json -Compress))
    $duplicateAttempts += $observation
    $collision.Dispose()
    $collision = $null
  }
  $checks.Add(@{ name='duplicate server rejected'; passed=$true; exitCode=2; attempts=$duplicateAttempts })

  for ($i=0; $i -lt 4; $i++) { $clients.Add((New-TestClient)) }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $ping = Invoke-TestRequest @{ id='after-idle'; method='player.ping'; params=@{} }
  $watch.Stop()
  if (-not $ping.result.ok -or $watch.ElapsedMilliseconds -gt 3500) { throw 'Four idle clients blocked a new request.' }
  foreach ($client in $clients) { Assert-Disconnected $client; $client.Dispose() }; $clients.Clear()
  $checks.Add(@{ name='four idle clients recycled'; passed=$true; recoveryMs=$watch.ElapsedMilliseconds })

  # Enough valid requests to fill each response buffer while the clients refuse to read.
  $unreadBytes = [Text.Encoding]::UTF8.GetBytes((('{"id":"unread","method":"player.ping"}' + "`n") * 4096))
  $unreadWrites = @()
  for ($i=0; $i -lt 4; $i++) {
    $client = New-TestClient
    $clients.Add($client)
    $unreadWrites += $client.WriteAsync($unreadBytes, 0, $unreadBytes.Length)
  }
  $watch.Restart()
  $ping = Invoke-TestRequest @{ id='after-unread'; method='player.ping'; params=@{} }
  $watch.Stop()
  if (-not $ping.result.ok -or $watch.ElapsedMilliseconds -gt 3500) { throw 'Clients refusing to read responses blocked every slot.' }
  foreach ($client in $clients) { $client.Dispose() }; $clients.Clear()
  foreach ($write in $unreadWrites) { try { [void]$write.Wait(1000) } catch { if ($_.Exception.ToString() -notmatch 'broken|closed|disposed|cancel|断开|关闭') { throw } } }
  $checks.Add(@{ name='four unread response clients recycled'; passed=$true; recoveryMs=$watch.ElapsedMilliseconds })

  foreach ($withNewline in @($false, $true)) {
    $client = New-TestClient
    try {
      $oversized = 'x' * 65537
      if ($withNewline) { $oversized += "`n" }
      Write-Frame $client $oversized
      Assert-Disconnected $client
      $checks.Add(@{ name="oversized frame rejected (newline=$withNewline)"; passed=$true; frameBytes=65537 })
    } finally { $client.Dispose() }
  }

  $client = New-TestClient
  try {
    $watch.Restart()
    for ($i=0; $i -lt 4; $i++) { Write-Frame $client 'x'; Start-Sleep -Milliseconds 400 }
    Assert-Disconnected $client
    $watch.Stop()
    if ($watch.ElapsedMilliseconds -gt 3000) { throw 'Drip-fed frame extended the deadline.' }
    $checks.Add(@{ name='partial frame absolute deadline'; passed=$true; recoveryMs=$watch.ElapsedMilliseconds })
  } finally { $client.Dispose() }

  $client = New-TestClient
  try {
    $boundary = @{ id='boundary'; method='player.ping'; params=@{} } | ConvertTo-Json -Compress
    $boundary += ' ' * (65536 - [Text.Encoding]::UTF8.GetByteCount($boundary))
    Write-Frame $client ($boundary + "`n")
    if (-not ((Read-Line $client | ConvertFrom-Json).result.ok)) { throw '64 KiB frame boundary was rejected.' }
    Write-Frame $client ((@{ id='reuse'; method='player.ping'; params=@{} } | ConvertTo-Json -Compress) + "`n")
    if (-not ((Read-Line $client | ConvertFrom-Json).result.ok)) { throw 'Persistent connection stopped accepting frames.' }
    $checks.Add(@{ name='64 KiB boundary and persistent frames'; passed=$true })
  } finally { $client.Dispose() }

  $binary = [IO.BinaryWriter]::new([IO.File]::Create($wav))
  try {
    $binary.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $binary.Write([int]160036)
    $binary.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $binary.Write([int]16)
    $binary.Write([int16]1); $binary.Write([int16]1); $binary.Write([int]8000); $binary.Write([int]16000)
    $binary.Write([int16]2); $binary.Write([int16]16); $binary.Write([Text.Encoding]::ASCII.GetBytes('data'))
    $binary.Write([int]160000); $binary.Write([byte[]]::new(160000))
  } finally { $binary.Dispose() }
  $mediaUri = ([Uri]$wav).AbsoluteUri
  $parallel = 1..24 | ForEach-Object -Parallel {
    $requestIndex = $_
    $client = [IO.Pipes.NamedPipeClientStream]::new('.', $using:name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try {
      $client.Connect(10000)
      switch ($requestIndex % 3) {
        0 { $request = @{ id="concurrent-$requestIndex"; method='player.load'; params=@{url=$using:mediaUri; profile='vod'} } }
        1 { $request = @{ id="concurrent-$requestIndex"; method='player.query'; params=@{query='stats'} } }
        2 { $request = @{ id="concurrent-$requestIndex"; method='player.command'; params=@{command='pause'; value=$true} } }
      }
      $writer = [IO.StreamWriter]::new($client); $writer.AutoFlush=$true
      $reader = [IO.StreamReader]::new($client)
      $writer.WriteLine(($request | ConvertTo-Json -Depth 6 -Compress))
      $read = $reader.ReadLineAsync()
      if (-not $read.Wait(10000)) { throw 'Concurrent request timed out.' }
      $result = $read.GetAwaiter().GetResult() | ConvertFrom-Json
      if ($result.error -or $result.id -ne "concurrent-$requestIndex") { throw "Concurrent request failed: $($result | ConvertTo-Json -Compress)" }
      $result.id
    } finally { $client.Dispose() }
  } -ThrottleLimit 12
  if ($parallel.Count -ne 24) { throw 'Concurrent stats/load/command did not all complete.' }
  $checks.Add(@{ name='concurrent stats/load/command'; passed=$true; requests=$parallel.Count })
  $final = Invoke-TestRequest @{ id='hardening-final'; method='player.ping'; params=@{} }
  if (-not $final.result.ok) { throw 'Host did not remain responsive.' }

  $allPassed = @($checks | Where-Object { -not $_.passed }).Count -eq 0
  $evidence = @{ checkedAt=[DateTime]::UtcNow.ToString('o'); executable=(Resolve-Path $Executable).Path; executableSha256=(Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash; processId=$process.Id; checks=$checks.ToArray(); passed=$allPassed }
  $json = $evidence | ConvertTo-Json -Depth 8
  if ($EvidencePath) { $json | Set-Content -LiteralPath $EvidencePath -Encoding utf8 }
  Write-Output $json
  if (-not $allPassed) { throw 'One or more native pipe checks did not pass; see the individual evidence results.' }
} finally {
  foreach ($client in $clients) { $client.Dispose() }
  foreach ($testProcess in @($collision, $process)) { if ($testProcess -and -not $testProcess.HasExited) { Stop-Process -Id $testProcess.Id -Force } }
  if (Test-Path -LiteralPath $wav) { Remove-Item -LiteralPath $wav -Force }
}
