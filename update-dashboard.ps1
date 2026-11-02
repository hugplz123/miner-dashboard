param(
    [int]$Days = 7,
    [int]$Jobs = 3,
    [string]$Date = ""
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# Only the newest day is queried; the other days are reused from outputs/.
$arguments = @("run_rolling.py", "--days", $Days, "--jobs", $Jobs, "--skip-existing")
if ($Date) {
    $arguments += @("--date", $Date)
}

python @arguments

if ($LASTEXITCODE -ne 0) {
    throw "Dashboard update failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Done. Preview: http://127.0.0.1:8765/" -ForegroundColor Green
