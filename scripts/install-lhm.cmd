@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "LHM_DIR=C:\Program Files\LibreHardwareMonitor"

echo Checking administrator privileges...
net session >nul 2>&1
if errorlevel 1 (
    echo Please run this script as Administrator: right-click and select "Run as administrator".
    pause
    exit /b 1
)

where winget >nul 2>&1
if errorlevel 1 (
    echo winget not found. Please download the LibreHardwareMonitor portable release manually:
    echo https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest
    echo and extract it to %LHM_DIR%
) else (
    echo Installing LibreHardwareMonitor via winget...
    winget install --id LibreHardwareMonitor.LibreHardwareMonitor --accept-package-agreements --accept-source-agreements
    if errorlevel 1 echo winget install failed. Please check the network or install manually.
)

if not exist "%LHM_DIR%\LibreHardwareMonitor.exe" (
    echo %LHM_DIR%\LibreHardwareMonitor.exe not found. Please confirm the install location and run this script again.
    pause
    exit /b 1
)

echo Creating startup scheduled task (run with highest privileges at logon)...
schtasks /Create /TN "LibreHardwareMonitor" /TR "\"%LHM_DIR%\LibreHardwareMonitor.exe\" --start-minimized" /SC ONLOGON /RL HIGHEST /F

echo.
echo Done. First-time setup:
echo 1. Run %LHM_DIR%\LibreHardwareMonitor.exe as administrator once.
echo 2. In "Options - Remote web server", enable "Run".
echo 3. Verify http://127.0.0.1:8085/data.json returns JSON:
echo    curl.exe http://127.0.0.1:8085/data.json
echo 4. Send /temperature to the bot in Feishu.
pause
exit /b 0
