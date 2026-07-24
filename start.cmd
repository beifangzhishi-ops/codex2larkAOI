@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "NO_PAUSE_ON_ERROR="
if /I "%~1"=="--no-pause-on-error" set "NO_PAUSE_ON_ERROR=1"
if /I "%~1"=="-NoPauseOnError" set "NO_PAUSE_ON_ERROR=1"

node ".\src\service-control.js" start
set "SERVICE_EXIT_CODE=%ERRORLEVEL%"
if not "%SERVICE_EXIT_CODE%"=="0" if not defined NO_PAUSE_ON_ERROR pause
exit /b %SERVICE_EXIT_CODE%
