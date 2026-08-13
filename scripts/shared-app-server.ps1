param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("start", "stop")]
  [string]$Action,
  [switch]$NoGui
)

$ErrorActionPreference = "Stop"

$port = 45789
$url = "ws://127.0.0.1:$port"
$readyUrl = "http://127.0.0.1:$port/readyz"
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".state"
$pidFile = Join-Path $stateDir "shared-app-server.pid"
$outLog = Join-Path $stateDir "shared-app-server.out.log"
$errLog = Join-Path $stateDir "shared-app-server.err.log"
$envVarName = "CODEX_APP_SERVER_WS_URL"

function Show-Error {
  param([string]$message)
  Write-Host ("[错误] " + $message) -ForegroundColor Red
  if ($NoGui) {
    return
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show($message, "共享 Codex app-server", "OK", "Error") | Out-Null
  } catch {}
}

function Get-PortListeners {
  param([int]$targetPort)
  $list = @(Get-NetTCPConnection -State Listen -LocalPort $targetPort -ErrorAction SilentlyContinue)
  if ($list.Count -eq 0) {
    $netstatLines = netstat -ano 2>$null
    foreach ($line in $netstatLines) {
      if ($line -match "LISTENING" -and $line -match (":" + $targetPort + "\s")) {
        $tokens = @($line -split "\s+" | Where-Object { $_ })
        if ($tokens.Count -ge 5 -and $tokens[4] -match "^\d+$") {
          $list += [pscustomobject]@{ OwningProcess = [int]$tokens[4] }
        }
      }
    }
  }
  return $list
}

function Get-ProcessInfo {
  param([int]$processId)
  $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $proc) {
    return $null
  }
  $cmdLine = ""
  try {
    $cmdLine = [string](Get-CimInstance Win32_Process -Filter ("ProcessId=" + $processId) -ErrorAction Stop).CommandLine
  } catch {}
  return [pscustomobject]@{ Process = $proc; CommandLine = $cmdLine }
}

function Test-Ready {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $readyUrl -TimeoutSec 2 -ErrorAction Stop
    return ($resp.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Test-IsCodexAppServer {
  param([string]$cmdLine)
  return ($cmdLine -match "app-server" -and $cmdLine -match (":" + $port))
}

function Test-IsProjectBridge {
  param([string]$cmdLine, [string]$projectToken)
  return ($cmdLine -match ("codex2lark" + $projectToken) -and $cmdLine -match "bridge\.js|service-control\.js")
}

function Set-UserEnv {
  param([string]$name, [string]$value)
  try {
    [Environment]::SetEnvironmentVariable($name, $value, "User")
  } catch {
    Show-Error ("写入用户环境变量 " + $name + " 失败：" + $_.Exception.Message)
    exit 1
  }
}

function Probe-Port {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", $port, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne(1500)) {
      $client.EndConnect($async) | Out-Null
    }
    $client.Close()
  } catch {}
}

