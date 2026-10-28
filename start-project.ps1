$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$postgresService = "bioeconomy-postgresql-17"

$uv = Join-Path $env:APPDATA "Python\Python312\Scripts\uv.exe"
if (-not (Test-Path -LiteralPath $uv)) {
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    if ($uvCommand) { $uv = $uvCommand.Source }
}

$pnpm = Join-Path $env:LOCALAPPDATA "Programs\pnpm\pnpm.exe"
if (-not (Test-Path -LiteralPath $pnpm)) {
    $pnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
}

if (-not (Test-Path -LiteralPath $uv)) {
    throw "Could not find uv. Install uv or update the uv path in start-project.ps1."
}
if (-not (Test-Path -LiteralPath $pnpm)) {
    $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpmCommand) { $pnpm = $pnpmCommand.Source }
    else { throw "Could not find pnpm. Install pnpm or update the pnpm path in start-project.ps1." }
}

$service = Get-Service -Name $postgresService -ErrorAction SilentlyContinue
if (-not $service) {
    throw "PostgreSQL service '$postgresService' was not found. Install PostgreSQL 17 first."
}
if ($service.Status -ne "Running") {
    Write-Host "Starting PostgreSQL..."
    Start-Service -Name $postgresService
    (Get-Service -Name $postgresService).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
}

Write-Host "Applying database migrations..."
Push-Location $backend
try {
    & $uv run alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "Database migration failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

$backendCommand = "& '$uv' run uvicorn backend.main:app --host 127.0.0.1 --port 49173"
$backendWindow = Start-Process -FilePath "powershell.exe" -WorkingDirectory $backend `
    -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $backendCommand) `
    -PassThru

$frontendCommand = "& '$pnpm' run dev"
$frontendWindow = Start-Process -FilePath "powershell.exe" -WorkingDirectory $frontend `
    -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $frontendCommand) `
    -PassThru

Write-Host ""
Write-Host "Bioeconomy is starting. Keep the two server terminals open while using the app."
Write-Host "Frontend: http://localhost:5173"
Write-Host "Backend:  http://127.0.0.1:49173"
Write-Host "API docs: http://127.0.0.1:49173/docs"
Write-Host "Backend terminal PID: $($backendWindow.Id)"
Write-Host "Frontend terminal PID: $($frontendWindow.Id)"

Write-Host "Waiting for the frontend and API to become ready..."
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:49173/api/v1/health" -TimeoutSec 2
        $null = Invoke-WebRequest -Uri "http://localhost:5173/" -UseBasicParsing -TimeoutSec 2
        $ready = $true
        break
    }
    catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $ready) {
    Write-Warning "The servers did not both respond within 30 seconds. Check the backend and frontend terminals for errors."
}
Start-Process "http://localhost:5173"
