param(
    [int]$Days = 7,
    [int]$Jobs = 3,
    [string]$Date = "",
    [switch]$NoPublish,
    [switch]$SkipVerify,
    [switch]$Refresh,
    [switch]$BackfillDetails,
    [string]$DetailDates = ""
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$PendingDetailDates = "20261120,20261121"
$DetailSites = @("Nimrod01", "Nimrod02", "WhiteOak01", "May01", "Blossom01")

function Resolve-Git {
    $command = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        "$env:ProgramFiles\Git\cmd\git.exe",
        "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
        "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe",
        "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "Git was not found. Install Git for Windows or make git.exe available in PATH."
}

function Push-Dashboard($git) {
    & $git push
    if ($LASTEXITCODE -eq 0) { return }

    Write-Host "Standard push failed; retrying through a GitHub endpoint..." `
        -ForegroundColor Yellow
    foreach ($ip in @("140.82.112.4", "140.82.113.4", "140.82.114.4")) {
        & $git -c "http.curloptResolve=github.com:443:$ip" push
        if ($LASTEXITCODE -eq 0) { return }
    }
    throw "Dashboard was committed locally, but git push failed."
}

function Resolve-DetailDatesToExport(
    [string]$manualDates,
    [string]$pendingDates,
    [datetime]$endDate,
    [int]$days
) {
    $windowStart = $endDate.Date.AddDays(-($days - 1))
    $windowEnd = $endDate.Date
    $sources = @()
    if ($manualDates) { $sources += $manualDates }
    if ($pendingDates) { $sources += $pendingDates }
    $resolved = @()
    foreach ($source in $sources) {
        foreach ($item in ([string]$source -split ",")) {
            $dateKey = $item.Trim()
            if (-not $dateKey) { continue }
            try {
                $parsedDate = [datetime]::ParseExact(
                    $dateKey, "yyyyMMdd",
                    [Globalization.CultureInfo]::InvariantCulture
                ).Date
            }
            catch {
                throw "DetailDates must use YYYYMMDD, for example 20261120."
            }
            if ($parsedDate -lt $windowStart -or $parsedDate -gt $windowEnd) {
                Write-Host "Skip detail date $dateKey because it is outside the rolling window." `
                    -ForegroundColor Yellow
                continue
            }
            $missingDetail = $false
            foreach ($site in $DetailSites) {
                $detailFile = Join-Path $PSScriptRoot (
                    "outputs\detail-cache\{0}\{1}_{0}_dashboard.json" -f
                    $dateKey, $site.ToLowerInvariant()
                )
                if (-not (Test-Path -LiteralPath $detailFile)) {
                    $missingDetail = $true
                    break
                }
            }
            if ($missingDetail) { $resolved += $dateKey }
        }
    }
    return @($resolved | Sort-Object -Unique)
}

# Refresh and archive the public Lark capacity snapshot for the completed day.
if ($Date) {
    try {
        $endDate = [datetime]::ParseExact(
            $Date, "yyyyMMdd",
            [Globalization.CultureInfo]::InvariantCulture
        ).Date
    }
    catch {
        throw "Date must use YYYYMMDD, for example 20261108."
    }
}
else {
    $endDate = [DateTime]::UtcNow.Date.AddDays(-1)
}
$snapshotDate = $endDate.ToString("yyyy-MM-dd")

& python sync_lark_model_levels.py
if ($LASTEXITCODE -ne 0) {
    $modelLevelSnapshot = "dashboard\data\model_levels.json"
    if (Test-Path -LiteralPath $modelLevelSnapshot) {
        Write-Host "Lark model-level sync failed; reusing the local mapping." `
            -ForegroundColor Yellow
    }
    else {
        throw "Lark model-level sync failed and no local mapping is available."
    }
}

& python sync_lark_power.py --snapshot-date $snapshotDate
if ($LASTEXITCODE -ne 0) {
    $larkSnapshot = "dashboard\data\lark_power.json"
    if (Test-Path -LiteralPath $larkSnapshot) {
        $existingSnapshot = Get-Content -LiteralPath $larkSnapshot -Raw |
            ConvertFrom-Json
        if ($existingSnapshot.snapshot_date -eq $snapshotDate) {
            Write-Host "Lark sync failed; reusing the existing $snapshotDate snapshot." `
                -ForegroundColor Yellow
        }
        else {
            throw "Lark sync failed and no $snapshotDate snapshot is available. Dashboard was not published."
        }
    }
    else {
        throw "Lark sync failed and no local snapshot is available."
    }
}

$meterEndDate = $snapshotDate.Replace("-", "")
& python sync_supabase_power.py --end $meterEndDate --days $Days
if ($LASTEXITCODE -ne 0) {
    $meterSnapshot = "dashboard\data\supabase_power.json"
    if (Test-Path -LiteralPath $meterSnapshot) {
        Write-Host "Supabase meter sync failed; reusing the existing snapshot." `
            -ForegroundColor Yellow
    }
    else {
        throw "Supabase meter sync failed and no local snapshot is available."
    }
}

# Only the newest day is queried; the other days are reused from outputs/.
$arguments = @("run_rolling.py", "--days", $Days, "--jobs", $Jobs, "--skip-existing")
if ($Date) {
    $arguments += @("--date", $Date)
}
if ($Refresh) {
    $arguments += "--refresh-latest"
}
if ($BackfillDetails) {
    $arguments += "--backfill-details"
}
$detailDatesToExport = Resolve-DetailDatesToExport `
    $DetailDates $PendingDetailDates $endDate $Days
if ($detailDatesToExport.Count) {
    $detailDateArgument = $detailDatesToExport -join ","
    Write-Host "Queued full detail for: $detailDateArgument" `
        -ForegroundColor Cyan
    $arguments += @("--detail-dates", $detailDateArgument)
}

& python @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Dashboard update failed with exit code $LASTEXITCODE"
}

$catalog = Get-Content -LiteralPath "dashboard\data\catalog.json" -Raw |
    ConvertFrom-Json
$latestDate = $catalog.latest_date

if (-not $SkipVerify) {
    & node verify_dashboard.cjs --data-only
    if ($LASTEXITCODE -ne 0) {
        throw "Dashboard verification failed with exit code $LASTEXITCODE"
    }
}

if (-not $NoPublish) {
    $git = Resolve-Git
    & $git add -- dashboard
    if ($LASTEXITCODE -ne 0) {
        throw "Could not stage dashboard files"
    }

    & $git diff --cached --quiet -- dashboard
    $hasDashboardChanges = $LASTEXITCODE -ne 0
    if ($hasDashboardChanges) {
        & $git commit -m "Refresh dashboard through $latestDate" -- dashboard
        if ($LASTEXITCODE -ne 0) {
            throw "Could not commit dashboard files"
        }

        Push-Dashboard $git
        Write-Host "Published: https://hugplz123.github.io/miner-dashboard/" `
            -ForegroundColor Green
    }
    else {
        Write-Host "No dashboard changes to publish." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Done through $latestDate." -ForegroundColor Green
Write-Host "Local preview: http://127.0.0.1:8765/"
Write-Host "Online dashboard: https://hugplz123.github.io/miner-dashboard/"
