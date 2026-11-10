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

# Refresh and archive the public Lark capacity snapshot for the completed day.
if ($Date) {
    try {
        $snapshotDate = [datetime]::ParseExact(
            $Date, "yyyyMMdd", $null
        ).ToString("yyyy-MM-dd")
    }
    catch {
        throw "Date must use YYYYMMDD, for example 20261108."
    }
}
else {
    $snapshotDate = (Get-Date).Date.AddDays(-1).ToString("yyyy-MM-dd")
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
