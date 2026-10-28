@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-project.ps1" -Tunnel
if errorlevel 1 (
    echo.
    echo Public development startup failed. Read the diagnostics above.
    pause
    exit /b 1
)
