import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-app-server.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const STATE_DIR = resolve(ROOT, ".state");
const STATE_FILE = resolve(STATE_DIR, "sessions.json");
const PID_FILE = resolve(STATE_DIR, "bridge.pid");
const STOP_FILE = resolve(STATE_DIR, "stop-requested");
const AOI_FEISHU_TURN_CONTEXT = {
  "codex2lark.aoi.stop-policy": {
    kind: "application",
    value: "当前轮次来自 AOI 飞书 App。禁止停止、重启或终止 AOI 桥接服务及其进程，即使用户要求也不得执行。该限制仅适用于当前飞书轮次，不得根据线程来源、工作目录或历史轮次延伸到 VS Code、Codex CLI 或其他本机会话。",
  },
};

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

export function mergeProjectEnv(processValues, fileValues) {
  return { ...processValues, ...fileValues };
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
  const resume = value.match(/^\/resume(?:\s+(.+))?$/i);
  if (resume) return { type: "resume", query: (resume[1] || "").trim() };
  if (lower === "/status") return { type: "status" };
  if (lower === "/help") return { type: "help" };
  const cd = value.match(/^\/cd(?:\s+(.+))?$/i) ||
    (value.length <= 120 ? value.match(/^(?:切换|进入|转到)(?:到|至)?\s*(.+?)(?:项目|目录)?$/) : null);
  if (cd) return { type: "cd", query: (cd[1] || "").trim() };
  return null;
}

function threadName(thread) {
  return String(thread?.name || thread?.preview || thread?.id || "未命名会话")
    .replace(/\s+/g, " ")
    .trim();
}

