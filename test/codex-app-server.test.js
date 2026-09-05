import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer } from "../src/codex-app-server.js";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  static openPlan = [];
  static handler = null;

  static reset() {
    this.instances = [];
    this.openPlan = [];
    this.handler = null;
  }

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    const shouldOpen = FakeWebSocket.openPlan.length ? FakeWebSocket.openPlan.shift() : true;
    queueMicrotask(() => {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      if (!shouldOpen) {
        this.readyState = FakeWebSocket.CLOSED;
        this.onerror?.(new Error("connect failed"));
        this.onclose?.();
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.id === undefined) return;
    const result = FakeWebSocket.handler
      ? FakeWebSocket.handler(message, this)
      : defaultResult(message);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) });
    });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.());
  }

  serverClose() {
    this.close();
  }
}

function defaultResult(message) {
  if (message.method === "initialize") return {};
  if (message.method === "thread/start") return { thread: { id: "thread-started" } };
  if (message.method === "thread/resume") return { thread: { id: message.params.threadId } };
  if (message.method === "model/list") return { data: [] };
  return {};
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const originalWebSocket = globalThis.WebSocket;

test.beforeEach(() => {
  FakeWebSocket.reset();
  globalThis.WebSocket = FakeWebSocket;
});

test.after(() => {
  globalThis.WebSocket = originalWebSocket;
});

test("unexpected websocket close reconnects and replays thread/resume subscriptions", async () => {
  const client = new CodexAppServer({
    websocketUrl: "ws://127.0.0.1:45789",
    reconnectDelaysMs: [0, 0],
    requestTimeoutMs: 1000,
  });
  let closed = 0;
  client.on("closed", () => { closed += 1; });
  await client.request("thread/resume", { threadId: "thread-a", cwd: "C:/repo" });
  assert.equal(FakeWebSocket.instances.length, 1);

  const reconnected = once(client, "reconnected");
  FakeWebSocket.instances[0].serverClose();
  await reconnected;

  assert.equal(closed, 0);
  assert.equal(FakeWebSocket.instances.length, 2);
  const methods = FakeWebSocket.instances[1].sent.map((message) => message.method);
  assert.deepEqual(methods.slice(0, 3), ["initialize", "initialized", "thread/resume"]);
  const replay = FakeWebSocket.instances[1].sent.find((message) => message.method === "thread/resume");
  assert.deepEqual(replay.params, { threadId: "thread-a", cwd: "C:/repo" });

  await client.request("model/list", {});
  client.stop();
});

test("reconnect replays only unseen gap items from the resumed thread snapshot", async () => {
  FakeWebSocket.handler = (message, ws) => {
    if (message.method !== "thread/resume") return defaultResult(message);
    const reconnect = FakeWebSocket.instances.indexOf(ws) > 0;
    return {
      thread: {
        id: "thread-gap",
        turns: [
          {
            id: "turn-old",
            status: "completed",
            items: [{ id: "item-old", type: "agentMessage", text: "old" }],
          },
          ...(reconnect ? [{
            id: "turn-gap",
            status: "completed",
            items: [{ id: "item-gap", type: "agentMessage", text: "new during gap" }],
          }] : []),
        ],
      },
    };
  };
  const client = new CodexAppServer({
    websocketUrl: "ws://127.0.0.1:45789",
    reconnectDelaysMs: [0],
    requestTimeoutMs: 1000,
  });
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  await client.request("thread/resume", { threadId: "thread-gap" });
  notifications.length = 0;

  const reconnected = once(client, "reconnected");
  FakeWebSocket.instances[0].serverClose();
  await reconnected;

  assert.deepEqual(notifications.map((message) => message.method), [
    "turn/started",
    "item/completed",
    "turn/completed",
  ]);
  assert.equal(notifications[1].params.item.id, "item-gap");
  assert.equal(notifications.some((message) => message.params.item?.id === "item-old"), false);

  notifications.length = 0;
  const reconnectedAgain = once(client, "reconnected");
  FakeWebSocket.instances[1].serverClose();
  await reconnectedAgain;
  assert.deepEqual(notifications, []);
  client.stop();
});

test("thread/start for the bridge is remembered as a resume subscription after reconnect", async () => {
  FakeWebSocket.handler = (message) => {
    if (message.method === "thread/start") return { thread: { id: "thread-from-start" } };
    return defaultResult(message);
  };
  const client = new CodexAppServer({
    websocketUrl: "ws://127.0.0.1:45789",
    reconnectDelaysMs: [0],
    requestTimeoutMs: 1000,
  });
  await client.request("thread/start", { cwd: "D:/work", serviceName: "codex2lark" });
  const reconnected = once(client, "reconnected");
  FakeWebSocket.instances[0].serverClose();
  await reconnected;

  const replay = FakeWebSocket.instances[1].sent.find((message) => message.method === "thread/resume");
  assert.deepEqual(replay.params, { threadId: "thread-from-start", cwd: "D:/work" });
  client.stop();
});

test("concurrent requests during reconnect share one websocket reconnect", async () => {
  const client = new CodexAppServer({
    websocketUrl: "ws://127.0.0.1:45789",
    reconnectDelaysMs: [10],
    requestTimeoutMs: 1000,
  });
  await client.start();
  FakeWebSocket.instances[0].serverClose();

  const [left, right] = await Promise.all([
    client.request("model/list", {}),
    client.request("model/list", {}),
  ]);
  assert.deepEqual(left, { data: [] });
  assert.deepEqual(right, { data: [] });
  assert.equal(FakeWebSocket.instances.length, 2);
  client.stop();
});

test("intentional stop does not reconnect", async () => {
  const client = new CodexAppServer({
    websocketUrl: "ws://127.0.0.1:45789",
    reconnectDelaysMs: [0, 0],
    requestTimeoutMs: 1000,
  });
  await client.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  client.stop();
  await sleep(20);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("reconnect exhaustion emits closed only after all retries fail", async () => {
  FakeWebSocket.openPlan = [true, false, false];
  const client = new CodexAppServer({
    websocketUrl: "ws://127.0.0.1:45789",
    reconnectDelaysMs: [0, 0],
    requestTimeoutMs: 1000,
  });
  await client.start();
  let closedError;
  const closed = new Promise((resolve) => {
    client.once("closed", (error) => {
      closedError = error;
      resolve();
    });
  });
  FakeWebSocket.instances[0].serverClose();
  await closed;

  assert.equal(FakeWebSocket.instances.length, 3);
  assert.match(closedError.message, /reconnect exhausted/i);
});
