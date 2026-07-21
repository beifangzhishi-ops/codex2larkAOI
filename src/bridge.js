import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-app-server.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const STATE_DIR = resolve(ROOT, ".state");
const STATE_FILE = resolve(STATE_DIR, "sessions.json");
const PID_FILE = resolve(STATE_DIR, "bridge.pid");
const STOP_FILE = resolve(STATE_DIR, "stop-requested");

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export function splitReply(text, maxChars) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ["Codex 未返回文本结果。"];
}

export function watchForStopRequest(stopFile, onStop, intervalMs = 250) {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || !existsSync(stopFile)) return;
    stopped = true;
    clearInterval(timer);
    onStop();
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function normalizeTextContent(content) {
  const text = String(content ?? "").trim();
  if (!text.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.text === "string" ? parsed.text.trim() : text;
  } catch {
    return text;
  }
}

export function normalizeEvent(value) {
  const event = value?.event ?? value;
  return {
    eventId: String(event?.event_id ?? ""),
    messageId: String(event?.message_id ?? event?.id ?? ""),
    chatId: String(event?.chat_id ?? ""),
    chatType: String(event?.chat_type ?? ""),
    senderId: String(event?.sender_id ?? ""),
    messageType: String(event?.message_type ?? ""),
    content: normalizeTextContent(event?.content),
  };
}

