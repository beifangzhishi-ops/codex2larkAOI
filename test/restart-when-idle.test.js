import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { waitForIdle, launchServiceControl } from "../scripts/restart-when-idle.js";

test("safe restart launches the Node service controller without cmd.exe quoting", async () => {
  const calls = [];
  const root = resolve("test project with spaces");
  const node = resolve("node executable");
  const spawnProcess = (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  for (const action of ["stop", "launch"]) {
    await launchServiceControl(action, { spawnProcess, projectRoot: root, nodeExecutable: node });
  }
  assert.deepEqual(calls.map(({ exe, args, options }) => ({
    exe, args, cwd: options.cwd, windowsHide: options.windowsHide,
  })), ["stop", "launch"].map((action) => ({
    exe: node, args: [resolve(root, "src/service-control.js"), action],
    cwd: root, windowsHide: true,
  })));
  assert.throws(() => launchServiceControl("start.cmd"), /Unsupported AOI service action/);
});

test("safe restart rejects a failed service-control child", async () => {
  await assert.rejects(launchServiceControl("stop", { spawnProcess: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 1));
    return child;
  } }), /AOI stop 返回 1/);
});

test("仅连续两次确认全部绑定线程空闲后允许重启", async () => {
  let time = 0, checks = 0;
  const sleeps = [];
  await waitForIdle({ expectedPid: 1, getPid: () => 1, getThreads: () => ["t"], now: () => time,
    readThread: async () => ({ thread: { status: { type: ++checks === 1 ? "active" : "idle" } } }),
    delay: async (ms) => { time += ms; sleeps.push(ms); }, log: () => {} });
  assert.equal(checks, 3); assert.deepEqual(sleeps, [15_000, 5_000]);
});

test("状态读取失败继续等待，外部PID变化时取消操作", async () => {
  let pid = 1;
  await assert.rejects(waitForIdle({ expectedPid: 1, getPid: () => pid, getThreads: () => ["t"],
    readThread: async () => { throw new Error("断线"); }, delay: async () => { pid = 2; }, log: () => {} }), /PID 已变化/);
});

test("长时间运行的任务保持服务不变，等待期限到达仅取消重启", async () => {
  let time = 0;
  await assert.rejects(waitForIdle({ expectedPid: 1, getPid: () => 1, getThreads: () => ["t"], now: () => time,
    maxWaitMs: 20, readThread: async () => ({ thread: { status: { type: "active" } } }),
    delay: async (ms) => { time += ms; }, log: () => {} }), /现有服务保持运行/);
});
