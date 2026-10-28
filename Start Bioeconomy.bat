@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-project.ps1" -Tunnel
if errorlevel 1 (
    echo.
    echo Public startup failed. Read the error above, then press any key to close.
    pause >nul
    exit /b 1
)
echo.
echo Public startup commands completed. Keep the server terminal open while using the app.
pause >nul
