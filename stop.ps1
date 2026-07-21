$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.state\bridge.pid')) {
    Write-Host '桥接服务未运行。'
    exit 0
}

$pidValue = [int](Get-Content '.state\bridge.pid')
if (-not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
    Remove-Item '.state\bridge.pid' -Force
    Write-Host "桥接服务未运行，已清理过期 PID=$pidValue。"
    exit 0
}

Set-Content -Path '.state\stop-requested' -Value (Get-Date -Format o)

for ($i = 0; $i -lt 40; $i++) {
    if (-not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
        Remove-Item '.state\bridge.pid' -Force -ErrorAction SilentlyContinue
        Write-Host "桥接服务及本项目事件消费者已停止，PID=$pidValue。"
        exit 0
    }
    Start-Sleep -Milliseconds 250
}

throw "桥接服务未在 10 秒内退出，PID=$pidValue。未停止共享的 lark-cli 事件总线。"
