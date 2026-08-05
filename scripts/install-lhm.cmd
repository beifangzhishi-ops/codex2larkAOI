@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "LHM_DIR=C:\Program Files\LibreHardwareMonitor"

echo 正在检查管理员权限...
net session >nul 2>&1
if errorlevel 1 (
    echo 需要以管理员身份运行本脚本：请在资源管理器中右键选择“以管理员身份运行”。
    pause
    exit /b 1
)

where winget >nul 2>&1
if errorlevel 1 (
    echo 未找到 winget，请手动下载 LibreHardwareMonitor 便携版并解压到 %LHM_DIR%：
    echo https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest
) else (
    echo 正在通过 winget 安装 LibreHardwareMonitor...
    winget install --id LibreHardwareMonitor.LibreHardwareMonitor --accept-package-agreements --accept-source-agreements
    if errorlevel 1 echo winget 安装未成功，请检查网络或手动安装。
)

if not exist "%LHM_DIR%\LibreHardwareMonitor.exe" (
    echo 未找到 %LHM_DIR%\LibreHardwareMonitor.exe，请确认安装位置后重新运行本脚本。
    pause
    exit /b 1
)

echo 正在创建开机自启计划任务（登录时以最高权限运行）...
schtasks /Create /TN "LibreHardwareMonitor" /TR "\"%LHM_DIR%\LibreHardwareMonitor.exe\" --start-minimized" /SC ONLOGON /RL HIGHEST /F

echo.
echo 安装完成。首次使用请完成以下步骤：
echo 1. 手动运行 %LHM_DIR%\LibreHardwareMonitor.exe（以管理员身份）；
echo 2. 在“选项 - 远程网络服务器（Remote web server）”中勾选“运行”；
echo 3. 用 curl.exe 访问 http://127.0.0.1:8085/data.json，确认返回 JSON。
echo 之后即可在飞书向机器人发送 /temperature 查询本机温度。
pause
exit /b 0