export function parseControlCommand(text) {
  const value = text.trim();
  const lower = value.toLowerCase();
  if (lower === "/stop" || value === "停止当前操作" || value === "停止执行") return { type: "stop" };
  if (/^\/(?:approval|mode)\s+(?:auto|automatic)$/i.test(value) ||
      (value.length <= 40 && /(?:切换|改成|改为|设为|使用|开启).{0,8}自动审批/.test(value))) {
    return { type: "approvalMode", mode: "auto" };
  }
  if (/^\/(?:approval|mode)\s+manual$/i.test(value) ||
      (value.length <= 40 && /(?:切换|改成|改为|设为|使用|开启).{0,8}手动审批/.test(value))) {
    return { type: "approvalMode", mode: "manual" };
  }
  if (/^\/approve(?:\s+(?:session|always))?$/i.test(value) ||
      /^(?:批准|同意执行|允许一次|本次同意)$/.test(value)) {
    return { type: "approve", session: /session|always/i.test(value) };
  }
  if (/^(?:\/deny|\/reject)$/i.test(value) || /^(?:拒绝|不同意|拒绝执行)$/.test(value)) {
    return { type: "deny" };
  }
  if (lower === "/new") return { type: "new" };
  if (lower === "/status") return { type: "status" };
  if (lower === "/help") return { type: "help" };
  const cd = value.match(/^\/cd(?:\s+(.+))?$/i) ||
    (value.length <= 120 ? value.match(/^(?:切换|进入|转到)(?:到|至)?\s*(.+?)(?:项目|目录)?$/) : null);
  if (cd) return { type: "cd", query: (cd[1] || "").trim() };
  return null;
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveWorkdirQuery(query, rootDir) {
  const root = resolve(rootDir);
  const trimmed = query.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return { error: "请提供项目名或目录路径。" };
  const candidate = resolve(isAbsolute(trimmed) ? trimmed : resolve(root, trimmed));
  if (isInside(root, candidate) && existsSync(candidate) && statSync(candidate).isDirectory()) {
    return { path: candidate };
  }

  const needle = trimmed.toLocaleLowerCase();
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const exact = directories.find((name) => name.toLocaleLowerCase() === needle);
  if (exact) return { path: resolve(root, exact) };
  const matches = directories.filter((name) => {
    const normalized = name.toLocaleLowerCase();
    return normalized.includes(needle) || needle.includes(normalized);
  });
  if (matches.length === 1) return { path: resolve(root, matches[0]) };
  if (matches.length > 1) return { error: `匹配到多个项目：${matches.join("、")}` };
  return { error: `在 ${root} 的第一层目录中找不到“${trimmed}”。` };
}

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function localMarkdownPath(target, cwd) {
  let value = String(target || "").trim();
  try { value = decodeURIComponent(value); } catch { /* keep the original target */ }
  try {
    if (/^file:\/\//i.test(value)) value = fileURLToPath(value);
  } catch { return ""; }
  if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
  const candidate = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  try {
    return existsSync(candidate) && statSync(candidate).isFile() ? candidate : "";
  } catch {
    return "";
  }
}

export function extractFileDirectives(text, { cwd = ROOT } = {}) {
  const files = [];
  const seen = new Set();
  const addFile = (kind, path) => {
    const key = `${kind}\0${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ kind, path });
  };
  const pattern = /^\s*(FILE|MEDIA):\s*(?:"([^"]+)"|'([^']+)'|(.+?))\s*$/gim;
  let cleaned = text.replace(pattern, (_match, kind, doubleQuoted, singleQuoted, bare) => {
    let path = String(doubleQuoted || singleQuoted || bare || "").trim();
    if (path.startsWith("`") && path.endsWith("`")) path = path.slice(1, -1).trim();
    addFile(kind.toUpperCase(), path);
    return "";
  });

  // Codex often renders a local deliverable as a clickable link. Treat only links
  // whose targets resolve to real local files as attachments; web links stay intact.
  const markdownLink = /\[([^\]\r\n]+)\]\(\s*<?([^)>\r\n]+)>?\s*\)/g;
  cleaned = cleaned.replace(markdownLink, (match, _label, target) => {
    const path = localMarkdownPath(target, cwd);
    if (!path) return match;
    addFile(IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) ? "MEDIA" : "FILE", path);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, files };
}

function summaryText(summary) {
  if (typeof summary === "string") return summary.trim();
  if (!Array.isArray(summary)) return "";
  return summary.map((part) => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n").trim();
}

function fenced(value) {
  return String(value ?? "").replace(/```/g, "` ` `");
}

export function formatThreadItem(item, stage = "completed") {
  if (!item) return "";
  if (item.type === "agentMessage" && item.phase === "commentary" && stage === "completed") return item.text?.trim() || "";
  if (item.type === "reasoning" && stage === "completed") {
    const text = summaryText(item.summary);
    return text ? `🧠 ${text}` : "";
  }
  return "";
}

function loadEnv() {
  const envPath = resolve(ROOT, ".env");
  const fileValues = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
  return { ...fileValues, ...process.env };
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function commandSpec(name, args) {
  if (process.platform === "win32" && name === "lark-cli") {
    const entry = resolve(process.env.APPDATA || "", "npm", "node_modules", "@larksuite", "cli", "scripts", "run.js");
    if (!existsSync(entry)) throw new Error(`找不到 lark-cli JavaScript 入口: ${entry}`);
    return { command: process.execPath, args: [entry, ...args] };
  }
  return { command: commandName(name), args };
}

function run(command, args, { input, cwd = ROOT, timeoutMs = 60_000, onStdoutLine, onStderrLine } = {}) {
  return new Promise((resolveRun, reject) => {
    const spec = commandSpec(command, args);
    const child = spawn(spec.command, spec.args, {
      cwd, env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    const feed = (chunk, isStdout) => {
      const text = chunk.toString("utf8");
      if (isStdout) stdout += text;
      else stderr += text;
      const lines = ((isStdout ? stdoutBuffer : stderrBuffer) + text).split(/\r?\n/);
      if (isStdout) stdoutBuffer = lines.pop();
      else stderrBuffer = lines.pop();
      const callback = isStdout ? onStdoutLine : onStderrLine;
      for (const line of lines) callback?.(line);
    };
    child.stdout.on("data", (chunk) => feed(chunk, true));
    child.stderr.on("data", (chunk) => feed(chunk, false));
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (stdoutBuffer) onStdoutLine?.(stdoutBuffer);
      if (stderrBuffer) onStderrLine?.(stderrBuffer);
      if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs} ms`));
      else if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolveRun({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function loadState() {
  try {
    const value = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
      workdirs: value.workdirs && typeof value.workdirs === "object" ? value.workdirs : {},
      approvalModes: value.approvalModes && typeof value.approvalModes === "object" ? value.approvalModes : {},
      events: Array.isArray(value.events) ? value.events : [],
    };
  } catch {
    return { sessions: {}, workdirs: {}, approvalModes: {}, events: [] };
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const temp = `${STATE_FILE}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temp, STATE_FILE);
}

function acquirePidFile() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(PID_FILE)) {
    const previousPid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (previousPid) {
      try {
        process.kill(previousPid, 0);
        throw new Error(`桥接服务已在运行，PID=${previousPid}`);
      } catch (error) {
        if (error.message?.startsWith("桥接服务已在运行")) throw error;
      }
    }
  }
  if (existsSync(STOP_FILE)) unlinkSync(STOP_FILE);
  writeFileSync(PID_FILE, `${process.pid}\n`, "utf8");
  process.once("exit", () => {
    try { unlinkSync(PID_FILE); } catch { /* already removed */ }
  });
}

export function buildConfig(env) {
  const allowedIds = new Set((env.FEISHU_ALLOWED_OPEN_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
  if (!allowedIds.size || allowedIds.has("*") || [...allowedIds].some((id) => !id.startsWith("ou_"))) {
    throw new Error("FEISHU_ALLOWED_OPEN_IDS 必须是一个或多个明确的 ou_xxx，且不允许通配符。");
  }
  const rootDir = resolve(env.CODEX_WORKDIR || ROOT);
  if (!existsSync(rootDir)) throw new Error(`CODEX_WORKDIR 不存在: ${rootDir}`);
  const defaultApprovalMode = String(env.CODEX_APPROVAL_MODE || "auto").toLowerCase();
  if (!["auto", "manual"].includes(defaultApprovalMode)) throw new Error("CODEX_APPROVAL_MODE 只能是 auto 或 manual。");
  return {
    allowedIds,
    rootDir,
    allowGroups: String(env.FEISHU_ALLOW_GROUPS).toLowerCase() === "true",
    model: env.CODEX_MODEL?.trim() || "",
    defaultApprovalMode,
    timeoutMs: Number(env.CODEX_TIMEOUT_MS) || 1_800_000,
    replyChars: Math.min(Math.max(Number(env.FEISHU_REPLY_CHARS) || 3500, 500), 8000),
    eventCacheSize: Math.min(Math.max(Number(env.EVENT_CACHE_SIZE) || 1000, 100), 10_000),
    projectInstructions: existsSync(resolve(ROOT, "AGENTS.md")) ? readFileSync(resolve(ROOT, "AGENTS.md"), "utf8") : "",
  };
}

async function preflight() {
  await run("codex", ["app-server", "--help"]);
  const { stdout } = await run("lark-cli", ["auth", "status"]);
  const status = JSON.parse(stdout);
  if (!status.identities?.bot?.available) throw new Error("lark-cli bot 身份尚未就绪。");
}

export function idempotencyKey(...values) {
  return `c2l-${createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 40)}`;
}

export function isMarkdownValidationError(error) {
  return /99992402|field validation failed|content format of the post type is incorrect/i.test(String(error?.message || error));
}

export async function sendReply(messageId, eventKey, text, config) {
  const chunks = splitReply(text, config.replyChars);
  for (let index = 0; index < chunks.length; index += 1) {
    const key = idempotencyKey(eventKey, index);
    const common = [
      "im", "+messages-reply", "--as", "bot", "--message-id", messageId,
    ];
    try {
      await run("lark-cli", [...common, "--markdown", chunks[index], "--idempotency-key", key]);
    } catch (error) {
      if (!isMarkdownValidationError(error)) throw error;
      console.warn(`[bridge] markdown rejected for ${messageId}; retrying as plain text`);
      await run("lark-cli", [...common, "--text", chunks[index], "--idempotency-key", `${key}-text`]);
    }
  }
}

async function sendAttachment(event, directive, config, index) {
  const path = resolve(directive.path);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`文件不存在：${path}`);
  if (statSync(path).size < 1) throw new Error(`文件为空：${path}`);
  const mediaFlag = directive.kind === "MEDIA" ? "--image" : "--file";
  await run("lark-cli", [
    "im", "+messages-reply", "--as", "bot", "--message-id", event.messageId,
    mediaFlag, `.\\${basename(path)}`, "--idempotency-key", idempotencyKey(event.eventId, "file", index, path),
  ], { cwd: dirname(path), timeoutMs: 120_000 });
}

function approvalPolicy(mode) {
  return mode === "manual" ? "on-request" : "never";
}

function turnSandbox(cwd) {
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
  };
}

class BridgeRuntime {
  constructor(state, config) {
    this.state = state;
    this.config = config;
    this.client = new CodexAppServer({ cwd: ROOT });
    this.loadedThreads = new Set();
    this.activeChats = new Map();
    this.activeThreads = new Map();
    this.pendingApprovals = new Map();
    this.chatQueues = new Map();
    this.client.on("stderr", (text) => console.error(`[codex] ${text}`));
    this.client.on("notification", (message) => this.#onNotification(message));
    this.client.on("serverRequest", (message) => this.#onServerRequest(message));
    this.client.on("closed", (error) => this.#onClientClosed(error));
  }

  async start() {
    await this.client.start();
  }

  stop() {
    this.client.stop();
  }

  modeFor(chatId) {
    return this.state.approvalModes[chatId] || this.config.defaultApprovalMode;
  }

  cwdFor(chatId) {
    const stored = this.state.workdirs[chatId];
    return stored && isInside(this.config.rootDir, resolve(stored)) && existsSync(stored)
      ? resolve(stored) : this.config.rootDir;
  }

  enqueue(event, command) {
    const previous = this.chatQueues.get(event.chatId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.#processQueued(event, command));
    this.chatQueues.set(event.chatId, next);
    const cleanup = () => {
      if (this.chatQueues.get(event.chatId) === next) this.chatQueues.delete(event.chatId);
    };
    next.then(cleanup, (error) => {
      console.error(`[bridge] chat ${event.chatId} event ${event.eventId} failed: ${error.stack || error}`);
      cleanup();
    });
  }

  async handleImmediate(event, command) {
    if (command.type === "stop") {
      const active = this.activeChats.get(event.chatId);
      if (!active?.turnId) {
        await sendReply(event.messageId, `${event.eventId}-stop`, "当前没有正在执行的操作。", this.config);
        return;
      }
      await this.client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
      await sendReply(event.messageId, `${event.eventId}-stop`, "已请求停止当前操作。", this.config);
      return;
    }
    if (command.type === "approvalMode") {
      this.state.approvalModes[event.chatId] = command.mode;
      saveState(this.state);
      if (command.mode === "auto") await this.#resolvePending(event.chatId, "acceptForSession");
      await sendReply(event.messageId, `${event.eventId}-mode`,
        `已切换为${command.mode === "auto" ? "自动" : "手动"}审批。该设置从当前待审批项和后续操作开始生效。`, this.config);
      return;
    }
    if (command.type === "approve" || command.type === "deny") {
      const decision = command.type === "deny" ? "decline" : command.session ? "acceptForSession" : "accept";
      const resolved = await this.#resolvePending(event.chatId, decision, true);
      await sendReply(event.messageId, `${event.eventId}-approval`,
        resolved ? `已${command.type === "deny" ? "拒绝" : "批准"}待处理操作。` : "当前没有待审批操作。", this.config);
    }
  }

  async #processQueued(event, command) {
    if (command?.type === "new") {
      delete this.state.sessions[event.chatId];
      saveState(this.state);
      await sendReply(event.messageId, `${event.eventId}-new`, "已新建 Codex 会话；当前项目目录保持不变。", this.config);
      return;
    }
    if (command?.type === "status") {
      await sendReply(event.messageId, `${event.eventId}-status`,
        `桥接服务正常。\n\n工作目录：${this.cwdFor(event.chatId)}\n会话：${this.state.sessions[event.chatId] || "尚未创建"}\n审批：${this.modeFor(event.chatId) === "auto" ? "自动" : "手动"}\n权限：全盘读取、当前项目目录写入`, this.config);
      return;
    }
    if (command?.type === "help") {
      await sendReply(event.messageId, `${event.eventId}-help`,
        "直接发送任务即可。\n\n`/cd 项目名` 切换工作目录\n`/new` 新建会话\n`/stop` 停止当前操作\n`/approval auto|manual` 切换审批模式\n`/approve [session]` 批准待处理操作\n`/deny` 拒绝待处理操作\n`/status` 查看状态", this.config);
      return;
    }
    if (command?.type === "cd") {
      const result = resolveWorkdirQuery(command.query, this.config.rootDir);
      if (result.error) {
        await sendReply(event.messageId, `${event.eventId}-cd`, result.error, this.config);
        return;
      }
      this.state.workdirs[event.chatId] = result.path;
      saveState(this.state);
      await sendReply(event.messageId, `${event.eventId}-cd`, `已切换工作目录：${result.path}\n后续轮次会在该目录执行，会话上下文保留。`, this.config);
      return;
    }

    const directFiles = extractFileDirectives(event.content, { cwd: this.cwdFor(event.chatId) });
    if (directFiles.files.length && !directFiles.text) {
      await this.#deliverFiles(event, directFiles.files);
      return;
    }

    try {
      const answer = await this.#runTurn(event);
      const delivery = extractFileDirectives(answer || "", { cwd: this.cwdFor(event.chatId) });
      if (delivery.text) await sendReply(event.messageId, `${event.eventId}-final`, delivery.text, this.config);
      else if (!delivery.files.length) await sendReply(event.messageId, `${event.eventId}-final`, "Codex 未返回文本结果。", this.config);
      await this.#deliverFiles(event, delivery.files);
    } catch (error) {
      console.error(error);
      await sendReply(event.messageId, `${event.eventId}-error`, `Codex 执行失败：${String(error.message || error).slice(0, 2000)}`, this.config);
    }
  }

  async #deliverFiles(event, files) {
    for (let index = 0; index < files.length; index += 1) {
      try {
        await sendAttachment(event, files[index], this.config, index);
      } catch (error) {
        await sendReply(event.messageId, `${event.eventId}-file-error-${index}`,
          `文件发送失败：${String(error.message || error).slice(0, 1500)}`, this.config);
      }
    }
  }

  async #ensureThread(chatId, cwd, mode) {
    let threadId = this.state.sessions[chatId];
    const common = {
      cwd,
      approvalPolicy: approvalPolicy(mode),
      sandbox: "workspace-write",
      developerInstructions: this.config.projectInstructions || null,
      ...(this.config.model ? { model: this.config.model } : {}),
    };
    if (threadId && !this.loadedThreads.has(threadId)) {
      try {
        await this.client.request("thread/resume", { threadId, ...common });
        this.loadedThreads.add(threadId);
      } catch (error) {
        console.warn(`[codex] cannot resume ${threadId}: ${error.message}; starting a new thread`);
        threadId = "";
      }
    }
    if (!threadId) {
      const result = await this.client.request("thread/start", { ...common, serviceName: "codex2lark" });
      threadId = result.thread.id;
      this.state.sessions[chatId] = threadId;
      this.loadedThreads.add(threadId);
      saveState(this.state);
    }
    return threadId;
  }

  async #runTurn(event) {
    const cwd = this.cwdFor(event.chatId);
    const mode = this.modeFor(event.chatId);
    const threadId = await this.#ensureThread(event.chatId, cwd, mode);
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolvePromise, rejectPromise) => {
      resolveDone = resolvePromise;
      rejectDone = rejectPromise;
    });
    const active = {
      chatId: event.chatId, threadId, turnId: "", event,
      finalMessages: [], progressKeys: new Set(), sendQueue: Promise.resolve(), resolveDone, rejectDone,
    };
    this.activeChats.set(event.chatId, active);
    this.activeThreads.set(threadId, active);

    try {
      const result = await this.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: event.content }],
        cwd,
        approvalPolicy: approvalPolicy(mode),
        sandboxPolicy: turnSandbox(cwd),
        ...(this.config.model ? { model: this.config.model } : {}),
      });
      active.turnId = result.turn.id;
      const timeout = setTimeout(() => rejectDone(new Error(`Codex turn timed out after ${this.config.timeoutMs} ms`)), this.config.timeoutMs);
      try {
        const completion = await done;
        if (completion.status === "failed") throw new Error(completion.error?.message || "Codex turn failed");
        if (completion.status === "interrupted" && !active.finalMessages.length) active.finalMessages.push("操作已停止。");
      } catch (error) {
        if (active.turnId) {
          try { await this.client.request("turn/interrupt", { threadId, turnId: active.turnId }); } catch { /* already finished */ }
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      await active.sendQueue;
      return active.finalMessages.join("\n\n").trim();
    } finally {
      this.activeChats.delete(event.chatId);
      this.activeThreads.delete(threadId);
      await this.#clearPendingForTurn(event.chatId, active.turnId);
    }
  }

  #queueProgress(active, key, text) {
    if (!text || active.progressKeys.has(key)) return;
    active.progressKeys.add(key);
    active.sendQueue = active.sendQueue
      .then(() => sendReply(active.event.messageId, `${active.event.eventId}-${key}`, text, this.config))
      .catch((error) => console.error(`[bridge] progress reply failed: ${error.message}`));
  }

  #onNotification(message) {
    const params = message.params || {};
    const active = this.activeThreads.get(params.threadId || params.thread?.id);
    if (!active) return;
    if (message.method === "turn/started" && params.turn?.id) active.turnId = params.turn.id;
    if (message.method === "item/started") {
      const text = formatThreadItem(params.item, "started");
      this.#queueProgress(active, `item-start-${params.item?.id}`, text);
    }
    if (message.method === "item/completed") {
      const item = params.item;
      if (item?.type === "agentMessage" && item.phase !== "commentary" && item.text?.trim()) {
        active.finalMessages.push(item.text.trim());
      } else {
        const text = formatThreadItem(item, "completed");
        this.#queueProgress(active, `item-complete-${item?.id}`, text);
      }
    }
    if (message.method === "turn/completed") active.resolveDone(params.turn || { status: "completed" });
    if (message.method === "error") active.rejectDone(new Error(params.error?.message || "Codex app-server error"));
  }

  #onServerRequest(message) {
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
      this.client.respondError(message.id, -32601, `Unsupported server request: ${message.method}`);
      return;
    }
    const params = message.params || {};
    const active = this.activeThreads.get(params.threadId);
    if (!active) {
      this.client.respond(message.id, { decision: "cancel" });
      return;
    }
    if (this.modeFor(active.chatId) === "auto") {
      this.client.respond(message.id, { decision: "acceptForSession" });
      return;
    }
    const pending = this.pendingApprovals.get(active.chatId) || [];
    pending.push({ requestId: message.id, method: message.method, params });
    this.pendingApprovals.set(active.chatId, pending);
    const subject = message.method.includes("commandExecution")
      ? `💻 terminal\n\n\`\`\`powershell\n${fenced(params.command || "命令未提供")}\n\`\`\``
      : `📝 file change\n${params.reason || params.grantRoot || "Codex 请求修改文件"}`;
    this.#queueProgress(active, `approval-${message.id}`,
      `⚠️ 需要审批\n\n${subject}\n\n发送 \`/approve\` 允许一次，\`/approve session\` 本会话允许，或 \`/deny\` 拒绝。`);
  }

  async #resolvePending(chatId, decision, oneOnly = false) {
    const pending = this.pendingApprovals.get(chatId) || [];
    if (!pending.length) return false;
    const selected = oneOnly ? pending.splice(0, 1) : pending.splice(0);
    for (const approval of selected) this.client.respond(approval.requestId, { decision });
    if (pending.length) this.pendingApprovals.set(chatId, pending);
    else this.pendingApprovals.delete(chatId);
    return true;
  }

  async #clearPendingForTurn(chatId, turnId) {
    const pending = this.pendingApprovals.get(chatId) || [];
    const remaining = [];
    for (const approval of pending) {
      if (approval.params.turnId === turnId) {
        try { this.client.respond(approval.requestId, { decision: "cancel" }); } catch { /* request already resolved */ }
      } else remaining.push(approval);
    }
    if (remaining.length) this.pendingApprovals.set(chatId, remaining);
    else this.pendingApprovals.delete(chatId);
  }

  #onClientClosed(error) {
    this.loadedThreads.clear();
    for (const active of this.activeChats.values()) active.rejectDone(error);
  }
}