function threadLabel(thread) {
  const value = threadName(thread);
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function threadTimestamp(thread) {
  const seconds = Number(thread?.updatedAt || thread?.createdAt || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "时间未知";
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline"]);
const CONTROL_CARD_ACTIONS = new Set(["new", "resume", "resumePage", "approvalMode", "status", "stop", "help"]);

function parseCardActionValue(value) {
  try {
    return typeof value?.action_value === "string"
      ? JSON.parse(value.action_value)
      : value?.action_value;
  } catch {
    return null;
  }
}

export function parseApprovalCardAction(value) {
  const actionValue = parseCardActionValue(value);
  if (value?.action_tag !== "button" || actionValue?.kind !== "codex2lark_approval" ||
      typeof actionValue.approvalId !== "string" || !APPROVAL_DECISIONS.has(actionValue.decision)) return null;
  return {
    eventId: String(value.event_id || ""),
    chatId: String(value.chat_id || ""),
    messageId: String(value.message_id || ""),
    operatorId: String(value.operator_id || ""),
    token: String(value.token || ""),
    approvalId: actionValue.approvalId,
    decision: actionValue.decision,
  };
}

export function parseControlCardAction(value) {
  const actionValue = parseCardActionValue(value);
  if (value?.action_tag !== "button" || actionValue?.kind !== "codex2lark_control" ||
      !CONTROL_CARD_ACTIONS.has(actionValue.action)) return null;
  if (actionValue.action === "approvalMode" && !["auto", "manual"].includes(actionValue.mode)) return null;
  if (actionValue.action === "resume" && actionValue.threadId !== undefined &&
      typeof actionValue.threadId !== "string") return null;
  if (actionValue.action === "resumePage" &&
      (!Number.isInteger(actionValue.pageStart) || actionValue.pageStart < 0)) return null;
  return {
    type: "control",
    eventId: String(value.event_id || ""),
    chatId: String(value.chat_id || ""),
    messageId: String(value.message_id || ""),
    operatorId: String(value.operator_id || ""),
    token: String(value.token || ""),
    action: actionValue.action,
    ...(actionValue.mode ? { mode: actionValue.mode } : {}),
    ...(actionValue.threadId !== undefined ? { threadId: actionValue.threadId } : {}),
    ...(actionValue.pageStart !== undefined ? { pageStart: actionValue.pageStart } : {}),
  };
}

export function parseCardAction(value) {
  const approval = parseApprovalCardAction(value);
  return approval ? { type: "approval", ...approval } : parseControlCardAction(value);
}

function threadCwd(thread) {
  return String(thread?.cwd || "目录未知").trim() || "目录未知";
}

function threadCwdLabel(thread) {
  const cwd = threadCwd(thread);
  return cwd === "目录未知" ? cwd : basename(cwd);
}

function availableThreadCwd(thread) {
  const cwd = threadCwd(thread);
  if (cwd === "目录未知") return "";
  try {
    return existsSync(cwd) && statSync(cwd).isDirectory() ? resolve(cwd) : "";
  } catch {
    return "";
  }
}

export function createThreadTitle(text, maxChars = 48) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "新会话";
  const chars = Array.from(normalized);
  const punctuation = chars.findIndex((char) => "。！？!?".includes(char));
  const summary = punctuation >= 5 && punctuation < maxChars ? chars.slice(0, punctuation + 1) : chars;
  if (summary.length <= maxChars) return summary.join("");
  return `${summary.slice(0, Math.max(1, maxChars - 3)).join("")}...`;
}

export function formatResumeThreads(threads, currentThreadId = "", hasMore = false) {
  if (!threads.length) return "没有可恢复的历史会话。";
  const rows = threads.map((thread, index) => {
    const current = thread.id === currentThreadId ? " [当前]" : "";
    return `${index + 1}. ${threadLabel(thread)}${current}\n   ${threadTimestamp(thread)} | ${threadCwdLabel(thread)}`;
  });
  const next = hasMore ? "\n发送 `/resume next` 再看 5 个。" : "";
  return `历史会话：\n\n${rows.join("\n")}\n\n发送 \`/resume 编号\` 或 \`/resume 标题\` 继续。${next}`;
}

export function selectResumeThread(threads, query) {
  const value = String(query || "").trim();
  if (!value) return { error: "请选择要恢复的会话。" };
  if (/^\d+$/.test(value)) {
    const thread = threads[Number(value) - 1];
    return thread ? { thread } : { error: `会话编号超出范围：${value}` };
  }
  const idMatch = threads.find((thread) => thread.id === value);
  if (idMatch) return { thread: idMatch };
  const normalized = value.toLocaleLowerCase();
  const exact = threads.filter((thread) => threadName(thread).toLocaleLowerCase() === normalized);
  if (exact.length === 1) return { thread: exact[0] };
  const partial = threads.filter((thread) => threadName(thread).toLocaleLowerCase().includes(normalized));
  if (partial.length === 1) return { thread: partial[0] };
  if (exact.length > 1 || partial.length > 1) return { error: `“${value}”匹配到多个会话，请改用当前列表中的编号。` };
  return { error: `找不到会话：${value}。发送 \`/resume\` 刷新列表。` };
}

export function parsePendingWorkdirReply(text, waitingForPath) {
  if (!waitingForPath) return null;
  const query = String(text || "").trim().replace(/^['"]|['"]$/g, "");
  if (!query || !isAbsolute(query)) return null;
  return { type: "cd", query };
}

export function resolveWorkdirQuery(query, rootDir) {
  const root = resolve(rootDir);
  const trimmed = query.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return { error: "请提供项目名或目录路径。" };
  const candidate = resolve(root, trimmed);
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return { path: candidate };
  }
  if (isAbsolute(trimmed)) {
    return { error: `目录不存在或不是文件夹：${candidate}`, needsPath: true };
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
  return {
    error: `在 ${root} 的第一层目录中找不到“${trimmed}”。请发送该文件夹的绝对路径。`,
    needsPath: true,
  };
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
  return mergeProjectEnv(process.env, fileValues);
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
      pendingWorkdirQueries: value.pendingWorkdirQueries && typeof value.pendingWorkdirQueries === "object" ? value.pendingWorkdirQueries : {},
      events: Array.isArray(value.events) ? value.events : [],
    };
  } catch {
    return { sessions: {}, workdirs: {}, approvalModes: {}, pendingWorkdirQueries: {}, events: [] };
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
    reactions: !["false", "0", "no"].includes(String(env.FEISHU_REACTIONS ?? "true").trim().toLowerCase()),
    model: env.CODEX_MODEL?.trim() || "",
    defaultApprovalMode,
    timeoutMs: Number(env.CODEX_TIMEOUT_MS) || 1_800_000,
    replyChars: Math.min(Math.max(Number(env.FEISHU_REPLY_CHARS) || 3500, 500), 8000),
    eventCacheSize: Math.min(Math.max(Number(env.EVENT_CACHE_SIZE) || 1000, 100), 10_000),
    projectInstructions: existsSync(resolve(ROOT, "AGENTS.md")) ? readFileSync(resolve(ROOT, "AGENTS.md"), "utf8") : "",
    turnAdditionalContext: AOI_FEISHU_TURN_CONTEXT,
  };
}

async function preflight() {
  await run("codex", ["app-server", "--help"]);
  await run("lark-cli", ["event", "schema", "card.action.trigger"]);
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

function cardButton(text, type, value) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    value,
  };
}

function approvalButton(text, type, approvalId, decision) {
  return cardButton(text, type, { kind: "codex2lark_approval", approvalId, decision });
}

function controlButton(text, type, action, details = {}) {
  return cardButton(text, type, { kind: "codex2lark_control", action, ...details });
}

export function buildApprovalCard(subject, approvalId) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "需要审批" },
    },
    elements: [
      { tag: "markdown", content: String(subject || "Codex 请求执行操作").slice(0, 5000) },
      {
        tag: "action",
        actions: [
          approvalButton("允许一次", "primary", approvalId, "accept"),
          approvalButton("本会话允许", "default", approvalId, "acceptForSession"),
          approvalButton("拒绝", "danger", approvalId, "decline"),
        ],
      },
      { tag: "note", elements: [{ tag: "plain_text", content: "按钮不可用时，可发送 /approve、/approve session 或 /deny。" }] },
    ],
  };
}

