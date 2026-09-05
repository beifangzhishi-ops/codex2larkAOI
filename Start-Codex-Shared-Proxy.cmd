@echo off
chcp 65001 >nul
setlocal
set "shouldPause=1"
if /I "%~1"=="--no-pause" set "shouldPause=0"

set "shellPath="
set "shellKind="
where pwsh.exe >nul 2>&1
if not errorlevel 1 (
    set "shellPath=pwsh.exe"
    set "shellKind=PowerShell 7"
)
if not defined shellPath if exist "%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe" (
    set "shellPath=%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe"
    set "shellKind=PowerShell 7"
)
if not defined shellPath if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" (
    set "shellPath=%ProgramFiles%\PowerShell\7\pwsh.exe"
    set "shellKind=PowerShell 7"
)
if not defined shellPath if exist "%ProgramFiles%\PowerShell\7-preview\pwsh.exe" (
    set "shellPath=%ProgramFiles%\PowerShell\7-preview\pwsh.exe"
    set "shellKind=PowerShell 7"
)
if not defined shellPath if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
    set "shellPath=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
    set "shellKind=Windows PowerShell 5.1"
)
if not defined shellPath (
    echo [错误] 未找到 PowerShell 7 ^(pwsh.exe^)。
    echo 也未找到系统自带的 Windows PowerShell。
    if "%shouldPause%"=="1" pause
    exit /b 1
)

echo 使用 %shellKind%：%shellPath%
if /I "%shellKind%"=="Windows PowerShell 5.1" echo [提示] 未找到 PowerShell 7，已回退到系统 PowerShell 5.1。

"%shellPath%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Codex-Shared-Proxy.ps1"
set "scriptExitCode=%ERRORLEVEL%"

echo.
if not "%scriptExitCode%"=="0" echo 脚本未完成，退出代码：%scriptExitCode%
if "%shouldPause%"=="1" pause
exit /b %scriptExitCode%