function Invoke-Start {
  $extRoot = Join-Path $env:USERPROFILE ".vscode\extensions"
  $candidates = @(Get-ChildItem -LiteralPath $extRoot -Directory -Filter "openai.chatgpt-*-win32-x64" -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  if ($candidates.Count -eq 0) {
    Show-Error "未找到 Codex VS Code 扩展，请先安装或更新 openai.chatgpt 扩展"
    exit 1
  }
  $codexExe = Join-Path $candidates[0].FullName "bin\windows-x86_64\codex.exe"
  if (-not (Test-Path -LiteralPath $codexExe)) {
    Show-Error ("扩展内核不存在：" + $codexExe)
    exit 1
  }

  if (Test-Path -LiteralPath $pidFile) {
    $pidText = ((Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue) -replace "\s", "")
    if ($pidText -match "^\d+$") {
      $info = Get-ProcessInfo ([int]$pidText)
      if ($info -and $info.Process.ProcessName -eq "codex" -and (Test-IsCodexAppServer $info.CommandLine) -and (Test-Ready)) {
        Set-UserEnv $envVarName $url
        Write-Host ("共享 app-server 已在运行（PID " + $pidText + "，端口 " + $port + "），跳过启动。")
        Write-Host ("用户环境变量 " + $envVarName + " 已确保为 " + $url)
        Write-Host "桌面端重启一次后生效。"
        exit 0
      }
    }
  }

  $listeners = @(Get-PortListeners $port)
  if ($listeners.Count -gt 0) {
    $usable = $false
    $ghost = $false
    $unknown = $false
    $unknownDesc = ""
    foreach ($listener in $listeners) {
      $info = Get-ProcessInfo ([int]$listener.OwningProcess)
      if (-not $info) {
        $ghost = $true
        continue
      }
      if ($info.Process.ProcessName -eq "codex" -and (Test-IsCodexAppServer $info.CommandLine)) {
        if (Test-Ready) {
          $usable = $true
        } else {
          $unknown = $true
          $unknownDesc = "codex app-server（PID " + $listener.OwningProcess + "）存在但 /readyz 不可用"
        }
      } else {
        $unknown = $true
        $unknownDesc = "进程 " + $info.Process.ProcessName + "（PID " + $listener.OwningProcess + "）"
      }
    }

    if ($usable) {
      Set-UserEnv $envVarName $url
      Write-Host ("检测到已运行的共享 app-server（端口 " + $port + "），已复用并写入环境变量。")
      Write-Host "桌面端重启一次后生效。"
      exit 0
    }

    if ($ghost) {
      Write-Host ("[提示] 端口 " + $port + " 存在幽灵监听（PID 不存在），尝试发起连接探测清理...") -ForegroundColor Yellow
      Probe-Port
      Start-Sleep -Milliseconds 1500
      $afterProbe = @(Get-PortListeners $port)
      if ($afterProbe.Count -eq 0) {
        Write-Host "幽灵监听已被清理，继续启动。"
      } else {
        Show-Error ("端口 " + $port + " 仍有幽灵监听（PID 不存在），通常需要重启 Codex 桌面端或电脑后释放。")
        exit 1
      }
    }

    if ($unknown) {
      Show-Error ("端口 " + $port + " 被其他进程占用（" + $unknownDesc + "），无法启动共享 app-server。请先排查：Get-NetTCPConnection -LocalPort " + $port + " | Select OwningProcess")
      exit 1
    }
  }

  [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $proc = Start-Process -FilePath $codexExe -ArgumentList @("app-server", "--listen", $url) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Set-Content -LiteralPath $pidFile -Value ([string]$proc.Id) -Encoding ascii
  Start-Sleep -Milliseconds 1500

  if ($proc.HasExited) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    $logTail = ""
    if (Test-Path -LiteralPath $errLog) {
      $logTail = (Get-Content -LiteralPath $errLog -Tail 5) -join "`n"
    }
    if (Test-Ready) {
      Set-UserEnv $envVarName $url
      Write-Host ("共享 app-server 进程启动后退出，但端口已被可用实例接管（" + $url + "），已复用并写入环境变量。")
      exit 0
    }
    Show-Error ("共享 app-server 启动后立即退出（退出码 " + $proc.ExitCode + "）。日志尾部：`n" + $logTail)
    exit 1
  }

  Write-Host ("共享 app-server 启动中（PID " + $proc.Id + "），等待就绪...")
  $ready = $false
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-Ready) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not $ready) {
    try {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    } catch {}
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    $logTail = ""
    if (Test-Path -LiteralPath $errLog) {
      $logTail = (Get-Content -LiteralPath $errLog -Tail 5) -join "`n"
    }
    Show-Error ("共享 app-server 启动超时，请查看日志：" + $errLog + "`n" + $logTail)
    exit 1
  }

  Set-UserEnv $envVarName $url
  Write-Host ("共享 app-server 已启动（PID " + $proc.Id + "，端口 " + $port + "）")
  Write-Host ("用户环境变量 " + $envVarName + "=" + $url)
  Write-Host "桌面端重启一次后生效。"
  exit 0
}

