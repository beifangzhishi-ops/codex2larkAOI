import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/shared-stack.ps1", import.meta.url), "utf8");
const functions = source.slice(source.indexOf('function Show-Error'), source.lastIndexOf('\ntry {'));

for (const owned of [true, false]) {
  test(`半栈恢复必须核验代理归属 ${owned}`, { skip: process.platform !== "win32" }, () => {
    const mocks = `
$proxyPidFile = "proxy.pid"
$backendPidFile = "backend.pid"
$proxyScript = "proxy.js"
$stateDir = ".state"
function New-Item { }
function Test-Path { return $true }
function Get-StackListeners { return @{ Proxy = @(123); Backend = @(); PublicPids = @(123); BackendPids = @() } }
function Test-Ready { return $false }
function Read-Pid([string]$Path) { if ($Path -eq $proxyPidFile) { return 123 }; return $null }
function Get-ProcessInfo { return @{ CommandLine = '代理' } }
function Is-OwnedProxy { return $${owned} }
function Get-RuntimeReport { throw '已进入后端恢复' }
try { Start-Stack } catch { Write-Output $_.Exception.Message }
`;
    const command = `& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(functions + mocks).toString("base64")}'))))`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, owned ? /已进入后端恢复/ : /No process will be replaced/);
  });
}
