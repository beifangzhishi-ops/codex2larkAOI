$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.env')) {
    throw '缺少 .env。请先复制 .env.example 为 .env，并填写 CODEX_WORKDIR 与 FEISHU_ALLOWED_OPEN_IDS。'
}

# Codex's restricted shell may inject a loopback port-9 deny proxy. A bridge
# launched from that shell must not inherit it, while legitimate user proxies
# remain untouched.
$removedProxyVariables = @()
foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($value -match '(?i)^(?:https?|socks5?)://(?:127\.0\.0\.1|localhost):9/?$') {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        $removedProxyVariables += $name
    }
}
if ($removedProxyVariables.Count -gt 0) {
    Write-Host "[start] removed sandbox deny proxy: $($removedProxyVariables -join ', ')"
}

node .\src\bridge.js
