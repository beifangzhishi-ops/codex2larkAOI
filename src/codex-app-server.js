import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

const DEFAULT_RECONNECT_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000, 4_000]);

export class CodexAppServer extends EventEmitter {
  constructor({
    cwd,
    command = "codex",
    args = [],
    websocketUrl = "",
    requestTimeoutMs = 60_000,
    reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
  } = {}) {
    super();
    this.cwd = cwd;
    this.command = command;
    this.args = args;
    this.websocketUrl = String(websocketUrl || "").trim();
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectDelaysMs = Array.isArray(reconnectDelaysMs) && reconnectDelaysMs.length
      ? reconnectDelaysMs.map((value) => Math.max(0, Number(value) || 0))
      : [...DEFAULT_RECONNECT_DELAYS_MS];
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.ws = null;
    this.startPromise = null;
    this.reconnectPromise = null;
    this.stopping = false;

    // WebSocket subscriptions are connection-scoped. These records let us rejoin the
    // same threads after a transport reconnect without requiring a user /resume.
    this.subscriptions = new Map();

    // Track delivery stages separately. Seeing item/started must never suppress a later
    // item/completed replay: the completed item can contain the final answer.
    this.seenTurnStarts = new Set();
    this.seenTurnCompletions = new Set();
    this.seenItemCompletions = new Set();
  }

