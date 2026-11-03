$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$entrypoint = Join-Path $PSScriptRoot "ensure-aoi-running.js"
$taskName = "Codex2Lark-AOI"
$profileDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $root))
if ((Split-Path -Leaf (Split-Path -Parent $profileDir)) -ne "Users") {
  throw "AOI repository must be under the intended Windows user's profile: $root"
}
$userName = Split-Path -Leaf $profileDir
$user = "$env:COMPUTERNAME\$userName"
$node = Join-Path $profileDir "AppData\Local\Programs\nodejs\node.exe"
if (-not (Test-Path -LiteralPath $node)) {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
}

if (-not (Test-Path -LiteralPath $entrypoint)) {
  throw "AOI task entrypoint not found: $entrypoint"
}

$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $entrypoint + '"') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = "PT1M"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State, Actions, Triggers
