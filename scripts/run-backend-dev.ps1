$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot "backend"
$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
$uv = if ($uvCommand) { $uvCommand.Source } else { $null }

if (-not $uv) {
    $candidates = @(
        (Join-Path $env:APPDATA "Python\Python312\Scripts\uv.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\uv.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { $uv = $candidate; break }
    }
}

if (-not $uv) {
    Write-Error "Could not find uv. Install uv from https://docs.astral.sh/uv/getting-started/installation/ or add its install directory to PATH."
    exit 1
}

Push-Location $backendDir
try {
    & $uv run uvicorn backend.main:app --host 127.0.0.1 --port 49173
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
