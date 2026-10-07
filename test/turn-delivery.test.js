import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ExecutionBudget, TurnDelivery } from "../src/turn-delivery.js";
import { BridgeRuntime, buildConfig, normalizePersistedState, classifyAgentMessage } from "../src/bridge.js";

class Clock {
  time = 0;
  next = 0;
  timers = new Map();
  now = () => this.time;
  setTimer = (fn, delay) => { const id = ++this.next; this.timers.set(id, { fn, at: this.time + delay }); return id; };
  clearTimer = (id) => this.timers.delete(id);
  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await settle();
    }
    this.time = target;
    await settle();
  }
}
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const final = (id = "final-1", text = "完整最终结果") => ({ id, type: "agentMessage", phase: "final_answer", text });
const event = { chatId: "chat", messageId: "message", eventId: "event", content: "测试任务" };

class Client extends EventEmitter {
  requests = [];
  responses = [];
  turn = { id: "turn", status: "inProgress", items: [] };
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/read") return { thread: { turns: [this.turn] } };
    if (method === "turn/start") return { turn: { id: "turn" } };
    if (method === "model/list") return { data: [{ id: "model", model: "model", isDefault: true,
      defaultReasoningEffort: "high", supportedReasoningEfforts: ["high"] }] };
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  async start() {}
  stop() {}
}

function fixture({ state = normalizePersistedState(), ...overrides } = {}) {
  state.sessions.chat = "thread";
  state.workdirs.chat = process.cwd();
  const client = new Client();
  const clock = new Clock();
  const sent = [], plans = [], tasks = [], cards = [];
  const config = buildConfig({ FEISHU_ALLOWED_OPEN_IDS: "ou_test", CODEX_WORKDIR: process.cwd(), CODEX_REACTIONS: "false" });
  config.reactions = false;
  const runtime = new BridgeRuntime(state, config, { client, save: () => {}, ...clock,
    reply: async (...args) => { sent.push(args); return { consumedImages: [], messageIds: ["prompt-text"] }; },
    card: async (...args) => { cards.push(args); return { stdout: '{"data":{"message_id":"prompt-card"}}' }; },
    updateCard: async () => {}, deliverFiles: async () => {},
    planDelivery: async (...args) => plans.push(args), ...overrides });
  const active = { ...event, chatId: "chat", threadId: "thread", turnId: "turn", event,
    cwd: process.cwd(), collaborationMode: "plan", finalMessages: [], progressKeys: new Set(),
    sendQueue: Promise.resolve(), pendingAgent: null, resolveDone: () => {}, rejectDone: () => {} };
  runtime.activeThreads.set("thread", active);
  runtime.loadedThreads.add("thread");
  const notify = (method, params = {}) => client.emit("notification", { method,
    params: { threadId: "thread", turnId: "turn", ...params } });
  const input = (blocking = false, questions = [{ id: "q", question: "选择范围", options: [{ label: "全部" }] }]) => {
    client.emit("serverRequest", { id: 7, method: "item/tool/requestUserInput",
      params: { threadId: "thread", turnId: "turn", itemId: "tool", isBlocking: blocking, questions } });
    return runtime.pendingUserInputs.get("chat")[0];
  };
  const answer = (entry, q = "q", value = "全部") => runtime.route({ ...event,
    eventId: `answer-${value}`, inputId: entry.inputId, questionId: q, answer: value }, { type: "userInput" });
  return { runtime, state, client, clock, active, sent, plans, tasks, cards, notify, input, answer };
}

test("阻塞等待暂停累计额度，多题等待结束后恢复剩余时间", async () => {
  const clock = new Clock(); let expired = 0;
  const budget = new ExecutionBudget(100, () => expired++, clock);
  await clock.advance(30); budget.pause("q1"); budget.pause("q2");
  await clock.advance(1000); budget.resume("q1");
  await clock.advance(1000); assert.equal(expired, 0);
  budget.resume("q2"); await clock.advance(69); assert.equal(expired, 0);
  await clock.advance(1); assert.equal(expired, 1);
});

test("最终消息在轮次完成前交付，重复事件不重复发送", async () => {
  const f = fixture();
  f.notify("item/completed", { item: final() });
  await settle(); assert.equal(f.sent.length, 1);
  f.notify("item/completed", { item: final() });
  f.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  await settle(); assert.equal(f.sent.length, 1);
});

test("超时清掉执行状态后约39秒到达的最终结果仍交付", async () => {
  const f = fixture();
  f.notify("turn/started", { turn: { id: "turn" } });
  f.runtime.activeThreads.delete("thread");
  await f.clock.advance(39_000);
  f.notify("item/completed", { item: final() });
  f.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  await settle(); assert.equal(f.sent.length, 1);
});

test("超时边界的计划独立交付且不产生空结果提示", async () => {
  const f = fixture();
  f.notify("turn/started", { turn: { id: "turn" } });
  f.runtime.activeThreads.delete("thread");
  f.notify("item/completed", { item: { id: "plan", type: "plan", text: "完整计划" } });
  f.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  await settle(); assert.equal(f.plans.length, 1); assert.equal(f.sent.length, 0);
});

