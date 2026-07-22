import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildConfig,
  extractFileDirectives,
  formatThreadItem,
  idempotencyKey,
  isMarkdownValidationError,
  normalizeEvent,
  parseControlCommand,
  parsePendingWorkdirReply,
  parseDotEnv,
  reactionArgs,
  reactionIdFromOutput,
  resolveWorkdirQuery,
  splitReply,
  watchForStopRequest,
} from "../src/bridge.js";

test("parseDotEnv reads simple and quoted values", () => {
  assert.deepEqual(parseDotEnv("A=1\nB=\"two words\"\n# ignored\n"), { A: "1", B: "two words" });
});

test("normalizeEvent accepts flattened and JSON-wrapped text", () => {
  assert.deepEqual(normalizeEvent({
    event_id: "evt", message_id: "om_1", chat_id: "oc_1", chat_type: "p2p",
    sender_id: "ou_1", message_type: "text", content: "{\"text\":\" hello \"}",
  }), {
    eventId: "evt", messageId: "om_1", chatId: "oc_1", chatType: "p2p",
    senderId: "ou_1", messageType: "text", content: "hello",
  });
});

test("splitReply prefers newline boundaries", () => {
  assert.deepEqual(splitReply("12345\n67890", 7), ["12345", "67890"]);
});

test("watchForStopRequest invokes the stop callback once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2lark-stop-"));
  const stopFile = join(directory, "stop-requested");
  let stopCount = 0;
  try {
    await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("stop request was not detected")), 1000);
      const cancel = watchForStopRequest(stopFile, () => {
        stopCount += 1;
        cancel();
        clearTimeout(timeout);
        resolvePromise();
      }, 10);
      writeFileSync(stopFile, new Date().toISOString());
    });
    assert.equal(stopCount, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parseControlCommand recognizes control and natural-language commands", () => {
  assert.deepEqual(parseControlCommand("/approval manual"), { type: "approvalMode", mode: "manual" });
  assert.deepEqual(parseControlCommand("改为自动审批"), { type: "approvalMode", mode: "auto" });
  assert.deepEqual(parseControlCommand("/approve session"), { type: "approve", session: true });
  assert.deepEqual(parseControlCommand("停止当前操作"), { type: "stop" });
  assert.deepEqual(parseControlCommand("切换到 Demo 项目"), { type: "cd", query: "Demo" });
  assert.equal(parseControlCommand("请分析自动审批的风险"), null);
});

