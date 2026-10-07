import test from "node:test";
import assert from "node:assert/strict";
import { waitForIdle } from "../scripts/restart-when-idle.js";

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
