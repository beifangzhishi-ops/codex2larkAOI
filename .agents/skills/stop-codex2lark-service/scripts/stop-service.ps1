param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$stopScript = Join-Path $resolvedRoot 'stop.ps1'

if (-not (Test-Path -LiteralPath $stopScript -PathType Leaf)) {
    throw "目标目录不是 codex2lark 项目，缺少 stop.ps1：$resolvedRoot"
}

& $stopScript

$pidFile = Join-Path $resolvedRoot '.state\bridge.pid'
if (Test-Path -LiteralPath $pidFile) {
    $pidValue = [int](Get-Content -LiteralPath $pidFile)
    if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
        throw "桥接进程仍在运行，PID=$pidValue"
    }
}

Write-Host "已确认项目服务停止：$resolvedRoot"
