import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { CodexAppServer } from "../src/codex-app-server.js";
import { parseDotEnv, buildConfig } from "../src/bridge.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function hasReadyEventConsumers(log) {
  return ["im.message.receive_v1", "card.action.trigger"]
    .every((key) => log.includes(`[event] ready event_key=${key}`));
}

export function verifyCurrentBridge() {
  const stateDir = resolve(ROOT, ".state");
  const pidFile = resolve(stateDir, "bridge.pid");
  const resultFile = resolve(stateDir, "idle-restart-result.json");
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("AOI bridge PID is missing");
  process.kill(pid, 0);
  const log = readFileSync(resolve(stateDir, "bridge.err.log"), "utf8");
  if (!hasReadyEventConsumers(log)) throw new Error("AOI event consumers are not ready");
  writeFileSync(resultFile, JSON.stringify({
    status: "verified", pid, verification: "Both Feishu event consumers are ready",
    time: new Date().toISOString(),
  }, null, 2));
  console.log(`AOI bridge verified: PID=${pid}; both Feishu event consumers ready`);
}

export async function waitForIdle({ readThread, getThreads, getPid, expectedPid,
  delay = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now,
  maxWaitMs = 12 * 60 * 60 * 1000, intervalMs = 15_000, log = console.log }) {
  const deadline = now() + maxWaitMs;
  let previousIdle = false;
  while (now() < deadline) {
    if (getPid() !== expectedPid) throw new Error("AOI PID 已变化，取消本次延后重启，避免影响其他启动操作。");
    let idle = true;
    for (const threadId of getThreads()) {
      try {
        const result = await readThread(threadId);
        if (result?.thread?.status?.type !== "idle" && result?.thread?.status?.type !== "notLoaded") idle = false;
      } catch { idle = false; }
    }
    if (idle && previousIdle) return;
    log(idle ? "绑定会话已空闲，等待再次确认。" : "绑定会话仍在运行或状态未确认，继续等待，不停止服务。");
    previousIdle = idle;
    await delay(idle ? 5_000 : intervalMs);
  }
  throw new Error("等待空闲超过12小时，已取消自动重启；现有服务保持运行。");
}

export function launchServiceControl(action, {
  spawnProcess = spawn, projectRoot = ROOT, nodeExecutable = process.execPath,
} = {}) {
  if (!["stop", "launch"].includes(action)) throw new Error(`Unsupported AOI service action: ${action}`);
  return new Promise((done, fail) => {
    const child = spawnProcess(nodeExecutable, [resolve(projectRoot, "src/service-control.js"), action],
      { cwd: projectRoot, windowsHide: true, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) => code === 0 ? done() : fail(new Error(`AOI ${action} 返回 ${code}`)));
  });
}

export async function main() {
  const stateDir = resolve(ROOT, ".state");
  const pidFile = resolve(stateDir, "bridge.pid");
  const resultFile = resolve(stateDir, "idle-restart-result.json");
  const getPid = () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
  const oldPid = getPid();
  if (!oldPid) throw new Error("AOI 未运行，不执行延后重启。");
  const config = buildConfig(parseDotEnv(readFileSync(resolve(ROOT, ".env"), "utf8")));
  const client = new CodexAppServer({ cwd: ROOT, command: config.codexCommand, websocketUrl: config.appServerWebSocketUrl });
  try {
    if (!config.appServerWebSocketUrl) throw new Error("空闲检查仅适用于共享 WebSocket App Server。");
    await client.start();
    await waitForIdle({ expectedPid: oldPid, getPid,
      getThreads: () => [...new Set(Object.values(JSON.parse(readFileSync(resolve(stateDir, "sessions.json"), "utf8")).sessions || {}))],
      readThread: (threadId) => client.request("thread/read", { threadId }) });
    client.stop();
    if (getPid() !== oldPid) throw new Error("AOI PID 已变化，取消重启。");
    console.log(`空闲已确认，停止 AOI 旧进程 ${oldPid}。`);
    await launchServiceControl("stop");
    if (existsSync(pidFile)) throw new Error("旧 PID 文件仍在，停止后续启动并保留排查日志。");
    await launchServiceControl("launch");
    const newPid = getPid();
    if (!newPid || newPid === oldPid) throw new Error("未取得新的 AOI PID。");
    process.kill(newPid, 0);
    let ready = false;
    const readyDeadline = Date.now() + 30_000;
    while (Date.now() < readyDeadline) {
      process.kill(newPid, 0);
      const errors = readFileSync(resolve(stateDir, "bridge.err.log"), "utf8");
      ready = hasReadyEventConsumers(errors);
      if (ready) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    if (!ready) {
      throw new Error("AOI 已启动，但事件消费者/飞书连接验证尚未通过，请检查运行日志。");
    }
    writeFileSync(resultFile, JSON.stringify({ 状态: "已完成", 旧PID: oldPid, 新PID: newPid,
      验证: "两个事件消费者就绪，飞书连接成功，共享事件总线未停止", 时间: new Date().toISOString() }, null, 2));
    console.log(`AOI 已完成空闲重启并验证：${oldPid} -> ${newPid}；共享事件总线未停止。`);
  } catch (error) {
    writeFileSync(resultFile, JSON.stringify({ 状态: "未完成", 原因: error.message, 旧PID: oldPid, 时间: new Date().toISOString() }, null, 2));
    throw error;
  } finally { client.stop(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--verify") {
    try { verifyCurrentBridge(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  } else {
    main().catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
