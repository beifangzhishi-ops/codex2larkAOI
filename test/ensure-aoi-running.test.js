import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureAoiRunning } from "../scripts/ensure-aoi-running.js";

test("AOI login task hot-attaches the shared backend even if the bridge is running", async () => {
  const root = mkdtempSync(join(tmpdir(), "aoi-ensure-"));
  try {
    writeFileSync(join(root, ".env"), "CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:45789\n");
    let launches = 0;
    let sharedStarts = 0;
    const status = await ensureAoiRunning({
      root,
      readPid: () => 123,
      isRunning: () => true,
      launch: async () => { launches++; return { pid: 456 }; },
      startShared: async () => { sharedStarts++; },
    });
    assert.deepEqual(status, { status: "running", pid: 123 });
    assert.equal(launches, 0);
    assert.equal(sharedStarts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AOI login task launches bridge only when absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "aoi-ensure-"));
  try {
    writeFileSync(join(root, ".env"), "CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:45789\n");
    let launches = 0;
    const status = await ensureAoiRunning({
      root,
      readPid: () => 123,
      isRunning: () => false,
      launch: async () => { launches++; return { pid: 456 }; },
    });
    assert.deepEqual(status, { status: "started", pid: 456 });
    assert.equal(launches, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AOI login task refuses to spawn a private app-server", async () => {
  const root = mkdtempSync(join(tmpdir(), "aoi-ensure-"));
  try {
    writeFileSync(join(root, ".env"), "CODEX_MODEL=gpt-6\n");
    await assert.rejects(
      ensureAoiRunning({ root, launch: () => assert.fail("must not launch") }),
      /CODEX_APP_SERVER_WS_URL/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