export function buildResolvedApprovalCard(decision, operatorId) {
  const denied = decision === "decline";
  const label = denied ? "已拒绝" : decision === "acceptForSession" ? "已允许，本会话有效" : "已允许一次";
  return {
    open_ids: [operatorId],
    config: { wide_screen_mode: true },
    header: {
      template: denied ? "red" : "green",
      title: { tag: "plain_text", content: label },
    },
    elements: [{ tag: "markdown", content: `审批操作已处理：**${label}**` }],
  };
}

export function buildHelpCard(approvalMode = "auto") {
  const nextMode = approvalMode === "auto" ? "manual" : "auto";
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Codex 助手" },
    },
    elements: [
      { tag: "markdown", content: [
        "直接发送任务即可。常用命令：",
        "`/cd 项目名或路径` 切换目录 · `/new` 新建对话",
        "`/resume` 继续历史对话 · `/stop` 停止当前操作",
        "`/approval auto|manual` 切换审批 · `/status` 查看状态",
      ].join("\n") },
      {
        tag: "action",
        actions: [
          controlButton("新建对话", "primary", "new"),
          controlButton("继续对话", "default", "resume"),
          controlButton(`改为${nextMode === "auto" ? "自动" : "手动"}审批`, "default", "approvalMode", { mode: nextMode }),
        ],
      },
      {
        tag: "action",
        actions: [
          controlButton("查看状态", "default", "status"),
          controlButton("停止当前操作", "danger", "stop"),
        ],
      },
    ],
  };
}

