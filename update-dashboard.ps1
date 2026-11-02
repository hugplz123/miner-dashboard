param(
    [int]$Days = 7,
    [int]$Jobs = 3,
    [string]$Date = "",
    [switch]$NoPublish,
    [switch]$SkipVerify,
    [switch]$Refresh
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# Only the newest day is queried; the other days are reused from outputs/.
$arguments = @("run_rolling.py", "--days", $Days, "--jobs", $Jobs, "--skip-existing")
if ($Date) {
    $arguments += @("--date", $Date)
}
if ($Refresh) {
    $arguments += "--refresh-latest"
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
    & git add -- dashboard
    if ($LASTEXITCODE -ne 0) {
        throw "Could not stage dashboard files"
    }

    & git diff --cached --quiet -- dashboard
    $hasDashboardChanges = $LASTEXITCODE -ne 0
    if ($hasDashboardChanges) {
        & git commit -m "Refresh dashboard through $latestDate" -- dashboard
        if ($LASTEXITCODE -ne 0) {
            throw "Could not commit dashboard files"
        }

        & git push
        if ($LASTEXITCODE -ne 0) {
            throw "Dashboard was committed locally, but git push failed"
        }
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