function Invoke-Stop {
  $stopped = $false
  $ghostSeen = $false
  $externalSeen = $false
  $bridgeSeen = @()
  $akaRoot = ""
  $unknownSeen = $null

  if (Test-Path -LiteralPath $pidFile) {
    $pidText = ((Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue) -replace "\s", "")
    if ($pidText -match "^\d+$") {
      $info = Get-ProcessInfo ([int]$pidText)
      if (-not $info) {
        Write-Host ("PID 文件中的进程已不存在，忽略：" + $pidText)
      } elseif ($info.Process.ProcessName -eq "codex") {
        if (Test-IsCodexAppServer $info.CommandLine) {
          Stop-Process -Id $info.Process.Id -Force -ErrorAction SilentlyContinue
          Start-Sleep -Milliseconds 500
          Write-Host ("已停止共享 app-server（PID " + $pidText + "）")
          $stopped = $true
        } else {
          Write-Host ("PID 文件中的进程不是共享 app-server，跳过停止：" + $info.CommandLine)
        }
      } else {
        Write-Host ("PID 文件中的进程已存在但不是 codex，忽略：" + $pidText)
      }
    } else {
      Write-Host "PID 文件内容无效，忽略。"
    }
  } else {
    Write-Host "未找到共享 app-server PID 文件（可能未通过脚本启动）。"
  }

  Set-UserEnv $envVarName $null
  Write-Host ("已删除用户环境变量 " + $envVarName + "。")
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

  $listeners = @(Get-PortListeners $port)
  foreach ($listener in $listeners) {
    $info = Get-ProcessInfo ([int]$listener.OwningProcess)
    if (-not $info) {
      $ghostSeen = $true
      continue
    }
    $cmd = $info.CommandLine
    if ($info.Process.ProcessName -eq "codex" -and (Test-IsCodexAppServer $cmd)) {
      $externalSeen = $true
      continue
    }
    if (Test-IsProjectBridge $cmd "AOI") {
      $bridgeSeen += "AOI"
      continue
    }
    if (Test-IsProjectBridge $cmd "AKA") {
      $bridgeSeen += "AKA"
      $match = [regex]::Match($cmd, "(?i)([A-Za-z]:[\\/][^""\s]*?codex2larkAKA)")
      if ($match.Success) {
        $akaRoot = $match.Groups[1].Value
      }
      continue
    }
    $unknownSeen = "进程 " + $info.Process.ProcessName + "（PID " + $listener.OwningProcess + "）：" + $cmd
  }

  foreach ($which in @($bridgeSeen | Select-Object -Unique)) {
    $stopCmd = Join-Path $root "stop.cmd"
    if ($which -eq "AKA") {
      if (-not $akaRoot) {
        Show-Error "检测到 AKA 桥接监听，但无法从命令行解析 AKA 项目根目录。"
        exit 1
      }
      $stopCmd = Join-Path $akaRoot "stop.cmd"
    }
    Write-Host ("检测到 " + $which + " 桥接仍占用端口，自动停止 " + $which + " ...")
    & $stopCmd "--no-pause-on-error"
    if ($LASTEXITCODE -ne 0) {
      Show-Error ($which + " 停止失败（退出码 " + $LASTEXITCODE + "），请手动执行 " + $stopCmd)
      exit 1
    }
  }
  if ($bridgeSeen.Count -gt 0) {
    Show-Error ("端口 " + $port + " 被 AOI/AKA 桥接占用，已自动停止相应桥接。")
  }

  if ($unknownSeen) {
    Show-Error ("端口 " + $port + " 仍有未知进程监听：" + $unknownSeen + "。请手动确认处理。")
    exit 1
  }

  if ($ghostSeen) {
    Write-Host ("[警告] 端口 " + $port + " 仍有幽灵监听（PID 不存在）。共享 server 已停止，该残留通常需要重启 Codex 桌面端或电脑后释放。") -ForegroundColor Yellow
  } elseif ($externalSeen) {
    Write-Host ("[警告] 端口 " + $port + " 仍有其他共享 app-server 实例监听，未自动停止（避免误杀）。环境变量与 PID 文件已清理。") -ForegroundColor Yellow
  }

  if (-not $stopped) {
    Write-Host "共享 app-server 未通过脚本停止（可能本来就不是脚本启动的）。"
  } else {
    Write-Host "共享 app-server 已停止，桌面端下次启动将使用内置内核。"
  }
  exit 0
}

if ($Action -eq "start") {
  Invoke-Start
} else {
  Invoke-Stop
}
