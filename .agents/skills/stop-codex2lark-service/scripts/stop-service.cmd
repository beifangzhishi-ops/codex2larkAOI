@echo off
setlocal EnableExtensions
if "%~1"=="" exit /b 1

set "PROJECT_ROOT=%~f1"
if not exist "%PROJECT_ROOT%\stop.cmd" exit /b 1

call "%PROJECT_ROOT%\stop.cmd" --no-pause-on-error
set "STOP_EXIT_CODE=%ERRORLEVEL%"
if not "%STOP_EXIT_CODE%"=="0" exit /b %STOP_EXIT_CODE%

if exist "%PROJECT_ROOT%\.state\bridge.pid" exit /b 1
exit /b 0
