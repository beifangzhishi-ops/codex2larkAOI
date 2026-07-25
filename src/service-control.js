import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = fileURLToPath(import.meta.url);
const RESTRICTED_PROXY = /^(?:https?|socks5?):\/\/(?:127\.0\.0\.1|localhost):9\/?$/i;

function pathEntries(environment) {
  return Object.keys(environment)
    .filter((key) => key.toUpperCase() === "PATH")
    .flatMap((key) => String(environment[key] || "").split(";"))
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function isWindowsAppsPowerShell(candidate, environment) {
  const normalized = win32.normalize(candidate).toLowerCase();
  const localAppData = String(environment.LOCALAPPDATA || "").trim();
  const userAlias = localAppData
    ? win32.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe").toLowerCase()
    : "";
  return normalized === userAlias
    || /\\Users\\[^\\]+\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh\.exe$/i.test(normalized)
    || /\\Program Files\\WindowsApps\\Microsoft\.PowerShell_[^\\]+\\pwsh\.exe$/i.test(normalized);
}

function canRunPowerShell(candidate, environment, spawnSyncProcess = spawnSync) {
  const result = spawnSyncProcess(candidate, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0",
  ], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function resolvePowerShellExecutable(environment = process.env, {
  platform = process.platform,
  fileExists = existsSync,
  validateExecutable,
  spawnSyncProcess = spawnSync,
} = {}) {
  if (platform !== "win32") return null;
  const candidates = [];
  if (environment.CODEX_POWERSHELL_PATH) candidates.push(String(environment.CODEX_POWERSHELL_PATH).trim());
  if (environment.LOCALAPPDATA) {
    candidates.push(win32.join(environment.LOCALAPPDATA, "Programs", "PowerShell", "7", "pwsh.exe"));
  }
  for (const programFiles of [environment.ProgramW6432, environment.ProgramFiles]) {
    if (programFiles) candidates.push(win32.join(programFiles, "PowerShell", "7", "pwsh.exe"));
  }
  candidates.push(...pathEntries(environment).map((entry) => win32.join(entry, "pwsh.exe")));

  const validate = validateExecutable
    || ((candidate) => canRunPowerShell(candidate, environment, spawnSyncProcess));
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = win32.normalize(candidate);
    const key = normalized.toLowerCase();
    if (seen.has(key) || isWindowsAppsPowerShell(normalized, environment)) continue;
    seen.add(key);
    if (fileExists(normalized) && validate(normalized)) return normalized;
  }
  throw new Error(
    "找不到适用于 Codex Windows 沙箱的非 AppX PowerShell 7。"
      + "请安装便携版或 MSI 版 PowerShell，避免使用 WindowsApps 中的执行别名或 Store 安装目录。",
  );
}

export function preparePowerShellEnvironment(environment = process.env, options = {}) {
  const executable = resolvePowerShellExecutable(environment, options);
  if (!executable) return null;
  const directory = win32.dirname(executable);
  const pathKeys = Object.keys(environment).filter((key) => key.toUpperCase() === "PATH");
  const targetKey = pathKeys.find((key) => key === "Path") || pathKeys[0] || "Path";
  const entries = [directory, ...pathEntries(environment)];
  const uniqueEntries = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = win32.normalize(entry).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueEntries.push(entry);
  }
  for (const key of pathKeys) {
    if (key !== targetKey) delete environment[key];
  }
  environment[targetKey] = uniqueEntries.join(";");
  return executable;
}

function statePaths(root) {
  const stateDir = resolve(root, ".state");
  return {
    stateDir,
    pidFile: resolve(stateDir, "bridge.pid"),
    stopFile: resolve(stateDir, "stop-requested"),
    outputLog: resolve(stateDir, "bridge.out.log"),
    errorLog: resolve(stateDir, "bridge.err.log"),
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

export async function startService({
  root = ROOT,
  environment = process.env,
  startBridge,
  powerShellOptions,
} = {}) {
  requireEnvFile(root);
  process.chdir(root);
  const removed = removeRestrictedProxies(environment);
  if (removed.length) console.log(`[start] 已移除受限环境代理：${removed.join(", ")}`);
  const powerShell = preparePowerShellEnvironment(environment, powerShellOptions);
  if (powerShell) console.log(`[start] PowerShell：${powerShell}`);
  const runBridge = startBridge || (async () => {
    const { main } = await import("./bridge.js");
    await main();
  });
  await runBridge();
  if (process.send) {
    process.send({ type: "ready", pid: process.pid });
    process.disconnect();
  }
}

function failureLog(errorLog) {
  if (!existsSync(errorLog)) return "";
  const text = readFileSync(errorLog, "utf8").trim();
  return text.slice(-4_000);
}

export function waitForBackgroundStart(child, {
  timeoutMs = 60_000,
  readFailureLog = () => "",
} = {}) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      callback(value);
    };
    const fail = (message) => {
      const log = readFailureLog();
      finish(rejectLaunch, new Error(log ? `${message}\n${log}` : message));
    };
    const onMessage = (message) => {
      if (message?.type !== "ready") return;
      child.unref();
      finish(resolveLaunch, { pid: Number(message.pid) || child.pid });
    };
    const onError = (error) => fail(`后台启动失败：${error.message}`);
    const onClose = (code, signal) => fail(`后台启动失败，退出码=${code ?? "未知"}${signal ? `，信号=${signal}` : ""}。`);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* child already exited */ }
      fail(`后台启动超过 ${Math.ceil(timeoutMs / 1000)} 秒，已终止本次启动进程。`);
    }, timeoutMs);
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

export async function launchService({
  root = ROOT,
  environment = process.env,
  startupTimeoutMs = 60_000,
  spawnProcess = spawn,
  powerShellOptions,
} = {}) {
  requireEnvFile(root);
  const childEnvironment = { ...environment };
  removeRestrictedProxies(childEnvironment);
  const powerShell = preparePowerShellEnvironment(childEnvironment, powerShellOptions);
  if (powerShell) console.log(`[start] PowerShell：${powerShell}`);
  const { stateDir, outputLog, errorLog } = statePaths(root);
  mkdirSync(stateDir, { recursive: true });
  const outputFd = openSync(outputLog, "w");
  const errorFd = openSync(errorLog, "w");
  let child;
  try {
    child = spawnProcess(process.execPath, [SCRIPT, "start"], {
      cwd: root,
      env: childEnvironment,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outputFd, errorFd, "ipc"],
    });
  } finally {
    closeSync(outputFd);
    closeSync(errorFd);
  }
  const result = await waitForBackgroundStart(child, {
    timeoutMs: startupTimeoutMs,
    readFailureLog: () => failureLog(errorLog),
  });
  console.log(`[start] 桥接服务已在后台启动，PID=${result.pid}`);
  console.log(`[start] 日志：${outputLog}`);
  return result;
}

export async function runServiceCommand(command, options) {
  if (command === "start") {
    await startService(options);
    return 0;
  }
  if (command === "launch") {
    await launchService(options);
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
  throw new Error("用法：node src/service-control.js <launch|start|stop>");
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
