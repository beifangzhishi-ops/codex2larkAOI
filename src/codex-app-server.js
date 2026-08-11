import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export class CodexAppServer extends EventEmitter {
  constructor({ cwd, command = "codex", args = [], websocketUrl = "", requestTimeoutMs = 60_000 } = {}) {
    super();
    this.cwd = cwd;
    this.command = command;
    this.args = args;
    this.websocketUrl = String(websocketUrl || "").trim();
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.ws = null;
    this.startPromise = null;
  }

  async start() {
    if (this.child || this.ws) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    if (this.websocketUrl) {
      await this.#connectWebSocket();
    } else {
      await this.#startChild();
    }
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

  async #connectWebSocket() {
    const WS = globalThis.WebSocket;
    if (!WS) throw new Error("当前 Node.js 不支持全局 WebSocket，请升级到 Node 22+ 或安装 ws 依赖");
    const ws = new WS(this.websocketUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`websocket 连接超时: ${this.websocketUrl}`)), 15_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`websocket 连接失败: ${this.websocketUrl}`));
      };
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
    ws.onclose = () => this.#onClose(ws, new Error("codex app-server websocket closed"));
  }

  async request(method, params = {}, options = {}) {
    await this.start();
    return this.#requestRaw(method, params, options.timeoutMs);
  }

  #requestRaw(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.#canWrite()) return Promise.reject(new Error("codex app-server is not running"));
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
    const ws = this.ws;
    const child = this.child;
    if (!ws && !child) return;
    this.ws = null;
    this.child = null;
    const error = new Error("codex app-server stopped");
    this.#rejectPending(error);
    this.emit("closed", error);
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
    try { child.stdin.end(); } catch { /* process already closed */ }
    setTimeout(() => child.kill(), 2000).unref();
  }

  #write(message) {
    if (this.ws) {
      const OPEN = globalThis.WebSocket?.OPEN ?? 1;
      if (this.ws.readyState !== OPEN) throw new Error("codex app-server is not running");
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
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) this.emit("serverRequest", message);
    else if (message.method) this.emit("notification", message);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #onClose(child, error) {
    if (this.child !== child && this.ws !== child) return;
    this.ws = null;
    this.child = null;
    this.#rejectPending(error);
    this.emit("closed", error);
  }
}
