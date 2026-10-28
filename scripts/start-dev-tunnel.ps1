$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $repoRoot "frontend"
$backendDir = Join-Path $repoRoot "backend"
$cloudflared = $null
$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cloudflaredCommand) {
    $cloudflared = $cloudflaredCommand.Source
}
if (-not $cloudflared) {
    $cloudflaredCandidate = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe"
    if (Test-Path -LiteralPath $cloudflaredCandidate) { $cloudflared = $cloudflaredCandidate }
}
if (-not $cloudflared) {
    throw "cloudflared was not found. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/, then open a new terminal."
}

$packageManager = Get-Command npm -ErrorAction SilentlyContinue
if ($packageManager) {
    $packageManagerPath = $packageManager.Source
    $packageManagerArgs = @("run", "dev")
} else {
    $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpmCommand) {
        $pnpmCandidates = @(
            (Join-Path $env:LOCALAPPDATA "Programs\pnpm\pnpm.exe"),
            (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd")
        )
        foreach ($candidate in $pnpmCandidates) {
            if (Test-Path -LiteralPath $candidate) {
                $pnpmCommand = [PSCustomObject]@{ Source = $candidate }
                break
            }
        }
    }
    if (-not $pnpmCommand) { throw "Neither npm nor pnpm is available. Install Node.js with npm or pnpm before starting Bioeconomy." }
    $packageManagerPath = $pnpmCommand.Source
    $packageManagerArgs = @("run", "dev")
}

$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uvCommand) {
    $uvCandidate = Join-Path $env:APPDATA "Python\Python312\Scripts\uv.exe"
    if (Test-Path -LiteralPath $uvCandidate) { $env:Path = "$(Split-Path -Parent $uvCandidate);$env:Path" }
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    $nodeCandidate = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
    if (Test-Path -LiteralPath (Join-Path $nodeCandidate "node.exe")) { $env:Path = "$nodeCandidate;$env:Path" }
}

foreach ($port in @(5173, 49173)) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
        throw "Port $port is already in use by PID(s) $owners. Stop the existing project server or resolve that port conflict; this script will not kill unrelated processes."
    }
}

$logRoot = Join-Path $env:TEMP "bioeconomy-cloudflare"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$stdoutPath = Join-Path $logRoot "cloudflared.stdout.log"
$stderrPath = Join-Path $logRoot "cloudflared.stderr.log"
Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
$tunnelProcess = $null
$serverProcess = $null
$savedEnvironment = @{}
foreach ($name in @("APP_BASE_URL", "CORS_ORIGINS", "COOKIE_SECURE", "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS")) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
    # Quick Tunnels need no account or credentials. Start the connector first
    # so its generated HTTPS origin can be trusted by the app before startup.
    $tunnelArgs = @("tunnel", "--url", "http://127.0.0.1:5173", "--no-autoupdate")
    if (-not [string]::IsNullOrWhiteSpace($env:BIOECONOMY_TUNNEL_ALLOWED_MAIL)) {
        $tunnelArgs += @("--allowed-mail", $env:BIOECONOMY_TUNNEL_ALLOWED_MAIL)
        Write-Host "Cloudflare email access restriction: enabled."
    } else {
        Write-Warning "This Quick Tunnel is reachable by anyone with its URL. Protected application actions still require login; set BIOECONOMY_TUNNEL_ALLOWED_MAIL to restrict access at Cloudflare."
    }
    $tunnelProcess = Start-Process -FilePath $cloudflared `
        -ArgumentList $tunnelArgs `
        -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

    $publicUrl = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($tunnelProcess.HasExited) { break }
        foreach ($logPath in @($stdoutPath, $stderrPath)) {
            if (Test-Path -LiteralPath $logPath) {
                $logText = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
                if ($logText -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
                    $publicUrl = $Matches[0]
                    break
                }
            }
        }
        if ($publicUrl) { break }
        Start-Sleep -Milliseconds 500
        $tunnelProcess.Refresh()
    }

    if (-not $publicUrl) {
        $diagnostics = @()
        foreach ($logPath in @($stdoutPath, $stderrPath)) {
            if (Test-Path -LiteralPath $logPath) { $diagnostics += Get-Content -LiteralPath $logPath -Tail 12 }
        }
        if ($diagnostics.Count -gt 0) { $diagnostics | ForEach-Object { Write-Host $_ } }
        throw "cloudflared did not produce a Quick Tunnel URL within 45 seconds. Check the Cloudflare connection and the diagnostics above."
    }

    $origin = ([Uri]$publicUrl).GetLeftPart([System.UriPartial]::Authority)
    $hostname = ([Uri]$publicUrl).Host
    $env:APP_BASE_URL = $origin
    $env:CORS_ORIGINS = ConvertTo-Json -Compress @("http://localhost:5173", "http://127.0.0.1:5173", $origin)
    $env:COOKIE_SECURE = "1"
    $env:__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = $hostname

    Write-Host "Quick Tunnel URL: $publicUrl"
    Write-Host "Starting the existing backend + Vite development command..."
    Write-Host "Email verification and password-reset links will use the public URL above."
    Write-Host "Anyone who obtains this temporary URL can reach the development site; application sign-in is still required for protected features."

    $serverProcess = Start-Process -FilePath $packageManagerPath `
        -ArgumentList $packageManagerArgs -WorkingDirectory $frontendDir `
        -NoNewWindow -PassThru

    Write-Host "Waiting for Vite, FastAPI, and the public route to become ready..."
    $ready = $false
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $readyDeadline) {
        $serverProcess.Refresh()
        $tunnelProcess.Refresh()
        if ($serverProcess.HasExited) { throw "Frontend/backend development command exited early with code $($serverProcess.ExitCode)." }
        if ($tunnelProcess.HasExited) { throw "cloudflared exited before the public route became ready. See $stderrPath for diagnostics." }
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:49173/api/v1/health" -TimeoutSec 3
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:5173/" -UseBasicParsing -TimeoutSec 3
            $null = Invoke-RestMethod -Uri "$origin/api/v1/health" -TimeoutSec 5
            $ready = $true
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $ready) { throw "The local services and public health route did not all become ready within 60 seconds." }
    Write-Host "Local frontend, backend health, and public API proxy are responding. Press Ctrl+C to stop all managed processes."

    while (-not $serverProcess.WaitForExit(1000)) {
        $tunnelProcess.Refresh()
        if ($tunnelProcess.HasExited) {
            throw "cloudflared exited unexpectedly with code $($tunnelProcess.ExitCode). See $stderrPath for diagnostics."
        }
    }
    if ($serverProcess.ExitCode -ne 0) { throw "Frontend/backend development command exited with code $($serverProcess.ExitCode)." }
}
finally {
    if ($serverProcess -and -not $serverProcess.HasExited) {
        & taskkill.exe /PID $serverProcess.Id /T /F 2>$null | Out-Null
    }
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
        Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    }
    foreach ($name in $savedEnvironment.Keys) {
        if ($null -eq $savedEnvironment[$name]) {
            Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
        }
    }
}
