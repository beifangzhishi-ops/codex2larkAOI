import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RESTRICTED_PROXY = /^(?:https?|socks5?):\/\/(?:127\.0\.0\.1|localhost):9\/?$/i;

function statePaths(root) {
  const stateDir = resolve(root, ".state");
  return {
    stateDir,
    pidFile: resolve(stateDir, "bridge.pid"),
    stopFile: resolve(stateDir, "stop-requested"),
  };
}

export function removeRestrictedProxies(environment = process.env) {
  const removed = new Set();
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase() !== name || !RESTRICTED_PROXY.test(String(environment[key] || ""))) continue;
      delete environment[key];
      removed.add(name);
    }
  }
  return [...removed];
}

export function requireEnvFile(root = ROOT) {
  if (!existsSync(resolve(root, ".env"))) {
    throw new Error("缺少 .env。请先复制 .env.example 为 .env，并填写 CODEX_WORKDIR 与 FEISHU_ALLOWED_OPEN_IDS。");
  }
}

export function readBridgePid(pidFile) {
  if (!existsSync(pidFile)) return null;
  const value = readFileSync(pidFile, "utf8").trim();
  if (!/^\d+$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function removeFile(file) {
  try {
    unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function stopService({
  root = ROOT,
  pollIntervalMs = 250,
  timeoutMs = 10_000,
  isRunning = isProcessRunning,
  delay = wait,
  now = Date.now,
} = {}) {
  const { stateDir, pidFile, stopFile } = statePaths(root);
  if (!existsSync(pidFile)) return { status: "not-running" };

  const pid = readBridgePid(pidFile);
  if (!pid) {
    removeFile(pidFile);
    return { status: "invalid-pid" };
  }
  if (!isRunning(pid)) {
    removeFile(pidFile);
    return { status: "stale-pid", pid };
  }

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stopFile, `${new Date().toISOString()}\n`, "utf8");
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isRunning(pid)) {
      removeFile(pidFile);
      return { status: "stopped", pid };
    }
    await delay(pollIntervalMs);
  }
  if (!isRunning(pid)) {
    removeFile(pidFile);
    return { status: "stopped", pid };
  }
  return { status: "timeout", pid };
}

export async function startService({ root = ROOT, environment = process.env, startBridge } = {}) {
  requireEnvFile(root);
  process.chdir(root);
  const removed = removeRestrictedProxies(environment);
  if (removed.length) console.log(`[start] 已移除受限环境代理：${removed.join(", ")}`);
  const runBridge = startBridge || (async () => {
    const { main } = await import("./bridge.js");
    await main();
  });
  await runBridge();
}

export async function runServiceCommand(command, options) {
  if (command === "start") {
    await startService(options);
    return 0;
  }
  if (command === "stop") {
    const result = await stopService(options);
    if (result.status === "not-running") {
      console.log("桥接服务未运行。");
      return 0;
    }
    if (result.status === "invalid-pid") {
      console.log("桥接服务未运行，已清理无效 PID 文件。");
      return 0;
    }
    if (result.status === "stale-pid") {
      console.log(`桥接服务未运行，已清理过期 PID=${result.pid}。`);
      return 0;
    }
    if (result.status === "stopped") {
      console.log(`桥接服务及本项目事件消费者已停止，PID=${result.pid}。`);
      return 0;
    }
    throw new Error(`桥接服务未在 10 秒内退出，PID=${result.pid}。未停止共享的 lark-cli 事件总线。`);
  }
  throw new Error("用法：node src/service-control.js <start|stop>");
}

async function main() {
  const command = process.argv[2];
  try {
    process.exitCode = await runServiceCommand(command);
  } catch (error) {
    console.error(`\n[${command || "service"}] ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void main();
