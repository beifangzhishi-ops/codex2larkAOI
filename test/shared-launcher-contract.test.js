import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/shared-stack.ps1", import.meta.url), "utf8");

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
