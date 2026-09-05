import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer } from "../src/codex-app-server.js";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  static handler = null;

  static reset() {
    this.instances = [];
    this.handler = null;
  }

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.id === undefined) return;
    const result = FakeWebSocket.handler?.(message, this) ?? defaultResult(message);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) });
    });
  }

  serverMessage(message) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket not open");
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.());
  }

  close() {
    this.serverClose();
  }
}

function defaultResult(message) {
  if (message.method === "initialize") return {};
  if (message.method === "thread/resume") {
    return { thread: { id: message.params.threadId, turns: [] } };
  }
  return {};
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

const originalWebSocket = globalThis.WebSocket;

test.beforeEach(() => {
  FakeWebSocket.reset();
  globalThis.WebSocket = FakeWebSocket;
});

test.after(() => {
  globalThis.WebSocket = originalWebSocket;
});

test("item/started before disconnect does not suppress recovered final item/completed", async () => {
  FakeWebSocket.handler = (message, ws) => {
    if (message.method !== "thread/resume") return defaultResult(message);
    const reconnect = FakeWebSocket.instances.indexOf(ws) > 0;
    return {
      thread: {
        id: "thread-a",
        turns: [{
          id: "turn-a",
          status: reconnect ? "completed" : "active",
          items: reconnect ? [{
            id: "agent-a",
            type: "agentMessage",
            phase: "final_answer",
            text: "最终结论",
          }] : [],
        }],
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

  await client.request("thread/resume", { threadId: "thread-a" });
  FakeWebSocket.instances[0].serverMessage({
    method: "item/started",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      item: { id: "agent-a", type: "agentMessage" },
    },
  });
  notifications.length = 0;

  const reconnected = once(client, "reconnected");
  FakeWebSocket.instances[0].serverClose();
  await reconnected;

  const completed = notifications.filter((message) => message.method === "item/completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].params.item.text, "最终结论");
  assert.equal(notifications.at(-1).method, "turn/completed");
  client.stop();
});

test("turn/completed snapshot synthesizes a missing final item before completion", async () => {
  const client = new CodexAppServer({
    websocketUrl: "ws://127.0.0.1:45789",
    reconnectDelaysMs: [0],
    requestTimeoutMs: 1000,
  });
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  await client.request("thread/resume", { threadId: "thread-b" });

  const ws = FakeWebSocket.instances[0];
  ws.serverMessage({
    method: "item/started",
    params: {
      threadId: "thread-b",
      turnId: "turn-b",
      item: { id: "agent-b", type: "agentMessage" },
    },
  });
  notifications.length = 0;

  ws.serverMessage({
    method: "turn/completed",
    params: {
      threadId: "thread-b",
      turn: {
        id: "turn-b",
        status: { type: "completed" },
        items: [{
          id: "agent-b",
          type: "agentMessage",
          phase: "final_answer",
          text: "terminal snapshot final",
        }],
      },
    },
  });

  assert.deepEqual(notifications.map((message) => message.method), [
    "item/completed",
    "turn/completed",
  ]);
  assert.equal(notifications[0].params.item.text, "terminal snapshot final");
  client.stop();
});

test("terminal turn reconciliation does not duplicate an already completed item", async () => {
  const client = new CodexAppServer({
    websocketUrl: "ws://127.0.0.1:45789",
    reconnectDelaysMs: [0],
    requestTimeoutMs: 1000,
  });
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  await client.request("thread/resume", { threadId: "thread-c" });

  const ws = FakeWebSocket.instances[0];
  const item = {
    id: "agent-c",
    type: "agentMessage",
    phase: "final_answer",
    text: "only once",
  };
  ws.serverMessage({
    method: "item/completed",
    params: { threadId: "thread-c", turnId: "turn-c", item },
  });
  ws.serverMessage({
    method: "turn/completed",
    params: {
      threadId: "thread-c",
      turn: { id: "turn-c", status: "completed", items: [item] },
    },
  });

  assert.equal(
    notifications.filter((message) => message.method === "item/completed").length,
    1,
  );
  assert.equal(
    notifications.filter((message) => message.method === "turn/completed").length,
    1,
  );
  client.stop();
});