test("resolveWorkdirQuery prioritizes first-level names and accepts arbitrary paths", () => {
  const parent = mkdtempSync(join(tmpdir(), "codex2lark-root-"));
  const root = join(parent, "AAAVitalFile");
  const outside = join(parent, "ExternalProject");
  try {
    mkdirSync(root);
    mkdirSync(join(root, "BubbleDynamics"));
    mkdirSync(join(root, "Other"));
    mkdirSync(outside);
    assert.equal(resolveWorkdirQuery("bubble", root).path, resolve(root, "BubbleDynamics"));
    assert.equal(resolveWorkdirQuery(outside, root).path, resolve(outside));
    assert.equal(resolveWorkdirQuery(join("..", "ExternalProject"), root).path, resolve(outside));
    assert.equal(resolveWorkdirQuery("missing", root).needsPath, true);
    assert.match(resolveWorkdirQuery(join(parent, "does-not-exist"), root).error, /不存在/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("parsePendingWorkdirReply accepts a direct absolute-path answer only while waiting", () => {
  const directory = resolve(tmpdir());
  assert.deepEqual(parsePendingWorkdirReply(`"${directory}"`, "missing"), { type: "cd", query: directory });
  assert.equal(parsePendingWorkdirReply(directory, ""), null);
  assert.equal(parsePendingWorkdirReply("继续处理任务", "missing"), null);
});

test("extractFileDirectives removes native-delivery markers", () => {
  assert.deepEqual(extractFileDirectives([
    "报告已生成。",
    "FILE:C:\\work\\report.pdf",
    "MEDIA:\"C:\\work\\plot.png\"",
  ].join("\n")), {
    text: "报告已生成。",
    files: [
      { kind: "FILE", path: "C:\\work\\report.pdf" },
      { kind: "MEDIA", path: "C:\\work\\plot.png" },
    ],
  });
});

test("extractFileDirectives recognizes links to real local files", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2lark-delivery-"));
  const report = join(directory, "current.md");
  const image = join(directory, "plot.png");
  try {
    writeFileSync(report, "report");
    writeFileSync(image, "image");
    assert.deepEqual(extractFileDirectives([
      `报告：[current.md](${report})`,
      `[plot.png](${image})`,
      "[官网](https://example.com)",
    ].join("\n"), { cwd: directory }), {
      text: "报告：\n\n[官网](https://example.com)",
      files: [
        { kind: "FILE", path: report },
        { kind: "MEDIA", path: image },
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("formatThreadItem renders readable progress but suppresses tool calls", () => {
  assert.equal(formatThreadItem({ type: "agentMessage", phase: "commentary", text: "正在检查。" }), "正在检查。");
  assert.equal(formatThreadItem({ type: "reasoning", summary: [{ text: "已确认根因。" }] }), "🧠 已确认根因。");
  assert.equal(formatThreadItem({ type: "commandExecution", command: "npm test" }, "started"), "");
  assert.equal(formatThreadItem({ type: "mcpToolCall", server: "docs", tool: "search" }, "started"), "");
});

test("markdown validation failures are eligible for plain-text fallback", () => {
  assert.equal(isMarkdownValidationError(new Error('lark-cli exited 1: {"code":99992402,"message":"field validation failed"}')), true);
  assert.equal(isMarkdownValidationError(new Error("network timeout")), false);
});

test("idempotency keys leave room for fallback suffixes", () => {
  const key = idempotencyKey("event", "chunk");
  assert.equal(key.length, 44);
  assert.equal(`${key}-text`.length, 49);
});

test("reaction helpers build lark-cli calls and parse both output envelopes", () => {
  const create = reactionArgs("create", "om_1", "Typing");
  assert.deepEqual(create.slice(0, 7), ["im", "reactions", "create", "--as", "bot", "--message-id", "om_1"]);
  assert.deepEqual(JSON.parse(create.at(-1)), { reaction_type: { emoji_type: "Typing" } });
  assert.deepEqual(reactionArgs("delete", "om_1", "reaction_1").slice(-4),
    ["--message-id", "om_1", "--reaction-id", "reaction_1"]);
  assert.equal(reactionIdFromOutput('{"reaction_id":"direct"}'), "direct");
  assert.equal(reactionIdFromOutput('{"data":{"reaction_id":"wrapped"}}'), "wrapped");
});

test("buildConfig validates and exposes approval defaults", () => {
  const config = buildConfig({
    FEISHU_ALLOWED_OPEN_IDS: "ou_test",
    CODEX_WORKDIR: process.cwd(),
    CODEX_APPROVAL_MODE: "manual",
  });
  assert.equal(config.defaultApprovalMode, "manual");
  assert.equal(config.rootDir, process.cwd());
  assert.equal(config.reactions, true);
  assert.equal(buildConfig({
    FEISHU_ALLOWED_OPEN_IDS: "ou_test",
    CODEX_WORKDIR: process.cwd(),
    FEISHU_REACTIONS: "false",
  }).reactions, false);
  assert.throws(() => buildConfig({ FEISHU_ALLOWED_OPEN_IDS: "*" }), /不允许通配符/);
  assert.throws(() => buildConfig({ FEISHU_ALLOWED_OPEN_IDS: "ou_test", CODEX_APPROVAL_MODE: "sometimes" }), /auto 或 manual/);
});
