param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

function Write-Step([string]$Message) { Write-Host "`n[Bioeconomy setup] $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { throw $Message }
function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
function Invoke-WingetInstall([string]$Id, [string]$Label, [switch]$Interactive) {
    if (-not (Test-Command 'winget')) { Fail "Install $Label manually: winget is unavailable. See https://learn.microsoft.com/windows/package-manager/winget/" }
    Write-Step "Checking official winget package availability for $Label ($Id)."
    & winget show --id $Id --exact --accept-source-agreements *> $null
    if ($LASTEXITCODE -ne 0) { Fail "winget could not find $Id. Install $Label from its official download page, then rerun setup." }
    Write-Step "Installing $Label from the verified winget package source."
    $args = @('install', '--id', $Id, '--exact', '--accept-source-agreements', '--accept-package-agreements')
    if (-not $Interactive) { $args += '--silent' }
    & winget @args
    if ($LASTEXITCODE -ne 0) { Fail "winget installation of $Label failed with exit code $LASTEXITCODE." }
}
function Refresh-UserPath {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $env:Path = "$userPath;$machinePath;$env:Path"
    $uvCandidate = Join-Path $HOME '.local\bin'
    if (Test-Path $uvCandidate) { $env:Path = "$uvCandidate;$env:Path" }
    $nodeCandidate = Join-Path $env:ProgramFiles 'nodejs'
    if (Test-Path $nodeCandidate) { $env:Path = "$nodeCandidate;$env:Path" }
}
function Assert-MinNode {
    $version = (& node -p 'process.versions.node' 2>$null)
    if (-not $version) { Fail 'Node.js is still unavailable. Open a new terminal or install Node.js 22 LTS from https://nodejs.org/en/download/.' }
    $v = [version]$version
    if (-not (($v.Major -eq 20 -and $v.Minor -ge 19) -or ($v.Major -eq 22 -and $v.Minor -ge 12) -or ($v.Major -gt 22 -and $v.Major % 2 -eq 0))) { Fail "Node.js $version found; install Node.js 20.19+, 22.12+, or a newer even-numbered LTS from https://nodejs.org/en/download/." }
}

Write-Step "Windows $([Environment]::OSVersion.Version); PowerShell $($PSVersionTable.PSVersion); architecture $env:PROCESSOR_ARCHITECTURE"
Refresh-UserPath
if (-not (Test-Command 'git')) { Invoke-WingetInstall 'Git.Git' 'Git'; Refresh-UserPath }
if (-not (Test-Command 'node')) { Invoke-WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js LTS'; Refresh-UserPath }
if (-not (Test-Command 'npm.cmd')) { Invoke-WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js LTS (includes npm)'; Refresh-UserPath }
if (-not (Test-Command 'npm.cmd')) { Fail 'npm.cmd is still unavailable. Reopen PowerShell or install Node.js LTS from https://nodejs.org/en/download/.' }
Assert-MinNode
if (-not (Test-Command 'uv')) { Invoke-WingetInstall 'astral-sh.uv' 'uv'; Refresh-UserPath }
if (-not (Test-Command 'uv')) { Fail 'uv was installed but is not available in PATH. Reopen PowerShell and run setup again.' }

$python = Get-Command py -ErrorAction SilentlyContinue
if ($python) {
    & $python.Source -3.14 --version *> $null
}
if (-not $python -or $LASTEXITCODE -ne 0) {
    Invoke-WingetInstall 'Python.Python.3.14' 'Python 3.14'
    Refresh-UserPath
}
& uv python install 3.14
if ($LASTEXITCODE -ne 0) { Fail 'uv could not install/find Python 3.14. See https://www.python.org/downloads/ and rerun setup.' }

$service = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^postgresql' -or $_.DisplayName -match 'PostgreSQL' } | Sort-Object Name -Descending | Select-Object -First 1
if (-not (Test-Command 'psql') -and -not $service) {
    Invoke-WingetInstall 'PostgreSQL.PostgreSQL.18' 'PostgreSQL 18' -Interactive
    Refresh-UserPath
    $service = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^postgresql' -or $_.DisplayName -match 'PostgreSQL' } | Sort-Object Name -Descending | Select-Object -First 1
}
if (-not (Test-Command 'psql')) {
    $pgBins = @(Get-ChildItem -Path (Join-Path $env:ProgramFiles 'PostgreSQL\*\bin') -Filter psql.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty DirectoryName)
    if ($pgBins.Count) { $env:Path = "$($pgBins[0]);$env:Path" }
}
if (-not (Test-Command 'psql') -and -not $service) { Fail 'PostgreSQL tools/service are not available. Install PostgreSQL 18 from https://www.postgresql.org/download/windows/ and rerun.' }

$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCmd) { Fail 'npm.cmd was not found; repair the Node.js LTS installation.' }
if (Test-Command 'psql') { $postgresVersion = (& psql --version) -join ' ' } else { $postgresVersion = "client tools not on PATH; detected service $($service.Name)" }
Write-Step "Git: $((& git --version) -join ' '); Node.js: $((& node --version) -join ' '); npm: $((& $npmCmd --version) -join ' '); uv: $((& uv --version) -join ' '); Python: $((& uv run --project $backend --python 3.14 python --version) -join ' '); PostgreSQL: $postgresVersion"

if ($service -and $service.Status -ne 'Running') {
    Write-Step "Starting installed PostgreSQL service '$($service.Name)'."
    try { Start-Service -Name $service.Name; (Get-Service $service.Name).WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) }
    catch { Fail "Could not start PostgreSQL service '$($service.Name)'. Start it from Services or with: Start-Service $($service.Name)" }
} elseif (-not $service) {
    Write-Warning 'No PostgreSQL Windows service was detected. Setup will attempt a configured database connection; initialize/start the local PostgreSQL service if it fails.'
}

$backendEnv = Join-Path $backend '.env'
if (-not (Test-Path -LiteralPath $backendEnv)) {
    Copy-Item -LiteralPath (Join-Path $backend '.env.example') -Destination $backendEnv
    Write-Step 'Created backend\.env from placeholders. Edit DATABASE_URL and any provider values you need.'
} else { Write-Step 'Preserved existing backend\.env.' }
$frontendEnv = Join-Path $frontend '.env'
if (-not (Test-Path -LiteralPath $frontendEnv)) {
    Copy-Item -LiteralPath (Join-Path $frontend '.env.example') -Destination $frontendEnv
    Write-Step 'Created frontend\.env from .env.example.'
} else { Write-Step 'Preserved existing frontend\.env.' }

Write-Step 'Synchronizing backend from uv.lock.'
Push-Location $backend
try {
    & uv sync --locked --python 3.14
    if ($LASTEXITCODE -ne 0) { Fail 'uv sync failed; check Python 3.14 and backend/uv.lock.' }
    & uv run --locked python -c 'from backend.main import app; print("FastAPI import: OK (" + app.title + ")")'
    if ($LASTEXITCODE -ne 0) { Fail 'Backend app import failed.' }
} finally { Pop-Location }

Write-Step 'Installing frontend dependencies with npm ci from package-lock.json.'
Push-Location $frontend
try {
    $npmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source
    & $npmCmd ci
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed; package-lock.json must match package.json.' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { Fail 'Frontend TypeScript/build validation failed.' }
} finally { Pop-Location }

Write-Step 'Checking/creating only the named development DB, then applying Alembic migrations.'
Push-Location $backend
try {
    & uv run --locked python (Join-Path $PSScriptRoot 'dev_env.py') ensure-dev-db
    if ($LASTEXITCODE -ne 0) { Fail 'Database setup failed. See the safe manual PostgreSQL steps in README.md.' }
    & uv run --locked alembic upgrade head
    if ($LASTEXITCODE -ne 0) { Fail 'Alembic migration failed; no database was dropped or reset.' }
} finally { Pop-Location }

Write-Host "`nSetup complete. Run: powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1" -ForegroundColor Green
Write-Host 'Frontend: http://127.0.0.1:5173'; Write-Host 'Backend:  http://127.0.0.1:49173'; Write-Host 'API docs: http://127.0.0.1:49173/docs'
