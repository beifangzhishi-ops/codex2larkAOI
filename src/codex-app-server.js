import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export class CodexAppServer extends EventEmitter {
  constructor({ cwd, command = "codex", args = [], requestTimeoutMs = 60_000 } = {}) {
    super();
    this.cwd = cwd;
    this.command = command;
    this.args = args;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.startPromise = null;
  }

  async start() {
    if (this.child) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
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

  async request(method, params = {}, options = {}) {
    await this.start();
    return this.#requestRaw(method, params, options.timeoutMs);
  }

  #requestRaw(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("codex app-server is not running"));
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
    const child = this.child;
    if (!child) return;
    this.child = null;
    const error = new Error("codex app-server stopped");
    this.#rejectPending(error);
    this.emit("closed", error);
    try { child.stdin.end(); } catch { /* process already closed */ }
    setTimeout(() => child.kill(), 2000).unref();
  }

  #write(message) {
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
    if (this.child !== child) return;
    this.child = null;
    this.#rejectPending(error);
    this.emit("closed", error);
  }
}