async function acceptEvent(raw, runtime, state, config) {
  const event = normalizeEvent(raw);
  if (!event.eventId || !event.messageId || !event.chatId) return;
  if (state.events.includes(event.eventId)) return;
  state.events.push(event.eventId);
  state.events = state.events.slice(-config.eventCacheSize);
  saveState(state);
  if (!config.allowedIds.has(event.senderId)) {
    console.warn(`[bridge] ignored sender ${event.senderId || "<missing>"}`);
    return;
  }
  if (event.chatType === "group" && !config.allowGroups) return;
  if (event.messageType !== "text" || !event.content) {
    await sendReply(event.messageId, `${event.eventId}-unsupported`, "目前仅支持文字消息；Codex 生成的文件可以由桥接发送。", config);
    return;
  }
  const command = parseControlCommand(event.content);
  console.log(`[bridge] received event=${event.eventId} chat=${event.chatId} command=${command?.type || "turn"}`);
  if (["stop", "approvalMode", "approve", "deny"].includes(command?.type)) {
    await runtime.handleImmediate(event, command);
  } else runtime.enqueue(event, command);
}

function startConsumer(state, config, runtime) {
  let retryMs = 1000;
  let stopping = false;
  let child;
  let stopWatching;
  const start = () => {
    let stdoutBuffer = "";
    const spec = commandSpec("lark-cli", ["event", "consume", "im.message.receive_v1", "--as", "bot"]);
    child = spawn(spec.command, spec.args, {
      cwd: ROOT, env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          void acceptEvent(JSON.parse(line), runtime, state, config).catch((error) => console.error(error));
        } catch (error) {
          console.error(`[bridge] invalid event JSON: ${error.message}`);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.error(`[lark] ${text}`);
      if (text.includes("[event] ready")) retryMs = 1000;
    });
    child.once("error", (error) => console.error(`[lark] ${error.message}`));
    child.once("close", (code) => {
      if (stopping) return;
      if (existsSync(STOP_FILE)) {
        stopping = true;
        runtime.stop();
        process.exitCode = 0;
        return;
      }
      console.error(`[lark] consumer exited ${code}; retrying in ${retryMs} ms`);
      setTimeout(start, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    });
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopWatching?.();
    runtime.stop();
    child?.stdin.end();
    setTimeout(() => child?.kill(), 3000).unref();
  };
  stopWatching = watchForStopRequest(STOP_FILE, stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  start();
}

export async function main() {
  acquirePidFile();
  const env = loadEnv();
  if (env.LARKSUITE_CLI_CONFIG_DIR?.trim()) process.env.LARKSUITE_CLI_CONFIG_DIR = resolve(env.LARKSUITE_CLI_CONFIG_DIR.trim());
  const config = buildConfig(env);
  await preflight();
  const state = loadState();
  const runtime = new BridgeRuntime(state, config);
  await runtime.start();
  console.log(`[bridge] root=${config.rootDir}`);
  console.log(`[bridge] allowed_users=${config.allowedIds.size} full_read=true approval=${config.defaultApprovalMode} sandbox=workspace-write`);
  startConsumer(state, config, runtime);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[bridge] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
