@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "NO_PAUSE_ON_ERROR="
if /I "%~1"=="--no-pause-on-error" set "NO_PAUSE_ON_ERROR=1"
if /I "%~1"=="-NoPauseOnError" set "NO_PAUSE_ON_ERROR=1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $port=45789; $root=(Get-Location).Path; $stateDir=Join-Path $root '.state'; $pidFile=Join-Path $stateDir 'shared-app-server.pid'; function Show-Error([string]$message){ Write-Host ('[错误] '+$message) -ForegroundColor Red; try{ Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue; [System.Windows.Forms.MessageBox]::Show($message,'共享 Codex app-server','OK','Error') | Out-Null }catch{} }; $stopped=$false; if(Test-Path -LiteralPath $pidFile){ $pidText=((Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue) -replace '\s',''); if($pidText -match '^\d+$'){ $proc=Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue; if($proc -and $proc.ProcessName -eq 'codex'){ $cmdLine=''; try{ $cmdLine=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidText)).CommandLine }catch{}; if($cmdLine -match 'app-server' -and $cmdLine -match (':'+$port)){ Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Write-Host ('已停止共享 app-server（PID '+$pidText+'）'); $stopped=$true } else { Write-Host ('PID 文件中的进程不是共享 app-server，跳过停止：'+$cmdLine) } } else { Write-Host ('PID 文件中的进程已不存在或不是 codex，忽略：'+$pidText) } } else { Write-Host 'PID 文件内容无效，忽略。' } } else { Write-Host '未找到共享 app-server PID 文件（可能未通过脚本启动）。' }; [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL',$null,'User'); Write-Host '已删除用户环境变量 CODEX_APP_SERVER_WS_URL。'; Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; $listener=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue; if($listener){ Write-Host ('[警告] 端口 '+$port+' 仍有监听进程，可能是非脚本启动的共享 server 或其他程序。') -ForegroundColor Yellow; Write-Host '排查命令：Get-NetTCPConnection -LocalPort 45789 | Select OwningProcess'; Show-Error ('端口 '+$port+' 仍有监听进程，请手动确认处理。'); exit 1 }; if(-not $stopped){ Write-Host '共享 app-server 未通过脚本停止（可能本来就不是脚本启动的）。'; exit 0 }; Write-Host '共享 app-server 已停止，桌面端下次启动将使用内置内核。'; exit 0"

set "SERVICE_EXIT_CODE=%ERRORLEVEL%"
if not "%SERVICE_EXIT_CODE%"=="0" if not defined NO_PAUSE_ON_ERROR (
  echo.
  echo 停止失败或存在需要人工处理的情况，按任意键关闭窗口。
  pause >nul
)
exit /b %SERVICE_EXIT_CODE%