test("迟到旧轮次结果不能混进同线程新轮次", async () => {
  const f = fixture();
  f.notify("turn/started", { turn: { id: "turn" } });
  f.active.turnId = "new-turn";
  f.notify("item/completed", { item: final() });
  await settle(); assert.equal(f.sent.length, 1); assert.equal(f.active.finalMessages.length, 0);
});

test("非阻塞90秒解除RPC，不选默认答案，旧卡片仍可晚答", async () => {
  const f = fixture(); const entry = f.input(); await settle();
  await f.clock.advance(90_000);
  assert.deepEqual(f.client.responses, [{ id: 7, result: { answers: {} } }]);
  assert.equal(entry.rpcPending, false);
  f.runtime.activeThreads.delete("thread");
  f.runtime.threadQueues = { enqueue: (threadId, task) => f.tasks.push({ threadId, task }) };
  await f.answer(entry); await f.answer(entry);
  assert.equal(f.tasks.length, 1); assert.equal(f.tasks[0].threadId, "thread");
  assert.match(f.tasks[0].task.event.content, /选择范围/);
  assert.match(f.tasks[0].task.event.content, /全部/);
});

test("多题阻塞请求全部回答才提交，桌面解除通知取消计时器", async () => {
  const f = fixture(); const entry = f.input(true, [
    { id: "q", question: "范围", options: [{ label: "全部" }] },
    { id: "q2", question: "格式", options: [{ label: "文件" }] },
  ]);
  await f.answer(entry); assert.equal(f.client.responses.length, 0);
  await f.answer(entry, "q2", "文件");
  assert.equal(f.client.responses.length, 1);
  assert.deepEqual(f.client.responses[0].result.answers.q2.answers, ["文件"]);
  const g = fixture(); const pending = g.input();
  g.notify("serverRequest/resolved", { requestId: 7 });
  await g.clock.advance(90_000); assert.equal(g.client.responses.length, 0); assert.equal(pending.rpcPending, false);
});

test("消息内异步问题不会伪装成最终结果，运行中答案走steer", async () => {
  const f = fixture(); const item = { ...final("question", "请回答"), delivery: "async",
    questions: [{ title: "选择范围", options: ["全部"] }] };
  assert.equal(classifyAgentMessage(item).kind, "progress");
  f.notify("item/completed", { item }); await settle();
  const entry = f.runtime.pendingUserInputs.get("chat")[0];
  await f.answer(entry, "question-0");
  assert.equal(f.client.requests.filter((r) => r.method === "turn/steer").length, 1);
  f.notify("item/completed", { item }); await settle();
  assert.equal(f.runtime.pendingUserInputs.has("chat"), false);
  assert.equal(Object.keys(f.state.turnDeliveries).length, 0);
});

test("重启后旧卡片不复用RPC，回答排入同一线程的新轮", async () => {
  const f = fixture(); const entry = f.input(); await settle();
  const g = fixture({ state: normalizePersistedState(JSON.parse(JSON.stringify(f.state))) });
  g.runtime.activeThreads.clear();
  g.runtime.threadQueues = { enqueue: (threadId, task) => g.tasks.push({ threadId, task }) };
  await g.answer(entry);
  assert.equal(g.client.responses.length, 0); assert.equal(g.tasks.length, 1);
  f.runtime.stop(); g.runtime.stop();
});

test("引用旧问题可晚答；其他普通消息不被历史问题截获", async () => {
  const f = fixture(); const entry = f.input(); await settle();
  await f.clock.advance(90_000); f.runtime.activeThreads.clear();
  f.runtime.threadQueues = { enqueue: (threadId, task) => f.tasks.push({ threadId, task }) };
  await f.runtime.route({ ...event, eventId: "normal", content: "新的独立任务" }, null);
  assert.equal(f.tasks.length, 1); assert.equal(f.tasks[0].task.event.content, "新的独立任务");
  await f.runtime.route({ ...event, eventId: "quoted", content: "1", parentMessageId: "prompt-card" }, null);
  assert.equal(f.tasks.length, 2); assert.match(f.tasks[1].task.event.content, /选择范围/);
  assert.equal(entry.rpcPending, false);
});

test("切换绑定后旧卡片和旧最终结果均不投递", async () => {
  const f = fixture(); const entry = f.input();
  f.notify("turn/started", { turn: { id: "turn" } });
  f.state.sessions.chat = "other";
  await f.answer(entry);
  f.notify("item/completed", { item: final() }); await settle();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0][2], /过期/);
  assert.equal(f.client.responses.length, 0);
});