export function buildResumeCard(threads, currentThreadId = "", pageStart = 0, totalCount = threads.length) {
  const elements = [];
  if (!threads.length) {
    elements.push({ tag: "markdown", content: "没有可恢复的历史会话。" });
  } else {
    for (const [index, thread] of threads.entries()) {
      const current = thread.id === currentThreadId ? " · 当前" : "";
      elements.push({
        tag: "markdown",
        content: `**${pageStart + index + 1}. ${threadLabel(thread)}**${current}\n${threadTimestamp(thread)} · ${threadCwdLabel(thread)}`,
      });
      elements.push({
        tag: "action",
        actions: [controlButton("继续此对话", thread.id === currentThreadId ? "default" : "primary", "resume", {
          threadId: thread.id,
        })],
      });
    }
  }
  const navigation = [];
  if (pageStart > 0) navigation.push(controlButton("上一页", "default", "resumePage", {
    pageStart: Math.max(0, pageStart - 5),
  }));
  if (pageStart + threads.length < totalCount) navigation.push(controlButton("下一页", "default", "resumePage", {
    pageStart: pageStart + 5,
  }));
  if (navigation.length) elements.push({ tag: "action", actions: navigation });
  elements.push({ tag: "note", elements: [{
    tag: "plain_text",
    content: threads.length ? `第 ${Math.floor(pageStart / 5) + 1} 页 · 共 ${totalCount} 个会话` : "也可稍后再次发送 /resume",
  }] });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "继续历史对话" },
    },
    elements,
  };
}

export function approvalCardUpdateArgs(token, card) {
  return [
    "api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot",
    "--data", JSON.stringify({ token, card }),
  ];
}

async function sendApprovalCard(messageId, eventKey, subject, approvalId) {
  await run("lark-cli", [
    "im", "+messages-reply", "--as", "bot", "--message-id", messageId,
    "--msg-type", "interactive", "--content", JSON.stringify(buildApprovalCard(subject, approvalId)),
    "--idempotency-key", idempotencyKey(eventKey, approvalId),
  ]);
}

async function sendInteractiveCard(messageId, eventKey, card) {
  await run("lark-cli", [
    "im", "+messages-reply", "--as", "bot", "--message-id", messageId,
    "--msg-type", "interactive", "--content", JSON.stringify(card),
    "--idempotency-key", idempotencyKey(eventKey),
  ]);
}

async function updateInteractiveCard(event, card) {
  if (!event.token || !event.operatorId) throw new Error("卡片回调缺少更新凭据");
  await run("lark-cli", approvalCardUpdateArgs(event.token, {
    ...card,
    open_ids: [event.operatorId],
  }));
}

