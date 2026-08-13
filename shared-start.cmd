@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "NO_PAUSE_ON_ERROR="
if /I "%~1"=="--no-pause-on-error" set "NO_PAUSE_ON_ERROR=1"
if /I "%~1"=="-NoPauseOnError" set "NO_PAUSE_ON_ERROR=1"

if defined NO_PAUSE_ON_ERROR (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\shared-app-server.ps1" -Action start -NoGui
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\shared-app-server.ps1" -Action start
)
set "SERVICE_EXIT_CODE=%ERRORLEVEL%"
if not "%SERVICE_EXIT_CODE%"=="0" if not defined NO_PAUSE_ON_ERROR (
  echo.
  echo 启动失败，按任意键关闭窗口。
  pause >nul
)
exit /b %SERVICE_EXIT_CODE%
