# Multi-TF / multi-strategy backtest sweep for Trade Alert tabs.
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\testAllTabsTf.ps1
#
# Parses COMPARE / funnel lines and prints trades-per-day.

$ErrorActionPreference = "Continue"
$dir = Join-Path $PSScriptRoot "..\data" | Resolve-Path
$outDir = Join-Path $dir "_tf_sweep"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$tfs = @("M1", "M5", "M15", "H1", "H4")
# Isolated tabs assume base bars + HTF resample; still useful as relative TF stress test.
$strategies = @(
  @{ Name = "main_scalp";     Args = "--strategy=main --mode=scalping" },
  @{ Name = "main_intraday";  Args = "--strategy=main --mode=intraday" },
  @{ Name = "quick_scalp";    Args = "--strategy=quick_scalp" },
  @{ Name = "pro";            Args = "--strategy=pro" },
  @{ Name = "cipher_b";       Args = "--strategy=cipher_b_clone" },
  @{ Name = "fractal";        Args = "--strategy=fractal" }
)

$days = 365
$spread = 0.25
$rows = @()

function Parse-Result([string]$text, [string]$tf, [string]$strat) {
  $signals = $null
  $resolved = $null
  $wr = $null
  $avgR = $null
  $range = $null

  if ($text -match "Range\s*:\s*(\S+)\s*→\s*(\S+)") {
    $range = "$($Matches[1]) → $($Matches[2])"
  }
  if ($text -match "Plans locked \(stage 1\)\s*:\s*(\d+)") {
    $signals = [int]$Matches[1]
  }
  elseif ($text -match "Signals fired\s*:\s*(\d+)") {
    $signals = [int]$Matches[1]
  }
  elseif ($text -match "signals=(\d+)") {
    $signals = [int]$Matches[1]
  }

  if ($text -match "Resolved \(TP1/SL\)\s*:\s*(\d+)") {
    $resolved = [int]$Matches[1]
  }
  elseif ($text -match "Zone touched \(stage 2\)\s*:\s*(\d+)") {
    $resolved = [int]$Matches[1]
  }
  elseif ($text -match "resolved=(\d+)") {
    $resolved = [int]$Matches[1]
  }

  if ($text -match "TP1 win rate\s*:\s*([\d.]+)%") {
    $wr = [double]$Matches[1]
  }
  elseif ($text -match "Conditional TP1 win%\s*:\s*([\d.]+)%") {
    $wr = [double]$Matches[1]
  }
  elseif ($text -match "winRate=([\d.]+)%") {
    $wr = [double]$Matches[1]
  }

  if ($text -match "Avg R \(TP1\)\s*:\s*([-\d.]+)") {
    $avgR = [double]$Matches[1]
  }
  elseif ($text -match "Avg realizedR_full \(touch\)\s*:\s*([-\d.]+)") {
    $avgR = [double]$Matches[1]
  }
  elseif ($text -match "avgR=([-\d.]+)") {
    $avgR = [double]$Matches[1]
  }

  $tpd = if ($signals -ne $null -and $days -gt 0) { [math]::Round($signals / $days, 2) } else { $null }

  [pscustomobject]@{
    TF          = $tf
    Strategy    = $strat
    Signals     = $signals
    Resolved    = $resolved
    WinRatePct  = $wr
    AvgR        = $avgR
    TradesPerDay= $tpd
    Days        = $days
    Range       = $range
  }
}

Push-Location (Join-Path $PSScriptRoot "..")
try {
  foreach ($tf in $tfs) {
    $file = Join-Path $dir "XAUUSD_$tf.json"
    if (-not (Test-Path $file)) {
      Write-Host "SKIP missing $file" -ForegroundColor Yellow
      continue
    }
    foreach ($s in $strategies) {
      $label = "$tf / $($s.Name)"
      Write-Host "`n===== $label =====" -ForegroundColor Cyan
      $log = Join-Path $outDir "$tf`_$($s.Name).txt"
      $cmd = "npm run backtest -- --file=`"$file`" --days=$days --spread=$spread $($s.Args)"
      Write-Host $cmd
      $output = cmd /c "$cmd 2>&1"
      $output | Set-Content -Path $log -Encoding UTF8
      $joined = ($output -join "`n")
      $row = Parse-Result $joined $tf $s.Name
      $rows += $row
      Write-Host ("  signals={0} resolved={1} wr={2}% avgR={3} trades/day={4}" -f `
        $row.Signals, $row.Resolved, $row.WinRatePct, $row.AvgR, $row.TradesPerDay)
    }
  }
}
finally {
  Pop-Location
}

$csv = Join-Path $outDir "summary.csv"
$rows | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8

Write-Host "`n========== SUMMARY (trades/day ≈ signals / $days) ==========" -ForegroundColor Green
$rows | Format-Table -AutoSize TF, Strategy, Signals, Resolved, WinRatePct, AvgR, TradesPerDay
Write-Host "CSV: $csv"
Write-Host "Logs: $outDir"