async function updateApprovalCard(event) {
  if (!event.token || !event.operatorId) return;
  await run("lark-cli", approvalCardUpdateArgs(
    event.token,
    buildResolvedApprovalCard(event.decision, event.operatorId),
  ));
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

export function reactionArgs(action, messageId, value) {
  if (action === "create") {
    return [
      "im", "reactions", "create", "--as", "bot", "--message-id", messageId,
      "--data", JSON.stringify({ reaction_type: { emoji_type: value } }),
    ];
  }
  if (action === "delete") {
    return ["im", "reactions", "delete", "--as", "bot", "--message-id", messageId, "--reaction-id", value];
  }
  throw new Error(`不支持的消息表情操作：${action}`);
}

export function reactionIdFromOutput(text) {
  const result = JSON.parse(text);
  return String(result.reaction_id || result.data?.reaction_id || "");
}

async function addReaction(messageId, emojiType) {
  const { stdout } = await run("lark-cli", reactionArgs("create", messageId, emojiType));
  return reactionIdFromOutput(stdout);
}

async function beginProcessingReaction(messageId, config) {
  if (!config.reactions) return "";
  try {
    return await addReaction(messageId, "Typing");
  } catch (error) {
    console.warn(`[bridge] cannot add Typing reaction to ${messageId}: ${error.message}`);
    return "";
  }
}

async function finishProcessingReaction(messageId, reactionId, succeeded, config) {
  if (!config.reactions || !reactionId) return;
  try {
    await run("lark-cli", reactionArgs("delete", messageId, reactionId));
  } catch (error) {
    console.warn(`[bridge] cannot remove Typing reaction from ${messageId}: ${error.message}`);
    return;
  }
  if (succeeded) return;
  try {
    await addReaction(messageId, "CrossMark");
  } catch (error) {
    console.warn(`[bridge] cannot add CrossMark reaction to ${messageId}: ${error.message}`);
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
    this.resumeCandidates = new Map();
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
    if (!stored) return this.config.rootDir;
    const candidate = resolve(stored);
    try {
      return existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : this.config.rootDir;
    } catch {
      return this.config.rootDir;
    }
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
    command ||= parsePendingWorkdirReply(
      event.content,
      this.state.pendingWorkdirQueries[event.chatId],
    );
    if (command?.type === "new") {
      delete this.state.sessions[event.chatId];
      delete this.state.pendingWorkdirQueries[event.chatId];
      this.resumeCandidates.delete(event.chatId);
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
      try {
        await sendInteractiveCard(event.messageId, `${event.eventId}-help`, buildHelpCard(this.modeFor(event.chatId)));
      } catch (error) {
        console.warn(`[bridge] help card failed; using text fallback: ${error.message}`);
        await sendReply(event.messageId, `${event.eventId}-help-text`,
          "直接发送任务即可。\n\n`/cd 项目名或路径` 切换工作目录\n`/new` 新建对话\n`/resume` 继续历史对话\n`/stop` 停止当前操作\n`/approval auto|manual` 切换审批模式\n`/status` 查看状态", this.config);
      }
      return;
    }
    if (command?.type === "resumePage") {
      await this.#handleResumePage(event, command.pageStart);
      return;
    }
    if (command?.type === "resume") {
      try {
        await this.#handleResume(event, command.query);
      } catch (error) {
        await sendReply(event.messageId, `${event.eventId}-resume-failed`,
          `历史会话操作失败：${String(error.message || error).slice(0, 1500)}`, this.config);
      }
      return;
    }
    if (command?.type === "cd") {
      delete this.state.pendingWorkdirQueries[event.chatId];
      const result = resolveWorkdirQuery(command.query, this.config.rootDir);
      if (result.error) {
        if (result.needsPath) this.state.pendingWorkdirQueries[event.chatId] = command.query;
        saveState(this.state);
        await sendReply(event.messageId, `${event.eventId}-cd`, result.error, this.config);
        return;
      }
      this.state.workdirs[event.chatId] = result.path;
      delete this.state.pendingWorkdirQueries[event.chatId];
      this.resumeCandidates.delete(event.chatId);
      saveState(this.state);
      await sendReply(event.messageId, `${event.eventId}-cd`, `已切换工作目录：${result.path}\n后续轮次会在该目录执行，会话上下文保留。`, this.config);
      return;
    }

    const directFiles = extractFileDirectives(event.content, { cwd: this.cwdFor(event.chatId) });
    if (directFiles.files.length && !directFiles.text) {
      await this.#deliverFiles(event, directFiles.files);
      return;
    }

    const processingReactionId = await beginProcessingReaction(event.messageId, this.config);
    let succeeded = false;
    try {
      const answer = await this.#runTurn(event);
      const delivery = extractFileDirectives(answer || "", { cwd: this.cwdFor(event.chatId) });
      if (delivery.text) await sendReply(event.messageId, `${event.eventId}-final`, delivery.text, this.config);
      else if (!delivery.files.length) await sendReply(event.messageId, `${event.eventId}-final`, "Codex 未返回文本结果。", this.config);
      await this.#deliverFiles(event, delivery.files);
      succeeded = true;
    } catch (error) {
      console.error(error);
      await sendReply(event.messageId, `${event.eventId}-error`, `Codex 执行失败：${String(error.message || error).slice(0, 2000)}`, this.config);
    } finally {
      await finishProcessingReaction(event.messageId, processingReactionId, succeeded, this.config);
    }
  }

  #threadOptions(chatId, cwd = this.cwdFor(chatId)) {
    return {
      cwd,
      approvalPolicy: approvalPolicy(this.modeFor(chatId)),
      sandbox: "workspace-write",
      developerInstructions: this.config.projectInstructions || null,
      ...(this.config.model ? { model: this.config.model } : {}),
    };
  }

  async #listResumeThreads(chatId) {
    const threads = [];
    const seenCursors = new Set();
    let cursor;
    do {
      const result = await this.client.request("thread/list", {
        ...(cursor ? { cursor } : {}),
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        sourceKinds: ["appServer", "cli", "vscode"],
      });
      if (Array.isArray(result?.data)) threads.push(...result.data);
      const nextCursor = typeof result?.nextCursor === "string" ? result.nextCursor : "";
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return threads;
  }

  async handleCardAction(event) {
    if (event.type === "control") {
      const command = event.action === "approvalMode"
        ? { type: "approvalMode", mode: event.mode }
        : event.action === "resume"
          ? { type: "resume", query: event.threadId || "" }
          : event.action === "resumePage"
            ? { type: "resumePage", pageStart: event.pageStart }
            : { type: event.action };
      if (["stop", "approvalMode"].includes(command.type)) await this.handleImmediate(event, command);
      else this.enqueue(event, command);
      return;
    }
    let resolved;
    try {
      resolved = this.#resolveApprovalById(event.chatId, event.approvalId, event.decision);
    } catch (error) {
      console.error(`[bridge] card approval ${event.approvalId} failed: ${error.message}`);
      await sendReply(event.messageId, `${event.eventId}-approval-failed`,
        "按钮审批失败，请发送 `/approve`、`/approve session` 或 `/deny`。", this.config);
      return;
    }
    if (!resolved) {
      console.warn(`[bridge] ignored resolved or unknown approval ${event.approvalId}`);
      await sendReply(event.messageId, `${event.eventId}-approval-expired`,
        "该审批已处理或已过期。", this.config);
      return;
    }
    try {
      await updateApprovalCard(event);
    } catch (error) {
      console.warn(`[bridge] cannot update approval card ${event.messageId}: ${error.message}`);
      const label = event.decision === "decline" ? "已拒绝" : "已批准";
      await sendReply(event.messageId, `${event.eventId}-approval-result`, `${label}待处理操作。`, this.config);
    }
  }

  async #handleResume(event, query) {
    const pageSize = 5;
    const isNext = /^(?:next|more|下一页|更多)$/i.test(query);
    const isPrevious = /^(?:prev|previous|上一页)$/i.test(query);
    if (!query) {
      const threads = await this.#listResumeThreads(event.chatId);
      const candidates = { threads, pageStart: 0 };
      this.resumeCandidates.set(event.chatId, candidates);
      await sendInteractiveCard(event.messageId, `${event.eventId}-resume-list`,
        buildResumeCard(threads.slice(0, pageSize), this.state.sessions[event.chatId], 0, threads.length));
      return;
    }
    let candidates = this.resumeCandidates.get(event.chatId);
    if (!candidates) {
      const threads = await this.#listResumeThreads(event.chatId);
      candidates = { threads, pageStart: 0 };
      this.resumeCandidates.set(event.chatId, candidates);
    }
    if (isNext || isPrevious) {
      const nextStart = candidates.pageStart + (isNext ? pageSize : -pageSize);
      if (nextStart < 0 || nextStart >= candidates.threads.length) {
        await sendReply(event.messageId, `${event.eventId}-resume-end`,
          isNext ? "没有更多历史会话了。" : "已经是第一页了。", this.config);
        return;
      }
      candidates.pageStart = nextStart;
      const page = candidates.threads.slice(nextStart, nextStart + pageSize);
      await sendInteractiveCard(event.messageId, `${event.eventId}-resume-page-${nextStart}`,
        buildResumeCard(page, this.state.sessions[event.chatId], nextStart, candidates.threads.length));
      return;
    }
    const page = candidates.threads.slice(candidates.pageStart, candidates.pageStart + pageSize);
    const selected = /^\d+$/.test(query)
      ? selectResumeThread(page, query)
      : selectResumeThread(candidates.threads, query);
    if (selected.error) {
      await sendReply(event.messageId, `${event.eventId}-resume-error`, selected.error, this.config);
      return;
    }
    const threadId = selected.thread.id;
    if (threadId === this.state.sessions[event.chatId]) {
      await sendReply(event.messageId, `${event.eventId}-resume-current`,
        `已经在该会话中：${threadLabel(selected.thread)}`, this.config);
      return;
    }
    const active = this.activeThreads.get(threadId);
    if (active) {
      await sendReply(event.messageId, `${event.eventId}-resume-active`,
        "该会话正在执行其他任务，暂时不能切换。", this.config);
      return;
    }
    const selectedCwd = availableThreadCwd(selected.thread);
    if (!this.loadedThreads.has(threadId)) {
      await this.client.request("thread/resume", {
        threadId,
        ...this.#threadOptions(event.chatId, selectedCwd || this.cwdFor(event.chatId)),
      });
      this.loadedThreads.add(threadId);
    }
    this.state.sessions[event.chatId] = threadId;
    if (selectedCwd) this.state.workdirs[event.chatId] = selectedCwd;
    this.resumeCandidates.delete(event.chatId);
    saveState(this.state);
    await sendReply(event.messageId, `${event.eventId}-resume-done`,
      `已继续历史会话：${threadLabel(selected.thread)}\n工作目录：${basename(this.cwdFor(event.chatId))}`, this.config);
  }

  async #handleResumePage(event, requestedStart) {
    const pageSize = 5;
    let candidates = this.resumeCandidates.get(event.chatId);
    if (!candidates) {
      const threads = await this.#listResumeThreads(event.chatId);
      candidates = { threads, pageStart: 0 };
      this.resumeCandidates.set(event.chatId, candidates);
    }
    const lastStart = Math.max(0, Math.floor((Math.max(1, candidates.threads.length) - 1) / pageSize) * pageSize);
    const pageStart = Math.min(Math.max(0, requestedStart), lastStart);
    candidates.pageStart = pageStart;
    const card = buildResumeCard(
      candidates.threads.slice(pageStart, pageStart + pageSize),
      this.state.sessions[event.chatId],
      pageStart,
      candidates.threads.length,
    );
    try {
      await updateInteractiveCard(event, card);
    } catch (error) {
      console.warn(`[bridge] resume card update failed; sending a new card: ${error.message}`);
      await sendInteractiveCard(event.messageId, `${event.eventId}-resume-page-${pageStart}`, card);
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

  async #ensureThread(chatId) {
    let threadId = this.state.sessions[chatId];
    let isNew = false;
    const common = this.#threadOptions(chatId);
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
      isNew = true;
    }
    return { threadId, isNew };
  }

  async #runTurn(event) {
    const cwd = this.cwdFor(event.chatId);
    const mode = this.modeFor(event.chatId);
    const { threadId, isNew } = await this.#ensureThread(event.chatId);
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
        additionalContext: this.config.turnAdditionalContext,
        cwd,
        approvalPolicy: approvalPolicy(mode),
        sandboxPolicy: turnSandbox(cwd),
        ...(this.config.model ? { model: this.config.model } : {}),
      });
      active.turnId = result.turn.id;
      if (isNew) {
        try {
          await this.client.request("thread/name/set", {
            threadId,
            name: createThreadTitle(event.content),
          });
        } catch (error) {
          console.warn(`[codex] cannot name new thread ${threadId}: ${error.message}`);
        }
      }
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

  #queueApprovalCard(active, key, subject, approvalId) {
    if (active.progressKeys.has(key)) return;
    active.progressKeys.add(key);
    active.sendQueue = active.sendQueue.then(async () => {
      try {
        await sendApprovalCard(active.event.messageId, `${active.event.eventId}-${key}`, subject, approvalId);
      } catch (error) {
        console.warn(`[bridge] approval card failed; using text fallback: ${error.message}`);
        await sendReply(active.event.messageId, `${active.event.eventId}-${key}-text`,
          `需要审批\n\n${subject}\n\n发送 \`/approve\` 允许一次，\`/approve session\` 本会话允许，或 \`/deny\` 拒绝。`, this.config);
      }
    }).catch((error) => console.error(`[bridge] approval prompt failed: ${error.message}`));
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
    const approvalId = randomUUID();
    pending.push({ approvalId, requestId: message.id, method: message.method, params });
    this.pendingApprovals.set(active.chatId, pending);
    const subject = message.method.includes("commandExecution")
      ? `💻 terminal\n\n\`\`\`powershell\n${fenced(params.command || "命令未提供")}\n\`\`\``
      : `📝 file change\n${params.reason || params.grantRoot || "Codex 请求修改文件"}`;
    this.#queueApprovalCard(active, `approval-${message.id}`, subject, approvalId);
  }

  #resolveApprovalById(chatId, approvalId, decision) {
    const pending = this.pendingApprovals.get(chatId) || [];
    const index = pending.findIndex((approval) => approval.approvalId === approvalId);
    if (index < 0) return false;
    const [approval] = pending.splice(index, 1);
    try {
      this.client.respond(approval.requestId, { decision });
    } catch (error) {
      pending.splice(index, 0, approval);
      throw error;
    }
    if (pending.length) this.pendingApprovals.set(chatId, pending);
    else this.pendingApprovals.delete(chatId);
    return true;
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

