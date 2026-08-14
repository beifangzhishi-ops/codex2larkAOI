@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "NO_PAUSE_ON_ERROR="
if /I "%~1"=="--no-pause-on-error" set "NO_PAUSE_ON_ERROR=1"
if /I "%~1"=="-NoPauseOnError" set "NO_PAUSE_ON_ERROR=1"

if defined NO_PAUSE_ON_ERROR (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\shared-app-server.ps1" -Action stop -NoGui
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\shared-app-server.ps1" -Action stop
)
set "SERVICE_EXIT_CODE=%ERRORLEVEL%"
if not "%SERVICE_EXIT_CODE%"=="0" if not defined NO_PAUSE_ON_ERROR (
  echo.
  echo 停止失败或存在需要人工处理的情况，按任意键关闭窗口。
  pause >nul
)
exit /b %SERVICE_EXIT_CODE%
