[CmdletBinding()]
param(
    [switch]$NoPauseOnError
)

$ErrorActionPreference = 'Stop'

try {
    Set-Location $PSScriptRoot

    if (-not (Test-Path '.env')) {
        throw '缺少 .env。请先复制 .env.example 为 .env，并填写 CODEX_WORKDIR 与 FEISHU_ALLOWED_OPEN_IDS。'
    }

    # 仅移除 Codex 受限 shell 注入的拒绝代理，保留用户配置的正常代理。
    $removedProxyVariables = @()
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($value -match '(?i)^(?:https?|socks5?)://(?:127\.0\.0\.1|localhost):9/?$') {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
            $removedProxyVariables += $name
        }
    }
    if ($removedProxyVariables.Count -gt 0) {
        Write-Host "[start] 已移除受限环境代理：$($removedProxyVariables -join ', ')"
    }

    & node .\src\bridge.js
    $nodeExitCode = $LASTEXITCODE
    if ($nodeExitCode -ne 0) {
        throw "桥接进程异常退出，退出码：$nodeExitCode。"
    }
} catch {
    Write-Host ''
    Write-Host "[start] 启动失败：$($_.Exception.Message)" -ForegroundColor Red
    if (-not $NoPauseOnError) {
        try {
            Read-Host '按 Enter 键关闭窗口' | Out-Null
        } catch {
            # 无可用输入流时直接退出，避免掩盖原始启动错误。
        }
    }
    exit 1
}