  async start() {
    if (this.#canWrite()) return;
    if (this.reconnectPromise) return this.reconnectPromise;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    if (this.websocketUrl) {
      await this.#connectAndInitialize();
      return;
    }
    await this.#startChild();
    await this.#initialize();
  }

  async #initialize() {
    await this.#requestRaw("initialize", {
      clientInfo: {
        name: "codex2lark",
        title: "Codex to Feishu Bridge",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  async #startChild() {
    const child = spawn(this.command, ["app-server", ...this.args], {
      cwd: this.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text && !text.includes("failed to clean up stale arg0")) this.emit("stderr", text);
    });
    child.once("error", (error) => this.#onClose(child, error));
    child.once("close", (code) => this.#onClose(child, new Error(`codex app-server exited ${code}`)));
  }

  async #connectAndInitialize() {
    const ws = await this.#connectWebSocket();
    try {
      await this.#initialize();
    } catch (error) {
      this.#dropWebSocket(ws, error, false);
      try { ws.close(); } catch { /* already closed */ }
      throw error;
    }
    if (this.ws === ws) {
      ws.onclose = () => this.#dropWebSocket(ws, new Error("codex app-server websocket closed"), true);
    }
  }

  async #connectWebSocket() {
    const WS = globalThis.WebSocket;
    if (!WS) throw new Error("当前 Node.js 不支持全局 WebSocket，请升级到 Node 22+ 或安装 ws 依赖");

    const ws = new WS(this.websocketUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`websocket 连接超时: ${this.websocketUrl}`));
      }, 15_000);

      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`websocket 连接失败: ${this.websocketUrl}`));
      };

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = fail;
      ws.onclose = fail;
    }).catch((error) => {
      if (this.ws === ws) this.ws = null;
      try { ws.close(); } catch { /* already closed */ }
      throw error;
    });

    ws.onmessage = (event) => {
      let data = event.data;
      if (typeof data !== "string") {
        try {
          data = Buffer.from(data).toString("utf8");
        } catch {
          return;
        }
      }
      this.#onLine(String(data));
    };
    ws.onerror = () => { /* close 事件会统一处理 */ };
    // During initialize a close must reject pending RPCs without starting a second loop.
    ws.onclose = () => this.#dropWebSocket(
      ws,
      new Error("codex app-server websocket closed during initialize"),
      false,
    );
    return ws;
  }

  async request(method, params = {}, options = {}) {
    await this.start();
    const result = await this.#requestRaw(method, params, options.timeoutMs);
    this.#rememberSubscription(method, params, result);
    return result;
  }

  #rememberSubscription(method, params, result) {
    let threadId = "";
    if (method === "thread/resume") {
      threadId = String(params?.threadId || "");
    } else if (method === "thread/start" && params?.serviceName === "codex2lark") {
      threadId = String(result?.thread?.id || "");
    }
    if (!threadId) return;

    const cwd = typeof params?.cwd === "string" && params.cwd ? params.cwd : "";
    this.subscriptions.set(threadId, { threadId, ...(cwd ? { cwd } : {}) });
    // The response snapshot is history already visible at subscription time.
    this.#markThreadSnapshotSeen(result?.thread);
  }

  #threadTurnKey(threadId, turnId) {
    return `${threadId}:${turnId}`;
  }

  #threadItemKey(threadId, turnId, itemId) {
    return `${threadId}:${turnId}:${itemId}`;
  }

  #turnStatus(turn) {
    if (typeof turn?.status === "string") return turn.status.toLowerCase();
    return String(turn?.status?.type || "").toLowerCase();
  }

  #isTerminalTurn(turn) {
    return ["completed", "failed", "interrupted", "cancelled", "canceled"].includes(
      this.#turnStatus(turn),
    );
  }

  #markThreadSnapshotSeen(thread) {
    const threadId = String(thread?.id || "");
    if (!threadId) return;
    for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
      const turnId = String(turn?.id || "");
      if (!turnId) continue;
      this.seenTurnStarts.add(this.#threadTurnKey(threadId, turnId));
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        const itemId = String(item?.id || "");
        if (itemId) {
          this.seenItemCompletions.add(this.#threadItemKey(threadId, turnId, itemId));
        }
      }
      if (this.#isTerminalTurn(turn)) {
        this.seenTurnCompletions.add(this.#threadTurnKey(threadId, turnId));
      }
    }
  }

  #rememberNotification(message) {
    const params = message?.params || {};
    const threadId = String(params.threadId || params.thread?.id || "");
    const turnId = String(params.turnId || params.turn?.id || "");
    if (!threadId || !turnId) return;

    const turnKey = this.#threadTurnKey(threadId, turnId);
    if (message.method === "turn/started") this.seenTurnStarts.add(turnKey);
    if (message.method === "turn/completed") {
      this.seenTurnStarts.add(turnKey);
      this.seenTurnCompletions.add(turnKey);
    }

    // Do not mark item/started here. A disconnect can happen after item/started but before
    // item/completed, and the latter is where the final answer can become available.
    if (message.method === "item/completed") {
      const itemId = String(params.item?.id || "");
      if (itemId) {
        this.seenItemCompletions.add(this.#threadItemKey(threadId, turnId, itemId));
      }
    }
  }

  #emitUnseenItemCompletion(threadId, turnId, item) {
    const itemId = String(item?.id || "");
    if (!threadId || !turnId || !itemId) return false;
    const itemKey = this.#threadItemKey(threadId, turnId, itemId);
    if (this.seenItemCompletions.has(itemKey)) return false;

    this.seenItemCompletions.add(itemKey);
    this.emit("notification", {
      method: "item/completed",
      params: { threadId, turnId, item },
    });
    return true;
  }

  #reconcileTerminalTurnItems(message) {
    if (message?.method !== "turn/completed") return;
    const params = message.params || {};
    const threadId = String(params.threadId || params.thread?.id || "");
    const turn = params.turn;
    const turnId = String(params.turnId || turn?.id || "");
    if (!threadId || !turnId) return;

    // A few app-server paths place the final item only in the terminal turn snapshot.
    // Synthesize only unseen item/completed notifications, before turn/completed.
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      this.#emitUnseenItemCompletion(threadId, turnId, item);
    }
  }

  #replayRecoveredThread(thread) {
    const threadId = String(thread?.id || "");
    if (!threadId) return;

    for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
      const turnId = String(turn?.id || "");
      if (!turnId) continue;
      const turnKey = this.#threadTurnKey(threadId, turnId);

      if (!this.seenTurnStarts.has(turnKey)) {
        this.seenTurnStarts.add(turnKey);
        this.emit("notification", {
          method: "turn/started",
          params: { threadId, turn },
        });
      }

      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        this.#emitUnseenItemCompletion(threadId, turnId, item);
      }

      if (this.#isTerminalTurn(turn) && !this.seenTurnCompletions.has(turnKey)) {
        this.seenTurnCompletions.add(turnKey);
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId, turn },
        });
      }
    }
  }

  async #recoverSubscriptions() {
    for (const [threadId, params] of [...this.subscriptions.entries()]) {
      if (this.stopping) return;
      try {
        const result = await this.#requestRaw("thread/resume", params);
        this.#replayRecoveredThread(result?.thread);
        this.emit("stderr", `[bridge] recovered app-server subscription thread=${threadId}`);
      } catch (error) {
        if (!this.#canWrite()) throw error;
        this.emit(
          "stderr",
          `[bridge] cannot recover app-server subscription thread=${threadId}: ${error.message}`,
        );
      }
    }
  }

  #requestRaw(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.#canWrite()) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ method, id, params });
    });
  }

  #canWrite() {
    if (this.ws) {
      const OPEN = globalThis.WebSocket?.OPEN ?? 1;
      return this.ws.readyState === OPEN;
    }
    return Boolean(this.child?.stdin?.writable);
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message) {
    this.#write({ id, error: { code, message } });
  }

  stop() {
    this.stopping = true;
    const ws = this.ws;
    const child = this.child;
    const hadTransport = Boolean(ws || child || this.reconnectPromise || this.startPromise);
    this.ws = null;
    this.child = null;

    const error = new Error("codex app-server stopped");
    this.#rejectPending(error);
    if (hadTransport) this.emit("closed", error);

    if (ws) {
      try {
        ws.close();
      } catch { /* already closed */ }
      try {
        const timer = setTimeout(() => {
          try {
            ws.terminate?.();
          } catch { /* already closed */ }
        }, 2000);
        timer.unref?.();
      } catch { /* ignore */ }
      return;
    }

    if (!child) return;
    try { child.stdin.end(); } catch { /* process already closed */ }
    setTimeout(() => child.kill(), 2000).unref();
  }

  #write(message) {
    if (this.ws) {
      const OPEN = globalThis.WebSocket?.OPEN ?? 1;
      if (this.ws.readyState !== OPEN) {
        throw new Error("codex app-server is not running");
      }
      this.ws.send(JSON.stringify(message));
      return;
    }

    if (!this.child?.stdin.writable) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("stderr", `[protocol] invalid JSON: ${line.slice(0, 500)}`);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      // Ensure the bridge receives any final item before it processes turn/completed.
      this.#reconcileTerminalTurnItems(message);
      this.#rememberNotification(message);
      this.emit("notification", message);
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #dropWebSocket(ws, error, reconnect) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.#rejectPending(error);
    if (reconnect && !this.stopping) this.#ensureReconnect(error);
  }

  #ensureReconnect(initialError) {
    if (!this.websocketUrl || this.stopping || this.reconnectPromise) {
      return this.reconnectPromise;
    }

    const reconnect = this.#reconnect(initialError);
    this.reconnectPromise = reconnect;
    void reconnect.catch(() => {});
    reconnect.then(
      () => {
        if (this.reconnectPromise === reconnect) this.reconnectPromise = null;
      },
      () => {
        if (this.reconnectPromise === reconnect) this.reconnectPromise = null;
      },
    );
    return reconnect;
  }

  async #reconnect(initialError) {
    let lastError = initialError;
    this.emit("stderr", `[bridge] app-server disconnected: ${initialError.message}`);

    for (let index = 0; index < this.reconnectDelaysMs.length; index += 1) {
      if (this.stopping) return;
      const delayMs = this.reconnectDelaysMs[index];
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (this.stopping) return;

      this.emit("stderr", `[bridge] app-server reconnect attempt ${index + 1}`);
      try {
        await this.#connectAndInitialize();
        await this.#recoverSubscriptions();
        this.emit("stderr", "[bridge] app-server reconnected");
        this.emit("reconnected");
        return;
      } catch (error) {
        lastError = error;
        const ws = this.ws;
        if (ws) {
          this.#dropWebSocket(ws, error, false);
          try { ws.close(); } catch { /* already closed */ }
        }
      }
    }

    if (this.stopping) return;
    const error = new Error(
      `codex app-server websocket reconnect exhausted: ${lastError?.message || initialError.message}`,
    );
    this.emit("stderr", `[bridge] app-server reconnect exhausted: ${error.message}`);
    this.emit("closed", error);
    throw error;
  }

  #onClose(child, error) {
    if (this.child !== child && this.ws !== child) return;
    this.ws = null;
    this.child = null;
    this.#rejectPending(error);
    this.emit("closed", error);
  }
}
