@echo off
where pwsh.exe >nul 2>nul
if errorlevel 1 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-telelock.ps1"
) else (
    pwsh.exe -NoProfile -File "%~dp0switch-telelock.ps1"
)
pause
