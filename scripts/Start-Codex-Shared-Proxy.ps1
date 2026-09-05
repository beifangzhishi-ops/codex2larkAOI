[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [ValidateRange(1, 120)]
    [int]$WaitSeconds = 12,
    [string]$FallbackProxy = '127.0.0.1:7890',
    [string]$PackageName = 'OpenAI.Codex',
    [string]$SharedAppUrl = 'ws://127.0.0.1:45789'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$sharedStackScript = Join-Path $PSScriptRoot 'shared-stack.ps1'

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host ('=== ' + $Title + ' ===') -ForegroundColor Cyan
}

function ConvertTo-ProxyUri {
    param(
        [AllowNull()][string]$Value,
        [string]$DefaultScheme = 'http'
    )

    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $cleanValue = $Value.Trim()
    if ($cleanValue -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') { return $cleanValue }
    return ($DefaultScheme + '://' + $cleanValue)
}

function Hide-ProxyCredential {
    param([string]$ProxyUri)
    try {
        $uri = [Uri]$ProxyUri
        if ([string]::IsNullOrWhiteSpace($uri.UserInfo)) { return $ProxyUri }
        return ('{0}://***@{1}:{2}' -f $uri.Scheme, $uri.Host, $uri.Port)
    }
    catch { return $ProxyUri }
}

function Get-OptionalPropertyValue {
    param([object]$InputObject, [string]$Name)
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-WindowsSystemProxy {
    $registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    $settings = Get-ItemProperty -LiteralPath $registryPath
    $proxyEnabled = ([int](Get-OptionalPropertyValue -InputObject $settings -Name 'ProxyEnable') -eq 1)
    $proxyServer = [string](Get-OptionalPropertyValue -InputObject $settings -Name 'ProxyServer')
    $autoConfigUrl = [string](Get-OptionalPropertyValue -InputObject $settings -Name 'AutoConfigURL')

    if (-not $proxyEnabled -or [string]::IsNullOrWhiteSpace($proxyServer)) {
        $source = if ([string]::IsNullOrWhiteSpace($autoConfigUrl)) {
            '未检测到已启用的显式系统代理'
        }
        else {
            '仅检测到 PAC，无法可靠转换为固定代理：' + $autoConfigUrl
        }
        return @{ Found = $false; Source = $source; Http = $null; Https = $null; All = $null }
    }

    $proxyServer = $proxyServer.Trim()
    if ($proxyServer -notmatch '=') {
        $singleProxy = ConvertTo-ProxyUri -Value $proxyServer
        return @{ Found = $true; Source = 'Windows 当前用户系统代理'; Http = $singleProxy; Https = $singleProxy; All = $singleProxy }
    }

    $proxyMap = @{}
    foreach ($entry in ($proxyServer -split ';')) {
        if ($entry -match '^\s*([^=]+)=(.+?)\s*$') {
            $proxyMap[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim()
        }
    }

    $httpValue = $proxyMap['http']
    $httpsValue = $proxyMap['https']
    $socksValue = $proxyMap['socks']
    if ([string]::IsNullOrWhiteSpace($httpValue)) { $httpValue = $httpsValue }
    if ([string]::IsNullOrWhiteSpace($httpsValue)) { $httpsValue = $httpValue }

    if ([string]::IsNullOrWhiteSpace($httpValue) -and [string]::IsNullOrWhiteSpace($socksValue)) {
        return @{ Found = $false; Source = '系统代理格式无法转换：' + $proxyServer; Http = $null; Https = $null; All = $null }
    }

    $httpProxy = ConvertTo-ProxyUri -Value $httpValue
    $httpsProxy = ConvertTo-ProxyUri -Value $httpsValue
    $allProxy = if ([string]::IsNullOrWhiteSpace($socksValue)) {
        $httpsProxy
    }
    else {
        ConvertTo-ProxyUri -Value $socksValue -DefaultScheme 'socks5'
    }

    return @{ Found = $true; Source = 'Windows 当前用户分协议系统代理'; Http = $httpProxy; Https = $httpsProxy; All = $allProxy }
}

function Get-CodexPackageInfo {
    param([string]$Name)

    $package = Get-AppxPackage -Name $Name | Sort-Object Version -Descending | Select-Object -First 1
    if ($null -eq $package) { throw ('未找到 Microsoft Store 包：' + $Name) }

    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    $applications = @($manifest.Package.Applications.Application)
    if ($applications.Count -eq 0) { throw 'AppxManifest.xml 中没有 Application 入口。' }

    $application = $applications |
        Where-Object {
            ([string]$_.Executable -match '(?i)(chatgpt|codex)') -or
            ([string]$_.Id -match '(?i)(chatgpt|codex|app)')
        } |
        Select-Object -First 1
    if ($null -eq $application) { $application = $applications | Select-Object -First 1 }

    $relativeExecutable = [string]$application.Executable
    if ([string]::IsNullOrWhiteSpace($relativeExecutable)) { throw 'AppxManifest 的 Application 入口没有 Executable 属性。' }

    $executablePath = Join-Path $package.InstallLocation $relativeExecutable
    if (-not (Test-Path -LiteralPath $executablePath)) { throw ('AppxManifest 指定的可执行文件不存在：' + $executablePath) }

    return @{ Package = $package; Application = $application; ExecutablePath = $executablePath }
}

function ConvertTo-ReadyUrl {
    param([string]$WsUrl)

    $uri = [Uri]$WsUrl
    if ($uri.Scheme -ne 'ws' -and $uri.Scheme -ne 'wss') {
        throw ('共享 app-server URL 必须是 ws:// 或 wss://：' + $WsUrl)
    }
    $scheme = if ($uri.Scheme -eq 'wss') { 'https' } else { 'http' }
    $builder = New-Object -TypeName System.UriBuilder -ArgumentList @($scheme, $uri.Host, $uri.Port, '/readyz')
    return $builder.Uri.AbsoluteUri
}

function Test-HttpReady {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2 -ErrorAction Stop
        return ($response.StatusCode -eq 200)
    }
    catch { return $false }
}

function Wait-HttpReady {
    param([string]$Url, [int]$Seconds = 30)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpReady -Url $Url) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Start-SharedStack {
    param([string]$ReadyUrl)

    if (Test-HttpReady -Url $ReadyUrl) {
        Write-Host 'AOI shared app-server 已运行。' -ForegroundColor Green
        return
    }

    if (-not (Test-Path -LiteralPath $sharedStackScript)) {
        throw ('缺少 shared stack 脚本：' + $sharedStackScript)
    }

    $currentShell = (Get-Process -Id $PID -ErrorAction Stop).Path
    Write-Host 'AOI shared app-server 未运行，正在启动 45789/45790...'
    & $currentShell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $sharedStackScript -Action start -NoGui
    if ($LASTEXITCODE -ne 0) {
        throw ('shared-stack.ps1 启动失败，退出代码：' + $LASTEXITCODE)
    }

    if (-not (Wait-HttpReady -Url $ReadyUrl -Seconds 35)) {
        throw ('shared app-server 未就绪：' + $ReadyUrl)
    }

    Write-Host 'AOI shared app-server 已就绪。' -ForegroundColor Green
}

try {
    $sharedReadyUrl = ConvertTo-ReadyUrl -WsUrl $SharedAppUrl

    Write-Section '检测 Windows 系统代理'
    $proxy = Get-WindowsSystemProxy
    if (-not $proxy.Found) {
        $fallbackUri = ConvertTo-ProxyUri -Value $FallbackProxy
        Write-Warning ($proxy.Source + '；回退到 ' + $fallbackUri)
        $proxy = @{ Found = $true; Source = '回退代理'; Http = $fallbackUri; Https = $fallbackUri; All = $fallbackUri }
    }

    Write-Host ('来源：' + $proxy.Source)
    Write-Host ('HTTP ：' + (Hide-ProxyCredential $proxy.Http))
    Write-Host ('HTTPS：' + (Hide-ProxyCredential $proxy.Https))
    Write-Host ('ALL  ：' + (Hide-ProxyCredential $proxy.All))

    $expectedProxyText = [string]$proxy.Https
    if ([string]::IsNullOrWhiteSpace($expectedProxyText)) { $expectedProxyText = [string]$proxy.Http }
    if ([string]::IsNullOrWhiteSpace($expectedProxyText)) { $expectedProxyText = [string]$proxy.All }
    $expectedProxy = [Uri]$expectedProxyText
    if ($expectedProxy.Port -le 0) { throw ('代理地址没有有效端口：' + $expectedProxyText) }

    Write-Section '读取 Microsoft Store Codex 入口'
    $packageInfo = Get-CodexPackageInfo -Name $PackageName
    Write-Host ('版本      ：' + [string]$packageInfo.Package.Version)
    Write-Host ('Executable：' + [string]$packageInfo.Application.Executable)
    Write-Host ('EntryPoint ：' + [string]$packageInfo.Application.EntryPoint)
    Write-Host ('实际路径   ：' + $packageInfo.ExecutablePath)

    if ($CheckOnly) {
        Write-Section '共享 App Server 状态'
        if (Test-HttpReady -Url $sharedReadyUrl) {
            Write-Host ('已就绪：' + $SharedAppUrl) -ForegroundColor Green
        }
        else {
            Write-Warning ('未就绪：' + $SharedAppUrl)
        }
        Write-Host ('CODEX_APP_SERVER_WS_URL(User)=' + [string][Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User'))
        exit 0
    }

    $runningChatGpt = @(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue)
    if ($runningChatGpt.Count -gt 0) {
        Write-Section '检测到旧 Codex 实例'
        Write-Warning '请先从 Codex 菜单完全退出应用，并在任务管理器确认没有 ChatGPT.exe，然后重新双击共享版启动器。'
        Write-Warning '脚本不会自动结束现有进程，以免中断未保存的任务。'
        exit 20
    }

    Write-Section '检查 Clash 代理端口'
    $proxyReachable = Test-NetConnection -ComputerName $expectedProxy.Host -Port $expectedProxy.Port -InformationLevel Quiet -WarningAction SilentlyContinue
    if (-not $proxyReachable) {
        throw ('无法连接代理端口 ' + $expectedProxy.Host + ':' + $expectedProxy.Port + '。请确认 Clash 已启动且对应端口正在监听。')
    }
    Write-Host '代理端口可连接。' -ForegroundColor Green

    Write-Section '确保 AOI shared app-server'
    Start-SharedStack -ReadyUrl $sharedReadyUrl

    Write-Section '设置本次启动环境'
    $env:HTTP_PROXY = $proxy.Http
    $env:HTTPS_PROXY = $proxy.Https
    $env:ALL_PROXY = $proxy.All
    $env:NO_PROXY = 'localhost,127.0.0.1,::1'
    $env:CODEX_APP_SERVER_WS_URL = $SharedAppUrl

    Write-Host ('HTTP_PROXY =' + (Hide-ProxyCredential $env:HTTP_PROXY))
    Write-Host ('HTTPS_PROXY=' + (Hide-ProxyCredential $env:HTTPS_PROXY))
    Write-Host ('ALL_PROXY  =' + (Hide-ProxyCredential $env:ALL_PROXY))
    Write-Host ('NO_PROXY   =' + $env:NO_PROXY)
    Write-Host ('CODEX_APP_SERVER_WS_URL=' + $env:CODEX_APP_SERVER_WS_URL)

    Write-Section '启动 Codex（共享 App Server）'
    $launchProcess = Start-Process -FilePath $packageInfo.ExecutablePath -PassThru
    Write-Host ('已提交启动，初始 PID：' + $launchProcess.Id) -ForegroundColor Green
    Write-Host ('等待 ' + $WaitSeconds + ' 秒，让 Desktop、45789/45790 和网络连接完成初始化……')
    Start-Sleep -Seconds $WaitSeconds

    if (-not (Test-HttpReady -Url $sharedReadyUrl)) {
        throw 'Desktop 启动后 shared app-server 健康检查失败。'
    }

    Write-Host ''
    Write-Host ('完成：Codex Desktop -> ' + $SharedAppUrl + '；外网 -> ' + $expectedProxy.Host + ':' + $expectedProxy.Port) -ForegroundColor Green
}
catch {
    Write-Host ''
    Write-Host ('失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
