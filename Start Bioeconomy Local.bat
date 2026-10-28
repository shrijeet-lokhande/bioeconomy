@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-project.ps1"
if errorlevel 1 (
    echo.
    echo Local startup failed. Read the error above, then press any key to close.
    pause >nul
    exit /b 1
)
echo.
echo Local startup commands completed. Keep the server terminal open while using the app.
pause >nul