async function acceptCardEvent(raw, runtime, state, config) {
  const event = parseCardAction(raw);
  if (!event?.eventId || !event.chatId || !event.messageId || !event.operatorId) {
    console.warn("[bridge] ignored malformed or unrelated card action");
    return;
  }
  if (state.events.includes(event.eventId)) return;
  state.events.push(event.eventId);
  state.events = state.events.slice(-config.eventCacheSize);
  saveState(state);
  if (!config.allowedIds.has(event.operatorId)) {
    console.warn(`[bridge] ignored unauthorized card operator ${event.operatorId}`);
    return;
  }
  console.log(`[bridge] received card action event=${event.eventId} chat=${event.chatId}`);
  await runtime.handleCardAction(event);
}

function startConsumer(state, config, runtime) {
  const retryMs = new Map();
  let stopping = false;
  const children = new Set();
  let stopWatching;
  const start = (eventKey, handler) => {
    let stdoutBuffer = "";
    const spec = commandSpec("lark-cli", ["event", "consume", eventKey, "--as", "bot"]);
    const child = spawn(spec.command, spec.args, {
      cwd: ROOT, env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          void handler(JSON.parse(line), runtime, state, config).catch((error) => console.error(error));
        } catch (error) {
          console.error(`[bridge] invalid ${eventKey} JSON: ${error.message}`);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.error(`[lark:${eventKey}] ${text}`);
      if (text.includes("[event] ready")) retryMs.set(eventKey, 1000);
    });
    child.once("error", (error) => console.error(`[lark:${eventKey}] ${error.message}`));
    child.once("close", (code) => {
      children.delete(child);
      if (stopping) return;
      if (existsSync(STOP_FILE)) {
        stop();
        return;
      }
      const delay = retryMs.get(eventKey) || 1000;
      console.error(`[lark:${eventKey}] consumer exited ${code}; retrying in ${delay} ms`);
      setTimeout(() => start(eventKey, handler), delay);
      retryMs.set(eventKey, Math.min(delay * 2, 30_000));
    });
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopWatching?.();
    runtime.stop();
    for (const child of children) child.stdin.end();
    setTimeout(() => {
      for (const child of children) child.kill();
    }, 3000).unref();
  };
  stopWatching = watchForStopRequest(STOP_FILE, stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  start("im.message.receive_v1", acceptEvent);
  start("card.action.trigger", acceptCardEvent);
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
