param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("start", "stop")]
  [string]$Action,
  [switch]$NoGui,
  [string]$FallbackProxy = "127.0.0.1:7890"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".state"
$publicPort = 45789
$backendPort = 45790
$publicUrl = "ws://127.0.0.1:$publicPort"
$backendUrl = "ws://127.0.0.1:$backendPort"
$publicReady = "http://127.0.0.1:$publicPort/readyz"
$backendReady = "http://127.0.0.1:$backendPort/readyz"
$backendPidFile = Join-Path $stateDir "shared-app-server.pid"
$proxyPidFile = Join-Path $stateDir "shared-app-server-proxy.pid"
$backendOut = Join-Path $stateDir "shared-app-server.out.log"
$backendErr = Join-Path $stateDir "shared-app-server.err.log"
$proxyOut = Join-Path $stateDir "shared-app-server-proxy.out.log"
$proxyErr = Join-Path $stateDir "shared-app-server-proxy.err.log"
$proxyScript = Join-Path $PSScriptRoot "shared-app-server-proxy.js"

function Show-Error([string]$Message) {
  Write-Host ("[错误] " + $Message) -ForegroundColor Red
  if ($NoGui) { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show($Message, "共享 Codex app-server", "OK", "Error") | Out-Null
  } catch {}
}

function ConvertTo-ProxyUri([AllowNull()][string]$Value, [string]$DefaultScheme = "http") {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $clean = $Value.Trim()
  if ($clean -match "^[a-zA-Z][a-zA-Z0-9+.-]*://") { return $clean }
  return ($DefaultScheme + "://" + $clean)
}