test("发送失败保留重试资格，成功部分不因附件失败重复", async () => {
  let fileAttempts = 0; const messages = [];
  const f = fixture({ reply: async (...args) => { messages.push(args); return {}; },
    deliverFiles: async () => { if (++fileAttempts === 1) throw new Error("附件发送失败"); } });
  const text = "完成\nFILE:C:/test/result.txt";
  f.notify("item/completed", { item: final("file-result", text) }); await settle();
  const record = Object.values(f.state.turnDeliveries)[0];
  await f.runtime.deliveries.flush(record);
  assert.equal(messages.length, 1); assert.equal(fileAttempts, 2);
  assert.ok(Object.values(record.items).every((item) => item.delivered));
});

test("恢复从终态快照补齐缺失结果，并在重启后去重", async () => {
  const records = {}; let sent = 0;
  const make = () => new TurnDelivery(records, { save: () => {}, isBound: () => true,
    deliver: async () => sent++, readThread: async () => ({ thread: { turns: [{ id: "turn", status: "completed", items: [final()] }] } }),
    onSnapshot: async (record, turn) => { await tracker.enqueue(record, turn.items[0]); }, log: { info() {}, warn() {}, error() {} } });
  let tracker = make(); const record = tracker.register({ threadId: "thread", turnId: "turn" });
  record.timedOut = true; await tracker.recover(); assert.equal(sent, 1);
  tracker = make(); await tracker.start(); tracker.stop(); assert.equal(sent, 1);
});

test("执行超时时读取已完成快照，不错误中断；仍运行时WebSocket也中断", async () => {
  for (const complete of [true, false]) {
    const f = fixture({ budgetMs: 100 });
    f.runtime.activeThreads.clear();
    f.client.turn = { id: "turn", status: complete ? "completed" : "inProgress", items: complete ? [final()] : [] };
    const task = { event, snapshot: { threadId: "thread", cwd: process.cwd(), approvalMode: "auto", model: "model", effort: "high" } };
    f.runtime.threadQueues.enqueue("thread", task); await settle();
    await f.clock.advance(100); await settle();
    assert.equal(f.client.requests.some((r) => r.method === "turn/interrupt"), !complete);
    if (complete) assert.ok(f.sent.some((args) => args[2] === "完整最终结果"));
  }
});

test("快照恢复不交付尚未写完的活跃最终消息", async () => {
  const f = fixture(); f.notify("turn/started", { turn: { id: "turn" } });
  const record = Object.values(f.state.turnDeliveries)[0];
  f.client.turn.items = [final("partial", "尚未写完")];
  await f.runtime.deliveries.reconcile(record); assert.equal(f.sent.length, 0);
  f.client.turn.status = "completed";
  await f.runtime.deliveries.reconcile(record); assert.equal(f.sent.length, 1);
});

test("读取后端失败仅提示未确认，不擅自中断且保留补发记录", async () => {
  const f = fixture({ budgetMs: 100 }); f.runtime.activeThreads.clear();
  const original = f.client.request.bind(f.client);
  f.client.request = async (method, params) => {
    if (method === "thread/read") throw new Error("网络暂不可用");
    return original(method, params);
  };
  f.runtime.threadQueues.enqueue("thread", { event, snapshot: { threadId: "thread", cwd: process.cwd(), approvalMode: "auto" } });
  await settle(); await f.clock.advance(100); await settle();
  assert.equal(f.client.requests.some((r) => r.method === "turn/interrupt"), false);
  assert.ok(f.sent.some((args) => /未在执行时限内确认/.test(args[2])));
  assert.equal(Object.keys(f.state.turnDeliveries).length, 1);
});

test("重启后消息内异步问题来源仍运行时继续steer，不错误启动新轮", async () => {
  const f = fixture();
  f.notify("item/completed", { item: { ...final("question", "问题"), questions: [{ title: "范围", options: ["全部"] }] } });
  await settle(); const entry = f.runtime.pendingUserInputs.get("chat")[0];
  const g = fixture({ state: normalizePersistedState(JSON.parse(JSON.stringify(f.state))) });
  g.runtime.activeThreads.clear();
  await g.answer(entry, "question-0");
  assert.equal(g.client.requests.filter((r) => r.method === "turn/steer").length, 1);
});

test("迟到的无phase最终消息在轮次结束时仍可交付", async () => {
  const f = fixture(); f.notify("turn/started", { turn: { id: "turn" } });
  f.runtime.activeThreads.clear();
  f.notify("item/completed", { item: { id: "legacy", type: "agentMessage", text: "旧内核最终结果" } });
  f.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  await settle(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0][2], "旧内核最终结果");
});

test("首次升级订阅旧桥接运行轮次，接住重启后的最终事件", async () => {
  const f = fixture(); f.runtime.activeThreads.clear();
  f.runtime.loadedThreads.clear();
  const original = f.client.request.bind(f.client);
  f.client.request = async (method, params) => method === "thread/resume"
    ? { thread: { id: "thread", turns: [{ id: "turn", status: "inProgress" }] } }
    : original(method, params);
  await f.runtime.start();
  assert.equal(f.runtime.desktopMirrors.get("thread")?.turnId, "turn");
  f.runtime.stop();
});
