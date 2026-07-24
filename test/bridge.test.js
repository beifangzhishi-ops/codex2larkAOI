import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  approvalCardUpdateArgs,
  buildConfig,
  buildApprovalCard,
  buildHelpCard,
  buildResumeCard,
  buildResolvedApprovalCard,
  createThreadTitle,
  extractFileDirectives,
  formatResumeThreads,
  formatThreadItem,
  idempotencyKey,
  isMarkdownValidationError,
  mergeProjectEnv,
  normalizeEvent,
  parseControlCommand,
  parseApprovalCardAction,
  parseCardAction,
  parseControlCardAction,
  parsePendingWorkdirReply,
  parseDotEnv,
  reactionArgs,
  reactionIdFromOutput,
  resolveWorkdirQuery,
  selectResumeThread,
  splitReply,
  watchForStopRequest,
} from "../src/bridge.js";
import { removeRestrictedProxies, requireEnvFile, stopService } from "../src/service-control.js";

test("parseDotEnv reads simple and quoted values", () => {
  assert.deepEqual(parseDotEnv("A=1\nB=\"two words\"\n# ignored\n"), { A: "1", B: "two words" });
});

test("project env pins slot-specific values over inherited process values", () => {
  assert.deepEqual(
    mergeProjectEnv(
      { LARKSUITE_CLI_CONFIG_DIR: "aka", PATH: "inherited" },
      { LARKSUITE_CLI_CONFIG_DIR: "aoi" },
    ),
    { LARKSUITE_CLI_CONFIG_DIR: "aoi", PATH: "inherited" },
  );
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

test("service control removes only the restricted proxy injection", () => {
  const environment = {
    HTTP_PROXY: "http://127.0.0.1:9",
    https_proxy: "socks5://localhost:9/",
    ALL_PROXY: "http://proxy.example:8080",
    KEEP: "value",
  };
  assert.deepEqual(removeRestrictedProxies(environment), ["HTTP_PROXY", "HTTPS_PROXY"]);
  assert.equal("HTTP_PROXY" in environment, false);
  assert.equal("https_proxy" in environment, false);
  assert.equal(environment.ALL_PROXY, "http://proxy.example:8080");
  assert.equal(environment.KEEP, "value");
});

test("service control requires a project env file", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2lark-env-"));
  try {
    assert.throws(() => requireEnvFile(directory), /缺少 \.env/);
    writeFileSync(join(directory, ".env"), "CODEX_WORKDIR=C:\\work\n");
    assert.doesNotThrow(() => requireEnvFile(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service control cleans missing, invalid, and stale PID files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2lark-service-"));
  const state = join(directory, ".state");
  const pidFile = join(state, "bridge.pid");
  try {
    assert.deepEqual(await stopService({ root: directory }), { status: "not-running" });
    mkdirSync(state);
    writeFileSync(pidFile, "not-a-pid\n");
    assert.deepEqual(await stopService({ root: directory }), { status: "invalid-pid" });
    assert.equal(existsSync(pidFile), false);
    writeFileSync(pidFile, "4242\n");
    assert.deepEqual(await stopService({ root: directory, isRunning: () => false }), {
      status: "stale-pid", pid: 4242,
    });
    assert.equal(existsSync(pidFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service control requests a graceful stop and waits for the bridge PID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2lark-service-"));
  const state = join(directory, ".state");
  const pidFile = join(state, "bridge.pid");
  let checks = 0;
  try {
    mkdirSync(state);
    writeFileSync(pidFile, "4242\n");
    const result = await stopService({
      root: directory,
      isRunning: () => checks++ === 0,
      delay: async () => {},
    });
    assert.deepEqual(result, { status: "stopped", pid: 4242 });
    assert.equal(existsSync(pidFile), false);
    assert.match(readFileSync(join(state, "stop-requested"), "utf8"), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service control reports a timeout without broadening the stop target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex2lark-service-"));
  const state = join(directory, ".state");
  let currentTime = 0;
  try {
    mkdirSync(state);
    writeFileSync(join(state, "bridge.pid"), "4242\n");
    assert.deepEqual(await stopService({
      root: directory,
      timeoutMs: 50,
      pollIntervalMs: 25,
      isRunning: () => true,
      now: () => currentTime,
      delay: async (milliseconds) => { currentTime += milliseconds; },
    }), { status: "timeout", pid: 4242 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parseControlCommand recognizes control and natural-language commands", () => {
  assert.deepEqual(parseControlCommand("/approval manual"), { type: "approvalMode", mode: "manual" });
  assert.deepEqual(parseControlCommand("改为自动审批"), { type: "approvalMode", mode: "auto" });
  assert.deepEqual(parseControlCommand("/approve session"), { type: "approve", session: true });
  assert.deepEqual(parseControlCommand("停止当前操作"), { type: "stop" });
  assert.deepEqual(parseControlCommand("/resume Fix tests"), { type: "resume", query: "Fix tests" });
  assert.deepEqual(parseControlCommand("/resume"), { type: "resume", query: "" });
  assert.deepEqual(parseControlCommand("切换到 Demo 项目"), { type: "cd", query: "Demo" });
  assert.equal(parseControlCommand("请分析自动审批的风险"), null);
});

test("resume helpers format compact pages and select history without ambiguous title guesses", () => {
  const threads = [
    { id: "thr_1", name: "Fix tests", cwd: "C:\\work\\one", updatedAt: 1_750_000_000 },
    { id: "thr_2", preview: "Review API tests", cwd: "C:\\work\\two", createdAt: 1_740_000_000 },
    { id: "thr_3", name: "Fix tests follow-up", cwd: "C:\\work\\three", updatedAt: 1_730_000_000 },
  ];
  const output = formatResumeThreads(threads, "thr_1", true);
  assert.match(output, /1\. Fix tests \[当前\]/);
  assert.doesNotMatch(output, /thr_2/);
  assert.match(output, /\| two/);
  assert.doesNotMatch(output, /C:\\work\\two/);
  assert.match(output, /\/resume next/);
  assert.doesNotMatch(formatResumeThreads(threads, ""), /\/resume next/);
  assert.deepEqual(selectResumeThread(threads, "2").thread, threads[1]);
  assert.deepEqual(selectResumeThread(threads, "thr_3").thread, threads[2]);
  assert.deepEqual(selectResumeThread(threads, "Review API").thread, threads[1]);
  assert.match(selectResumeThread(threads, "Fix").error, /多个会话/);
  assert.match(selectResumeThread(threads, "9").error, /超出范围/);
  assert.match(formatResumeThreads([], ""), /没有可恢复/);
});

test("approval cards expose exactly three scoped decisions and parse callbacks", () => {
  const card = buildApprovalCard("Run command", "approval-1");
  const buttons = card.elements.find((element) => element.tag === "action").actions;
  assert.deepEqual(buttons.map((button) => button.text.content), ["允许一次", "本会话允许", "拒绝"]);
  assert.deepEqual(buttons.map((button) => button.value.decision), ["accept", "acceptForSession", "decline"]);
  assert.deepEqual(parseApprovalCardAction({
    event_id: "evt_card", chat_id: "oc_1", message_id: "om_1", operator_id: "ou_1",
    token: "token_1", action_tag: "button",
    action_value: JSON.stringify(buttons[1].value),
  }), {
    eventId: "evt_card", chatId: "oc_1", messageId: "om_1", operatorId: "ou_1",
    token: "token_1", approvalId: "approval-1", decision: "acceptForSession",
  });
  assert.equal(parseApprovalCardAction({ action_tag: "button", action_value: "not-json" }), null);
  assert.equal(parseApprovalCardAction({
    action_tag: "button",
    action_value: JSON.stringify({ kind: "codex2lark_approval", approvalId: "x", decision: "acceptAlways" }),
  }), null);

  const resolved = buildResolvedApprovalCard("decline", "ou_1");
  assert.equal(resolved.header.template, "red");
  assert.deepEqual(resolved.open_ids, ["ou_1"]);
  const update = approvalCardUpdateArgs("token_1", resolved);
  assert.deepEqual(update.slice(0, 6), ["api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot", "--data"]);
  assert.deepEqual(JSON.parse(update.at(-1)), { token: "token_1", card: resolved });
});

test("help card exposes common conversation controls and the opposite approval mode", () => {
  const card = buildHelpCard("auto");
  const buttons = card.elements.filter((element) => element.tag === "action")
    .flatMap((element) => element.actions);
  assert.deepEqual(buttons.map((button) => button.text.content), [
    "新建对话", "继续对话", "改为手动审批", "查看状态", "停止当前操作",
  ]);
  assert.deepEqual(buttons.map((button) => button.value.action), [
    "new", "resume", "approvalMode", "status", "stop",
  ]);
  assert.equal(buttons[2].value.mode, "manual");
  assert.match(buildHelpCard("manual").elements[1].actions[2].text.content, /自动审批/);
});

test("resume cards show five sessions plus only the available page controls", () => {
  const threads = Array.from({ length: 5 }, (_, index) => ({
    id: `thr_${index + 1}`,
    name: `Session ${index + 1}`,
    cwd: `C:\\work\\project-${index + 1}`,
    updatedAt: 1_750_000_000 - index,
  }));
  const actions = (card) => card.elements.filter((element) => element.tag === "action")
    .flatMap((element) => element.actions);
  const first = actions(buildResumeCard(threads, "thr_1", 0, 15));
  assert.equal(first.length, 6);
  assert.deepEqual(first.slice(-1)[0].value, {
    kind: "codex2lark_control", action: "resumePage", pageStart: 5,
  });
  const middle = actions(buildResumeCard(threads, "", 5, 15));
  assert.equal(middle.length, 7);
  assert.deepEqual(middle.slice(-2).map((button) => button.text.content), ["上一页", "下一页"]);
  const last = actions(buildResumeCard(threads, "", 10, 15));
  assert.equal(last.length, 6);
  assert.equal(last.at(-1).text.content, "上一页");
  assert.equal(actions(buildResumeCard(threads, "", 0, 5)).length, 5);
  assert.equal(first[0].value.threadId, "thr_1");
});

test("control card callbacks accept only the supported typed actions", () => {
  const raw = {
    event_id: "evt_control", chat_id: "oc_1", message_id: "om_1", operator_id: "ou_1",
    token: "token_1", action_tag: "button",
    action_value: JSON.stringify({ kind: "codex2lark_control", action: "resumePage", pageStart: 5 }),
  };
  assert.deepEqual(parseControlCardAction(raw), {
    type: "control", eventId: "evt_control", chatId: "oc_1", messageId: "om_1",
    operatorId: "ou_1", token: "token_1", action: "resumePage", pageStart: 5,
  });
  assert.equal(parseCardAction(raw).type, "control");
  assert.equal(parseCardAction({
    ...raw,
    action_value: JSON.stringify({ kind: "codex2lark_control", action: "resumePage", pageStart: -5 }),
  }), null);
  assert.equal(parseCardAction({
    ...raw,
    action_value: JSON.stringify({ kind: "codex2lark_control", action: "deleteEverything" }),
  }), null);
});

test("createThreadTitle summarizes the first prompt without another model call", () => {
  assert.equal(createThreadTitle("  修复登录超时问题。 然后补充测试  "), "修复登录超时问题。");
  assert.equal(createThreadTitle("Review   the API tests"), "Review the API tests");
  assert.equal(createThreadTitle("x".repeat(60)), `${"x".repeat(45)}...`);
  assert.equal(createThreadTitle(""), "新会话");
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
  assert.equal("projectInstructions" in config, false);
  const channelContext = config.turnAdditionalContext["codex2lark.aoi.feishu-channel"];
  assert.equal(channelContext.kind, "application");
  assert.match(channelContext.value, /渠道规则仅适用于当前飞书轮次/);
  assert.doesNotMatch(channelContext.value, /禁止停止、重启或终止 AOI 桥接服务/);
  assert.match(channelContext.value, /MEDIA:C:\\绝对路径\\图片\.png/);
  assert.match(channelContext.value, /桥接负责 \/cd、\/new、\/status、\/stop/);
  assert.match(channelContext.value, /用户明确要求管理本项目服务时，使用 start\.cmd 或 stop\.cmd/);
  assert.equal(buildConfig({
    FEISHU_ALLOWED_OPEN_IDS: "ou_test",
    CODEX_WORKDIR: process.cwd(),
    FEISHU_REACTIONS: "false",
  }).reactions, false);
  assert.throws(() => buildConfig({ FEISHU_ALLOWED_OPEN_IDS: "*" }), /不允许通配符/);
  assert.throws(() => buildConfig({ FEISHU_ALLOWED_OPEN_IDS: "ou_test", CODEX_APPROVAL_MODE: "sometimes" }), /auto 或 manual/);
});