function Resolve-SharedProxy {
  $http = ConvertTo-ProxyUri ([string]$env:HTTP_PROXY)
  $https = ConvertTo-ProxyUri ([string]$env:HTTPS_PROXY)
  $all = ConvertTo-ProxyUri ([string]$env:ALL_PROXY)
  $seed = if ($https) { $https } elseif ($http) { $http } else { $all }
  if ($seed) {
    if (-not $http) { $http = $seed }
    if (-not $https) { $https = $seed }
    if (-not $all) { $all = $seed }
    return @{ Source = "继承调用方环境"; Http = $http; Https = $https; All = $all }
  }

  try {
    $settings = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction Stop
    $enabled = ([int]$settings.ProxyEnable -eq 1)
    $server = [string]$settings.ProxyServer
    if ($enabled -and -not [string]::IsNullOrWhiteSpace($server)) {
      $server = $server.Trim()
      if ($server -notmatch "=") {
        $single = ConvertTo-ProxyUri $server
        return @{ Source = "Windows 当前用户系统代理"; Http = $single; Https = $single; All = $single }
      }

      $map = @{}
      foreach ($entry in ($server -split ";")) {
        if ($entry -match "^\s*([^=]+)=(.+?)\s*$") {
          $map[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim()
        }
      }
      $httpValue = [string]$map["http"]
      $httpsValue = [string]$map["https"]
      $socksValue = [string]$map["socks"]
      if ([string]::IsNullOrWhiteSpace($httpValue)) { $httpValue = $httpsValue }
      if ([string]::IsNullOrWhiteSpace($httpsValue)) { $httpsValue = $httpValue }
      $http = ConvertTo-ProxyUri $httpValue
      $https = ConvertTo-ProxyUri $httpsValue
      $all = if ([string]::IsNullOrWhiteSpace($socksValue)) { $https } else { ConvertTo-ProxyUri $socksValue "socks5" }
      if ($http -or $https -or $all) {
        return @{ Source = "Windows 当前用户分协议系统代理"; Http = $http; Https = $https; All = $all }
      }
    }
  } catch {}

  $fallback = ConvertTo-ProxyUri $FallbackProxy
  if ($fallback) {
    return @{ Source = "回退代理"; Http = $fallback; Https = $fallback; All = $fallback }
  }
  return $null
}

function Set-SharedProxyEnvironment {
  $proxy = Resolve-SharedProxy
  if (-not $proxy) {
    Write-Warning "未解析到共享 app-server 外网代理；Remote Control 可能无法连接。"
    return
  }

  if ($proxy.Http) { $env:HTTP_PROXY = $proxy.Http } else { Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue }
  if ($proxy.Https) { $env:HTTPS_PROXY = $proxy.Https } else { Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue }
  if ($proxy.All) { $env:ALL_PROXY = $proxy.All } else { Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue }

  $noProxyParts = @([string]$env:NO_PROXY -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  foreach ($local in @("localhost", "127.0.0.1", "::1")) {
    if ($local -notin $noProxyParts) { $noProxyParts += $local }
  }
  $env:NO_PROXY = ($noProxyParts -join ",")
  Write-Host ("shared app-server 网络代理：" + $proxy.Source)
}
function Get-ProcessInfo([int]$Id) {
  $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  $cmd = ""
  try { $cmd = [string](Get-CimInstance Win32_Process -Filter ("ProcessId=" + $Id)).CommandLine } catch {}
  [pscustomobject]@{ Process = $p; CommandLine = $cmd }
}

function Read-Pid([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $raw = ((Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue) -replace "\s", "")
  if ($raw -match "^\d+$") { return [int]$raw }
  return $null
}

function Get-ListeningPids([int]$Port) {
  $ids = @()
  try {
    $ids += @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess)
  } catch {
    foreach ($line in (netstat -ano 2>$null)) {
      if ($line -match "LISTENING" -and $line -match (":" + $Port + "\s")) {
        $parts = @($line -split "\s+" | Where-Object { $_ })
        if ($parts.Count -ge 5 -and $parts[4] -match "^\d+$") { $ids += [int]$parts[4] }
      }
    }
  }
  @($ids | Select-Object -Unique)
}

function Test-Ready([string]$Url) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2 -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Wait-Ready([string]$Url, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Ready $Url) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Is-CodexServer([string]$Cmd, [int]$Port) {
  return ($Cmd -match "app-server" -and $Cmd -match (":" + $Port + "(?:\D|$)"))
}

function Is-Proxy([string]$Cmd) {
  return ($Cmd -match "shared-app-server-proxy\.js" -and $Cmd -match ":45789" -and $Cmd -match ":45790")
}

function Stop-Owned([string]$PidPath, [ValidateSet("proxy", "backend", "legacy")][string]$Kind) {
  $id = Read-Pid $PidPath
  if (-not $id) { Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue; return $false }
  $info = Get-ProcessInfo $id
  if (-not $info) { Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue; return $false }
  $ok = $false
  if ($Kind -eq "proxy") { $ok = Is-Proxy $info.CommandLine }
  elseif ($Kind -eq "backend") { $ok = ($info.Process.ProcessName -eq "codex" -and (Is-CodexServer $info.CommandLine $backendPort)) }
  else { $ok = ($info.Process.ProcessName -eq "codex" -and (Is-CodexServer $info.CommandLine $publicPort)) }
  if (-not $ok) {
    Write-Host ("[警告] PID 文件指向的进程不符合预期，未停止：PID " + $id) -ForegroundColor Yellow
    return $false
  }
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  return $true
}

function Find-CodexExe {
  $desktopRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
  $desktop = @(
    Get-ChildItem -LiteralPath $desktopRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName "codex.exe") -ErrorAction SilentlyContinue } |
      Where-Object { $_ -and $_.Exists } |
      Sort-Object LastWriteTime -Descending
  )
  if ($desktop.Count -gt 0) { return $desktop[0].FullName }

  try {
    $package = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
      Sort-Object Version -Descending |
      Select-Object -First 1
    if ($package -and (Test-Path -LiteralPath $package.InstallLocation)) {
      $storeCodex = @(
        Get-ChildItem -LiteralPath $package.InstallLocation -Recurse -File -Filter "codex.exe" -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending
      )
      if ($storeCodex.Count -gt 0) { return $storeCodex[0].FullName }
    }
  } catch {}

  $extRoot = Join-Path $env:USERPROFILE ".vscode\extensions"
  $ext = @(Get-ChildItem -LiteralPath $extRoot -Directory -Filter "openai.chatgpt-*-win32-x64" -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  foreach ($item in $ext) {
    $candidate = Join-Path $item.FullName "bin\windows-x86_64\codex.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function Assert-PortsFree {
  foreach ($port in @($publicPort, $backendPort)) {
    $ids = @(Get-ListeningPids $port)
    if ($ids.Count -gt 0) {
      $desc = @()
      foreach ($id in $ids) {
        $info = Get-ProcessInfo $id
        $desc += if ($info) { ($info.Process.ProcessName + " PID=" + $id) } else { ("PID=" + $id) }
      }
      throw ("端口 " + $port + " 已被占用：" + ($desc -join ", "))
    }
  }
}

function Start-Stack {
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  if (-not (Test-Path -LiteralPath $proxyScript)) { throw ("缺少代理脚本：" + $proxyScript) }

  $legacyPid = Read-Pid $backendPidFile
  if ($legacyPid) {
    $legacyInfo = Get-ProcessInfo $legacyPid
    if ($legacyInfo -and $legacyInfo.Process.ProcessName -eq "codex" -and (Is-CodexServer $legacyInfo.CommandLine $publicPort)) {
      Write-Host "检测到旧版 45789 直连共享 server，正在迁移到 45790 + 代理..."
      Stop-Owned $backendPidFile "legacy" | Out-Null
    }
  }

  $proxyPid = Read-Pid $proxyPidFile
  $backendPid = Read-Pid $backendPidFile
  $proxyInfo = if ($proxyPid) { Get-ProcessInfo $proxyPid } else { $null }
  $backendInfo = if ($backendPid) { Get-ProcessInfo $backendPid } else { $null }
  if ($proxyInfo -and $backendInfo -and (Is-Proxy $proxyInfo.CommandLine) -and (Is-CodexServer $backendInfo.CommandLine $backendPort) -and (Test-Ready $publicReady) -and (Test-Ready $backendReady)) {
    Write-Host ("共享栈已运行：Desktop/AOI -> " + $publicUrl + " -> " + $backendUrl)
    return
  }

  Stop-Owned $proxyPidFile "proxy" | Out-Null
  Stop-Owned $backendPidFile "backend" | Out-Null
  Assert-PortsFree

  $codex = Find-CodexExe
  if (-not $codex) { throw "未找到 Codex Desktop / Microsoft Store 包 / VS Code 扩展内置 codex.exe" }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw "未找到 node.exe；AOI 要求 Node.js >= 20" }

  Set-SharedProxyEnvironment

  $backend = Start-Process -FilePath $codex -ArgumentList @("app-server", "--listen", $backendUrl) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr -PassThru
  Set-Content -LiteralPath $backendPidFile -Value ([string]$backend.Id) -Encoding ascii
  if (-not (Wait-Ready $backendReady 30)) {
    Stop-Owned $backendPidFile "backend" | Out-Null
    throw ("真实 app-server 未就绪，请看 " + $backendErr)
  }

  try {
    $proxyArgs = @("`"$proxyScript`"", "--listen", $publicUrl, "--backend", $backendUrl)
    $proxy = Start-Process -FilePath $node -ArgumentList $proxyArgs -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $proxyOut -RedirectStandardError $proxyErr -PassThru
    Set-Content -LiteralPath $proxyPidFile -Value ([string]$proxy.Id) -Encoding ascii
    if (-not (Wait-Ready $publicReady 15)) { throw ("兼容代理未就绪，请看 " + $proxyErr) }
  } catch {
    Stop-Owned $proxyPidFile "proxy" | Out-Null
    Stop-Owned $backendPidFile "backend" | Out-Null
    throw
  }

  Write-Host ("共享栈已启动：Desktop/AOI -> " + $publicUrl + "（兼容代理） -> " + $backendUrl + "（真实 app-server）")
  Write-Host "shared-stack 不写入任何 User/Machine 环境变量；Desktop 共享 URL 由共享版启动器临时注入。"
}

function Stop-Stack {
  Stop-Owned $proxyPidFile "proxy" | Out-Null
  if (-not (Stop-Owned $backendPidFile "backend")) { Stop-Owned $backendPidFile "legacy" | Out-Null }
  foreach ($port in @($publicPort, $backendPort)) {
    $ids = @(Get-ListeningPids $port)
    if ($ids.Count -gt 0) { Write-Host ("[警告] 端口 " + $port + " 仍被外部进程监听，未自动停止：" + ($ids -join ",")) -ForegroundColor Yellow }
  }
  Write-Host "共享栈已停止；未修改任何 User/Machine 环境变量。"
}

try {
  if ($Action -eq "start") { Start-Stack } else { Stop-Stack }
  exit 0
} catch {
  Show-Error $_.Exception.Message
  exit 1
}
