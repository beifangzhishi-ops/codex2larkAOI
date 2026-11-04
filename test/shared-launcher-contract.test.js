import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/shared-stack.ps1", import.meta.url), "utf8");
const desktopLauncher = fs.readFileSync(new URL("../scripts/Start-Codex-Shared-Proxy.ps1", import.meta.url), "utf8");
const runtimeSelector = fs.readFileSync(new URL("../scripts/shared-runtime.js", import.meta.url), "utf8");

test("shared runtime candidates are exclusively Codex Desktop-managed installations", () => {
  assert.match(source, /Join-Path \$env:LOCALAPPDATA "OpenAI\\Codex\\bin"/);
  assert.match(source, /Get-AppxPackage -Name "OpenAI\.Codex"/);
  assert.match(source, /return @\{ desktop = @\(\$desktop\) \}/);
  assert.match(runtimeSelector, /selectRuntime\(\{ desktop = \[\] \}\)/);
  assert.doesNotMatch(source, /\.vscode|openai\.chatgpt-/i);
});

test("shared launchers coordinate first-start and explicit stop across checkouts", () => {
  assert.match(source, /Global\\CodexSharedStack_45789_45790/);
  assert.match(source, /\$mutex\.WaitOne\(60000\)/);
  assert.match(source, /\$mutex\.ReleaseMutex\(\)/);
});

test("shared hot attach verifies both listening process identities", () => {
  assert.match(source, /function Get-StackListeners/);
  assert.match(source, /\$healthy -and \$listeners\.Proxy\.Count -gt 0 -and \$listeners\.Backend\.Count -gt 0/);
  assert.match(source, /Hot-attached to existing shared stack/);
  assert.match(source, /No process will be replaced/);
});

test("shutdown checks checkout-specific proxy and backend ownership", () => {
  assert.match(source, /function Is-OwnedProxy/);
  assert.match(source, /function Is-OwnedBackend/);
  assert.match(source, /if \(\$Kind -eq "proxy"\) \{ \$ok = Is-OwnedProxy/);
  assert.match(source, /else \{ \$ok = Is-OwnedBackend \$info \}/);
  assert.doesNotMatch(source, /Stop-Owned \$backendPidFile "legacy"/);
});

test("Desktop launcher preserves child stack diagnostics on startup failure", () => {
  assert.match(desktopLauncher, /sharedStackScript -Action start -NoGui -FallbackProxy \$FallbackProxy 2>&1\s*\|\s*ForEach-Object/);
  assert.match(desktopLauncher, /\$stackExitCode = \$LASTEXITCODE/);
  assert.doesNotMatch(desktopLauncher, /\$details = @\(/);
  assert.match(source, /Checking Codex runtime and its independent cache/);
  assert.match(source, /Waiting for backend readiness/);
  assert.match(source, /Waiting for proxy readiness/);
});

test("Clash probe uses bounded TCP handshake without Test-NetConnection progress", () => {
  assert.match(desktopLauncher, /function Test-TcpPort/);
  assert.match(desktopLauncher, /ConnectAsync\(\$HostName, \$Port\)/);
  assert.match(desktopLauncher, /\$connect\.Wait\(\$TimeoutMs\)/);
  assert.match(desktopLauncher, /Test-TcpPort -HostName \$expectedProxy.Host -Port \$expectedProxy.Port -TimeoutMs 3000/);
  assert.doesNotMatch(desktopLauncher, /Test-NetConnection/);
});

test("Desktop launchers share a single-instance lock across projects and release it", () => {
  assert.match(desktopLauncher, /Global\\CodexSharedDesktop_SingleLaunch/);
  assert.match(desktopLauncher, /\$desktopMutex\.WaitOne\(90000\)/);
  assert.match(desktopLauncher, /\$desktopMutex\.ReleaseMutex\(\)/);
  assert.match(desktopLauncher, /\$desktopMutex\.Dispose\(\)/);
  const lock = desktopLauncher.indexOf("Global\\CodexSharedDesktop_SingleLaunch");
  const existingDesktop = desktopLauncher.indexOf("Get-Process -Name 'ChatGPT'", lock);
  const launchStack = desktopLauncher.indexOf("Start-SharedStack -ReadyUrl", lock);
  const launchDesktop = desktopLauncher.indexOf("Start-Process -FilePath $packageInfo.ExecutablePath", lock);
  const unlock = desktopLauncher.indexOf("$desktopMutex.ReleaseMutex()", lock);
  assert.ok(lock >= 0 && existingDesktop > lock && launchStack > existingDesktop);
  assert.ok(launchDesktop > launchStack && unlock > launchDesktop);
});

test("Desktop launch does not stop or adopt a running shared stack", () => {
  assert.match(desktopLauncher, /if \(\$runningChatGpt\.Count -gt 0\)/);
  assert.match(desktopLauncher, /exit 20/);
  assert.doesNotMatch(desktopLauncher, /Stop-Stack|shared-stack\.ps1[^\r\n]*-Action stop/);
  assert.match(desktopLauncher, /ChatGPT\.exe did not remain running after launch/);
});
