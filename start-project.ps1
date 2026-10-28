param([switch]$Tunnel)
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

$node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path -LiteralPath $node)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $node = $nodeCommand.Source }
}

$pnpm = Join-Path $env:LOCALAPPDATA "Programs\pnpm\pnpm.exe"
if (-not (Test-Path -LiteralPath $pnpm)) {
    $pnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
}

$apiAlreadyResponds = $false
$frontendAlreadyResponds = $false
try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:49173/api/v1/health" -TimeoutSec 2; $apiAlreadyResponds = $true } catch {}
try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:5173/" -UseBasicParsing -TimeoutSec 2; $frontendAlreadyResponds = $true } catch {}
if ($apiAlreadyResponds -and $frontendAlreadyResponds) {
    if ($Tunnel) { throw "Bioeconomy is already running in local-only mode. Stop that server terminal before starting public tunnel mode." }
    Write-Host "Bioeconomy is already running. Opening http://127.0.0.1:5173"
    Start-Process "http://127.0.0.1:5173"
    exit 0
}
if ($apiAlreadyResponds -or $frontendAlreadyResponds) {
    throw "One Bioeconomy port is already occupied. Close the existing server terminal before starting the project again."
}

if (-not (Test-Path -LiteralPath (Join-Path $frontend "node_modules\.bin\concurrently.cmd"))) {
    Write-Host "Installing frontend dependencies..."
    Push-Location $frontend
    try {
        & $pnpm install --no-lockfile
        if ($LASTEXITCODE -ne 0) { throw "Frontend dependency installation failed with exit code $LASTEXITCODE." }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $uv)) {
    throw "Could not find uv. Install uv or update the uv path in start-project.ps1."
}
if (-not (Test-Path -LiteralPath $node)) {
    throw "Could not find Node.js. Install Node.js or update the node path in start-project.ps1."
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

# frontend/package.json's dev script starts uvicorn and Vite through
# concurrently. Expose the installed tool paths to the frontend process.
$env:Path = "$(Split-Path -Parent $uv);$(Split-Path -Parent $node);$env:Path"
$devScript = if ($Tunnel) { "dev:tunnel" } else { "dev" }
$frontendCommand = "& '$pnpm' run $devScript"
if ($Tunnel) {
    $tunnelLogRoot = Join-Path $env:TEMP "bioeconomy-cloudflare"
    New-Item -ItemType Directory -Path $tunnelLogRoot -Force | Out-Null
    Remove-Item -LiteralPath (Join-Path $tunnelLogRoot "cloudflared.stdout.log"), (Join-Path $tunnelLogRoot "cloudflared.stderr.log") -Force -ErrorAction SilentlyContinue
}
$frontendWindow = Start-Process -FilePath "powershell.exe" -WorkingDirectory $frontend `
    -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $frontendCommand) `
    -PassThru

Write-Host ""
Write-Host "Bioeconomy is starting. Keep the server terminal open while using the app."
if ($Tunnel) { Write-Host "Public development mode: cloudflared Quick Tunnel" }
Write-Host "Frontend: http://127.0.0.1:5173"
Write-Host "Backend:  http://127.0.0.1:49173"
Write-Host "API docs: http://127.0.0.1:49173/docs"
Write-Host "Server terminal PID: $($frontendWindow.Id)"

Write-Host "Waiting for the frontend and API to become ready..."
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:49173/api/v1/health" -TimeoutSec 2
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:5173/" -UseBasicParsing -TimeoutSec 2
        $ready = $true
        break
    }
    catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $ready) {
    if ($Tunnel) { throw "Public development mode did not start the local frontend and API within 30 seconds. Check the server terminal for errors." }
    Write-Warning "The servers did not both respond within 30 seconds. Check the backend and frontend terminals for errors."
}
if ($Tunnel) {
    $tunnelUrl = $null
    $logFiles = @(
        (Join-Path $env:TEMP "bioeconomy-cloudflare\cloudflared.stdout.log"),
        (Join-Path $env:TEMP "bioeconomy-cloudflare\cloudflared.stderr.log")
    )
    $urlDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $urlDeadline -and -not $tunnelUrl) {
        foreach ($logFile in $logFiles) {
            if (Test-Path -LiteralPath $logFile) {
                $logText = Get-Content -LiteralPath $logFile -Raw -ErrorAction SilentlyContinue
                if ($logText -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
                    $tunnelUrl = $Matches[0]
                    break
                }
            }
        }
        if (-not $tunnelUrl) { Start-Sleep -Milliseconds 250 }
    }
    if ($tunnelUrl) {
        Write-Host ""
        Write-Host "Quick Tunnel URL: $tunnelUrl"
        Write-Host "Copy this URL from here; it stays active while the server terminal is running."
    } else {
        Write-Warning "The local app started, but the tunnel URL was not found in the cloudflared logs. Check the public server terminal."
    }
}
if (-not $Tunnel) { Start-Process "http://127.0.0.1:5173" }
