$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$entrypoint = Join-Path $PSScriptRoot "ensure-aoi-running.js"
$taskName = "Codex2Lark-AOI"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$user = "$env:USERDOMAIN\$env:USERNAME"

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
