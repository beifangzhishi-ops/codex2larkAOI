import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSharedStack, isProcessRunning, launchService, readBridgePid } from "../src/service-control.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function ensureAoiRunning({
  root = ROOT,
  readPid = readBridgePid,
  isRunning = isProcessRunning,
  launch = launchService,
  startShared = ensureSharedStack,
} = {}) {
  // Startup requires the shared App Server endpoint in the project configuration.
  const env = readFileSync(join(root, ".env"), "utf8");
  const endpoint = env.match(/^\s*CODEX_APP_SERVER_WS_URL\s*=\s*(.*?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "");
  if (!endpoint || !/^wss?:\/\//i.test(endpoint)) {
    throw new Error("AOI 开机启动要求在 .env 中配置共享 CODEX_APP_SERVER_WS_URL");
  }

  const pid = readPid(join(root, ".state", "bridge.pid"));
  if (pid && isRunning(pid)) {
    // A new start request must also recover a missing shared backend even
    // when the Feishu bridge itself is already running.
    await startShared({ root });
    console.log(`[ensure-aoi] already running pid=${pid}`);
    return { status: "running", pid };
  }

  const started = await launch({ root });
  console.log(`[ensure-aoi] started pid=${started.pid}`);
  return { status: "started", pid: started.pid };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureAoiRunning().catch((error) => {
    console.error(`[ensure-aoi] ${error.message}`);
    process.exitCode = 1;
  });
}
