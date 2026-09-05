$ErrorActionPreference = 'Stop'
$tag = '2026-08-28-182fa6ca49'
$commit = '182fa6ca49f455cadb884858f386e2f00540aeb7'
$asset = 'mpv-dev-lgpl-x86_64-20260828-git-182fa6ca49.7z'
$url = "https://github.com/zhongfly/mpv-winbuild/releases/download/$tag/$asset"
$expectedSha256 = '66e75ef9db1be87dcfc140632456fb0475a94694686391fbbcde8cb523ee4070'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'third_party/mpv/win-x64'
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('free-new-desk-mpv-' + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $tempDir $asset
New-Item -ItemType Directory -Force -Path $outDir,$tempDir | Out-Null
try {
  Invoke-WebRequest -Uri $url -OutFile $archive
  $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant()
  if ($actual -ne $expectedSha256) { throw "libmpv archive SHA256 mismatch: $actual" }
  $sevenZip = (Get-Command 7z -ErrorAction Stop).Source
  $expanded = Join-Path $tempDir 'expanded'
  New-Item -ItemType Directory -Force -Path $expanded | Out-Null
  & $sevenZip x $archive "-o$expanded" -y | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "7z extraction failed with exit code $LASTEXITCODE" }
  $dll = Get-ChildItem -Path $expanded -Recurse -Filter 'libmpv-2.dll' | Select-Object -First 1
  if (-not $dll) { throw 'Pinned LGPL mpv-dev archive does not contain libmpv-2.dll' }
  Copy-Item $dll.FullName (Join-Path $outDir 'libmpv-2.dll') -Force
  @"
provider: zhongfly/mpv-winbuild
tag: $tag
mpv commit: $commit
asset: $asset
source: $url
archive sha256: $expectedSha256
upstream mpv: https://github.com/mpv-player/mpv
build declaration: mpv-dev-lgpl (libmpv LGPLv2.1+, FFmpeg LGPLv3 as declared by provider)
notes: dynamically loaded by PlayerHost; retain upstream/provider license notices when redistributing.
"@ | Set-Content -Encoding UTF8 (Join-Path $outDir 'SOURCE.txt')
  Write-Host "Prepared pinned LGPL libmpv runtime at $outDir"
} finally {
  Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}
