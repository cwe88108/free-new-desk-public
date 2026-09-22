[CmdletBinding()]
param(
  [string]$AppPath = '',
  [double[]]$Scales = @(1, 1.25, 1.5, 2),
  [switch]$DpiOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$smoke = Join-Path $PSScriptRoot 'test-packaged-ui.ps1'
$outputDir = Join-Path $root 'dist/ui-smoke'
$results = New-Object 'System.Collections.Generic.List[object]'
$contrasts = if ($DpiOnly) { @($false) } else { @($false, $true) }

foreach ($scale in $Scales) {
  foreach ($highContrast in $contrasts) {
    $started = Get-Date
    $passed = $false
    $lastError = $null
    $attempts = 0
    while (-not $passed -and $attempts -lt 2) {
      $attempts += 1
      try {
        $arguments = @{ Scale = $scale }
        if ($AppPath) { $arguments.AppPath = $AppPath }
        if ($highContrast) { $arguments.HighContrast = $true }
        & $smoke @arguments
        $passed = $true
      } catch {
        $lastError = $_.Exception.Message
        Write-Warning "UI matrix case scale=$scale highContrast=$highContrast attempt=$attempts failed: $lastError"
      }
    }
    $results.Add([pscustomobject]@{ scale = $scale; highContrast = $highContrast; passed = $passed; attempts = $attempts; durationMs = [int]((Get-Date) - $started).TotalMilliseconds; error = $(if ($passed) { $null } else { $lastError }) })
  }
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$summaryPath = Join-Path $outputDir 'matrix-summary.json'
$results | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $summaryPath
$failed = @($results | Where-Object { -not $_.passed })
Write-Host "Packaged UI matrix complete: $($results.Count - $failed.Count)/$($results.Count) passed. Summary: $summaryPath"
if ($failed.Count) { throw "$($failed.Count) packaged UI matrix case(s) failed." }
