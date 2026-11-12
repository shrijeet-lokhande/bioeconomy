param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$apiUrl = 'http://127.0.0.1:49173'
$webUrl = 'http://127.0.0.1:5173'
$started = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Fail([string]$Message) { throw $Message }
function Test-Http([string]$Url) {
    try { $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2; return $true }
    catch { return $false }
}
function Show-PortOwner([int]$Port) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    if (-not $listeners.Count) { return $false }
    $details = foreach ($id in $listeners) {
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($proc) { "$($proc.ProcessName) (PID $id)" } else { "PID $id" }
    }
    Write-Host "Port $Port is occupied by $($details -join ', '). Stop it yourself; the launcher will not terminate unrelated processes." -ForegroundColor Yellow
    return $true
}
function Start-Child([string]$File, [string]$Arguments, [string]$WorkingDirectory, [string]$Label) {
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $File
    $info.Arguments = $Arguments
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) { Fail "Could not start $Label." }
    $script:started.Add($process)
    return [pscustomobject]@{
        Label = $Label
        Process = $process
        OutReader = $process.StandardOutput
        ErrReader = $process.StandardError
        OutTask = $process.StandardOutput.ReadLineAsync()
        ErrTask = $process.StandardError.ReadLineAsync()
    }
}
function Write-AvailableLines($Service) {
    foreach ($streamName in @('Out', 'Err')) {
        $taskProperty = "${streamName}Task"
        $readerProperty = "${streamName}Reader"
        $task = $Service.$taskProperty
        while ($task.IsCompleted -and $task.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
            $line = $task.Result
            if ($null -ne $line) {
                $color = if ($streamName -eq 'Err') { 'DarkYellow' } elseif ($Service.Label -eq 'API') { 'Cyan' } else { 'Green' }
                Write-Host "[$($Service.Label)] $line" -ForegroundColor $color
                $task = $Service.$readerProperty.ReadLineAsync()
                $Service.$taskProperty = $task
            } else { break }
        }
    }
}
function Stop-StartedTree($Process) {
    if (-not $Process -or $Process.HasExited) { return }
    # taskkill /T scopes termination to this process tree; no name-wide kill.
    & taskkill.exe /PID $Process.Id /T /F *> $null
}

try {
    foreach ($tool in @('uv', 'node', 'npm.cmd')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "$tool is missing. Run powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1." }
    }
    if (-not (Test-Path (Join-Path $frontend 'node_modules'))) { Fail 'Frontend dependencies are missing. Run scripts/setup.ps1.' }
    if (-not (Test-Path (Join-Path $backend '.venv'))) { Fail 'Backend environment is missing. Run scripts/setup.ps1.' }
    if (-not (Test-Path (Join-Path $backend '.env'))) { Fail 'backend\.env is missing. Run setup and configure DATABASE_URL.' }

    $apiReady = Test-Http "$apiUrl/api/v1/health"
    $webReady = Test-Http "$webUrl/"
    if ($apiReady -and $webReady) {
        Write-Host "Bioeconomy is already responding. Frontend: $webUrl  API: $apiUrl" -ForegroundColor Green
        return
    }
    foreach ($port in @(49173, 5173)) {
        if (Show-PortOwner $port) { Fail "Port $port is occupied. Free the port and rerun; unrelated processes are never killed." }
    }

    $uvCommand = Get-Command uv -ErrorAction Stop
    $npmCommand = Get-Command npm.cmd -ErrorAction Stop
    Write-Host '[Bioeconomy] Checking configured PostgreSQL and applying pending Alembic migrations.' -ForegroundColor Cyan
    Push-Location $backend
    try {
        & $uvCommand.Source run --locked --no-sync python (Join-Path $PSScriptRoot 'dev_env.py') check-db
        if ($LASTEXITCODE -ne 0) { Fail 'Database connection failed; check backend\.env and PostgreSQL service/authentication.' }
        & $uvCommand.Source run --locked --no-sync alembic upgrade head
        if ($LASTEXITCODE -ne 0) { Fail 'Alembic migration failed; no database was reset.' }
    } finally { Pop-Location }

    Write-Host "[Bioeconomy] Starting API ($apiUrl) and frontend ($webUrl). Press Ctrl+C to stop both." -ForegroundColor Cyan
    # npm run dev is the single shared cross-platform command: concurrently
    # starts the API and Vite and stops the sibling if either one exits.
    $app = Start-Child $env:ComSpec '/d /c npm run dev' $frontend 'APP'
    Write-Host '[Bioeconomy] Waiting for both services...' -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Write-AvailableLines $app
        if ($app.Process.HasExited) { Fail 'A service exited during startup.' }
        if ((Test-Http "$apiUrl/api/v1/health") -and (Test-Http "$webUrl/")) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { Fail 'Services did not both become ready within 40 seconds.' }
    Write-Host "`nFrontend: $webUrl`nBackend:  $apiUrl`nAPI docs: $apiUrl/docs`n`nPress Ctrl+C to stop both services." -ForegroundColor Green

    while ($true) {
        Write-AvailableLines $app
        if ($app.Process.HasExited) { Fail 'A service stopped unexpectedly.' }
        Start-Sleep -Milliseconds 150
    }
} finally {
    foreach ($process in $started) { Stop-StartedTree $process }
    foreach ($process in $started) { if (-not $process.HasExited) { $process.WaitForExit(5000) | Out-Null }; $process.Dispose() }
}
