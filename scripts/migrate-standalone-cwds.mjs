import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "../src/codex-app-server.js";
import {
  ensureStandaloneCwd,
  formatLocalDate,
  isLegacyStandalonePath,
  legacyDirectoryTarget,
  legacyStandaloneRoot,
  normalizeStandaloneCwdAliases,
  resolveStandaloneCwdAlias,
  standaloneRoot,
  validUuid,
} from "../src/standalone-cwds.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact",
  "subAgentThreadSpawn", "subAgentOther", "unknown",
];

function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, index).trim()] = value;
  }
  return values;
}

function nowTag() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "");
}

function statePaths(root) {
  const stateDir = resolve(root, ".state");
  const tag = nowTag();
  return {
    stateDir,
    stateFile: resolve(stateDir, "sessions.json"),
    backupFile: resolve(stateDir, `sessions.json.bak-${tag}`),
    recordFile: resolve(stateDir, `standalone-cwd-migration-${tag}.json`),
  };
}

function readState(stateFile) {
  if (!existsSync(stateFile)) return {};
  const value = JSON.parse(readFileSync(stateFile, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sessions.json 不是 JSON 对象");
  return value;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeStateAtomic(stateFile, value) {
  const temporary = `${stateFile}.migration.tmp`;
  writeJson(temporary, value);
  renameSync(temporary, stateFile);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function assertBridgeStopped(root = ROOT) {
  const pidFile = resolve(root, ".state", "bridge.pid");
  if (!existsSync(pidFile)) return null;
  const text = readFileSync(pidFile, "utf8").trim();
  const pid = /^\d+$/.test(text) ? Number(text) : 0;
  if (pid && processIsRunning(pid)) {
    throw new Error(`AOI 桥接仍在运行（PID ${pid}），请先停止 AOI 再执行 --apply`);
  }
  return pid || null;
}

function listTopLevelDirectories(sourceRoot) {
  if (!existsSync(sourceRoot)) return [];
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(sourceRoot, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function collectFiles(directory, base = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(fullPath, base));
    else if (entry.isFile()) files.push(fullPath);
    else throw new Error(`不支持的文件类型，无法安全迁移: ${fullPath}`);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function fileSummary(directory) {
  const files = collectFiles(directory);
  let bytes = 0;
  for (const file of files) bytes += lstatSync(file).size;
  return { files: files.length, bytes };
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fileManifest(directory) {
  return collectFiles(directory).map((file) => ({
    path: relative(directory, file),
    bytes: lstatSync(file).size,
    sha256: sha256File(file),
  }));
}

function currentCreationDate(directory) {
  const stat = lstatSync(directory);
  const value = stat.birthtimeMs > 0 ? stat.birthtime : stat.ctime;
  return formatLocalDate(value);
}

export function buildMigrationEntries({ sourceRoot = legacyStandaloneRoot(), targetRoot = standaloneRoot() } = {}) {
  const directories = listTopLevelDirectories(resolve(sourceRoot));
  const invalid = directories.filter((directory) => !validUuid(basename(directory)));
  if (invalid.length) throw new Error(`旧 Temp 根目录含非 UUID 子目录，拒绝自动合并: ${invalid.join(", ")}`);
  return directories.map((source) => {
    const date = currentCreationDate(source);
    const target = legacyDirectoryTarget(source, { root: targetRoot, date });
    return {
      source,
      target,
      uuid: basename(source),
      date,
      summary: fileSummary(source),
      sourceHasOutputs: existsSync(resolve(source, "outputs")),
      sourceHasWork: existsSync(resolve(source, "work")),
    };
  });
}

function validateTargetCollisions(entries) {
  const collisions = entries.filter((entry) => existsSync(entry.target)).map((entry) => entry.target);
  const duplicateTargets = entries
    .map((entry) => entry.target.toLocaleLowerCase())
    .filter((target, index, all) => all.indexOf(target) !== index);
  if (collisions.length || duplicateTargets.length) {
    const details = [...new Set([...collisions, ...duplicateTargets])].join("\n");
    throw new Error(`目标目录已存在或发生冲突，未执行合并:\n${details}`);
  }
}

function buildAliases(entries) {
  return normalizeStandaloneCwdAliases(Object.fromEntries(entries.map((entry) => [entry.source, entry.target])));
}

function updateStateForMigration(state, aliases) {
  const next = { ...state };
  next.standaloneCwdAliases = { ...(state.standaloneCwdAliases || {}), ...aliases };
  next.workdirs = { ...(state.workdirs || {}) };
  for (const [chatId, cwd] of Object.entries(next.workdirs)) {
    const mapped = resolveStandaloneCwdAlias(cwd, aliases);
    if (mapped && mapped !== cwd) next.workdirs[chatId] = mapped;
  }
  return next;
}

function extractThreadList(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

async function listAllThreads(client, archived) {
  const result = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await client.request("thread/list", {
      ...(cursor ? { cursor } : {}),
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived,
      sourceKinds: SOURCE_KINDS,
      useStateDbOnly: true,
    });
    result.push(...extractThreadList(page).map((thread) => ({ ...thread, archived })));
    const next = typeof page?.nextCursor === "string" ? page.nextCursor : "";
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  } while (cursor);
  return result;
}

async function listMigratableThreads(client, sourceRoot) {
  const all = [...await listAllThreads(client, false), ...await listAllThreads(client, true)];
  const byId = new Map();
  for (const thread of all) {
    if (!thread?.id || !isLegacyStandalonePath(thread.cwd, { root: sourceRoot })) continue;
    const previous = byId.get(thread.id);
    byId.set(thread.id, previous ? { ...previous, archived: previous.archived && thread.archived } : thread);
  }
  return [...byId.values()];
}

function threadIsActive(thread) {
  return thread?.status?.type === "active";
}

function backgroundTerminalItems(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

async function checkThreadSafety(client, threads) {
  const active = threads.filter(threadIsActive);
  if (active.length) {
    throw new Error(`仍有 ${active.length} 个旧独立对话处于运行中，拒绝迁移: ${active.map((thread) => thread.id).join(", ")}`);
  }
  const terminals = [];
  for (const thread of threads) {
    try {
      const result = await client.request("thread/backgroundTerminals/list", { threadId: thread.id, limit: 100 });
      terminals.push(...backgroundTerminalItems(result).map((terminal) => ({ threadId: thread.id, terminal })));
    } catch (error) {
      const message = String(error?.message || error);
      if (!/not loaded|not found|unknown thread|不存在|未加载/i.test(message)) throw error;
    }
  }
  if (terminals.length) {
    throw new Error(`旧独立对话仍有 ${terminals.length} 个后台终端，拒绝迁移`);
  }
}

function threadCwd(entry, aliases) {
  const mapped = resolveStandaloneCwdAlias(entry.cwd, aliases);
  if (!mapped || !entry.cwd || mapped === entry.cwd) {
    throw new Error(`无法为线程 ${entry.id} 找到旧 cwd 别名: ${entry.cwd || "(空)"}`);
  }
  return mapped;
}

async function rebindThreads(client, threads, aliases) {
  const changed = [];
  const loaded = new Set();
  try {
    const loadedResult = await client.request("thread/loaded/list", {});
    for (const id of loadedResult?.data || []) loaded.add(id);
  } catch {
    // 老版本没有 loaded/list 时，resume 仍然可以完成重绑。
  }
  for (const thread of threads) {
    const cwd = threadCwd(thread, aliases);
    const wasLoaded = loaded.has(thread.id);
    if (thread.archived) await client.request("thread/unarchive", { threadId: thread.id });
    await client.request("thread/resume", { threadId: thread.id, cwd, excludeTurns: true });
    if (!wasLoaded && !threadIsActive(thread)) {
      try { await client.request("thread/unsubscribe", { threadId: thread.id }); } catch { /* best effort */ }
    }
    if (thread.archived) await client.request("thread/archive", { threadId: thread.id });
    changed.push({ id: thread.id, oldCwd: thread.cwd, cwd, archived: Boolean(thread.archived) });
  }
  return changed;
}

async function restoreThreadCwds(client, threads) {
  for (const thread of threads) {
    if (!thread?.id || !thread?.cwd) continue;
    if (thread.archived) await client.request("thread/unarchive", { threadId: thread.id });
    await client.request("thread/resume", { threadId: thread.id, cwd: resolve(thread.cwd), excludeTurns: true });
    if (thread.archived) await client.request("thread/archive", { threadId: thread.id });
  }
}

function ensureDesktopSubdirectories(entries) {
  for (const entry of entries) {
    mkdirSync(resolve(entry.target, "outputs"), { recursive: true });
    mkdirSync(resolve(entry.target, "work"), { recursive: true });
  }
}

function verifyEntry(entry, expectedManifest) {
  const summary = fileSummary(entry.target);
  if (summary.files !== entry.summary.files || summary.bytes !== entry.summary.bytes) {
    throw new Error(`迁移后文件统计不一致: ${entry.target}`);
  }
  if (expectedManifest) {
    const actual = fileManifest(entry.target);
    if (actual.length !== expectedManifest.length) throw new Error(`迁移后清单数量不一致: ${entry.target}`);
    for (let index = 0; index < actual.length; index += 1) {
      const left = actual[index];
      const right = expectedManifest[index];
      if (left.path !== right.path || left.bytes !== right.bytes || left.sha256 !== right.sha256) {
        throw new Error(`迁移后 SHA-256 不一致: ${entry.target}\\${left.path}`);
      }
    }
  }
}

function rollbackDirectories(entries) {
  for (const entry of [...entries].reverse()) {
    if (!existsSync(entry.target) || existsSync(entry.source)) continue;
    if (!entry.sourceHasOutputs) {
      try { rmdirSync(resolve(entry.target, "outputs")); } catch { /* non-empty or missing */ }
    }
    if (!entry.sourceHasWork) {
      try { rmdirSync(resolve(entry.target, "work")); } catch { /* non-empty or missing */ }
    }
    mkdirSync(dirname(entry.source), { recursive: true });
    renameSync(entry.target, entry.source);
  }
}

function removeEmptyLegacyRoots(sourceRoot) {
  try { rmdirSync(sourceRoot); } catch { return false; }
  try { rmdirSync(dirname(sourceRoot)); } catch { /* other temp files may remain */ }
  return true;
}

export async function planStandaloneMigration({ root = ROOT, sourceRoot = legacyStandaloneRoot(), targetRoot = standaloneRoot() } = {}) {
  const entries = buildMigrationEntries({ sourceRoot, targetRoot });
  validateTargetCollisions(entries);
  return { root, sourceRoot, targetRoot, entries, aliases: buildAliases(entries) };
}

async function applyStandaloneMigration({ root = ROOT } = {}) {
  assertBridgeStopped(root);
  const paths = statePaths(root);
  const state = readState(paths.stateFile);
  const plan = await planStandaloneMigration({ root });
  if (!plan.entries.length) return { ...plan, moved: false, threadChanges: [] };

  const env = parseDotEnv(readFileSync(resolve(root, ".env"), "utf8"));
  if (!env.CODEX_APP_SERVER_WS_URL) throw new Error("缺少 CODEX_APP_SERVER_WS_URL，无法通过共享 App Server 重绑线程");
  const manifest = [];
  for (const entry of plan.entries) {
    const files = fileManifest(entry.source);
    manifest.push({ source: entry.source, target: entry.target, uuid: entry.uuid, date: entry.date, summary: entry.summary, files });
  }
  const record = {
    version: 1,
    startedAt: new Date().toISOString(),
    sourceRoot: plan.sourceRoot,
    targetRoot: plan.targetRoot,
    aliases: plan.aliases,
    stateFile: paths.stateFile,
    backupFile: paths.backupFile,
    phase: "prepared",
    entries: manifest,
  };
  copyFileSync(paths.stateFile, paths.backupFile);
  writeJson(paths.recordFile, record);
  const client = new CodexAppServer({ cwd: root, command: env.CODEX_COMMAND || "codex", websocketUrl: env.CODEX_APP_SERVER_WS_URL });
  const movedEntries = [];
  let threads = [];
  try {
    await client.start();
    threads = await listMigratableThreads(client, plan.sourceRoot);
    await checkThreadSafety(client, threads);
    record.threadCount = threads.length;
    record.phase = "thread-check-passed";
    writeJson(paths.recordFile, record);

    for (const entry of plan.entries) {
      mkdirSync(dirname(entry.target), { recursive: true });
      renameSync(entry.source, entry.target);
      movedEntries.push(entry);
      record.phase = "directories-moved";
      record.moved = movedEntries.map((item) => ({ source: item.source, target: item.target }));
      writeJson(paths.recordFile, record);
    }
    ensureDesktopSubdirectories(plan.entries);
    for (const item of manifest) verifyEntry({ ...plan.entries.find((entry) => entry.source === item.source), target: item.target }, item.files);

    writeStateAtomic(paths.stateFile, updateStateForMigration(state, plan.aliases));
    record.phase = "state-updated";
    writeJson(paths.recordFile, record);
    record.threadChanges = await rebindThreads(client, threads, plan.aliases);
    record.phase = "threads-rebound";
    writeJson(paths.recordFile, record);
    for (const item of manifest) verifyEntry({ ...plan.entries.find((entry) => entry.source === item.source), target: item.target }, item.files);
    record.oldRootRemoved = removeEmptyLegacyRoots(plan.sourceRoot);
    record.phase = "completed";
    record.completedAt = new Date().toISOString();
    writeJson(paths.recordFile, record);
    return { ...plan, moved: true, threadChanges: record.threadChanges, recordFile: paths.recordFile, backupFile: paths.backupFile };
  } catch (error) {
    record.phase = "rolling-back";
    record.error = String(error?.stack || error);
    writeJson(paths.recordFile, record);
    try { rollbackDirectories(movedEntries); } catch (rollbackError) { record.rollbackError = String(rollbackError?.stack || rollbackError); }
    try { await restoreThreadCwds(client, threads); } catch (restoreError) { record.threadRestoreError = String(restoreError?.stack || restoreError); }
    try { copyFileSync(paths.backupFile, paths.stateFile); } catch (restoreError) { record.stateRestoreError = String(restoreError?.stack || restoreError); }
    record.phase = record.rollbackError || record.threadRestoreError || record.stateRestoreError ? "rollback-incomplete" : "rolled-back";
    writeJson(paths.recordFile, record);
    throw error;
  } finally {
    client.stop();
  }
}

function printPreview(plan) {
  const total = plan.entries.reduce((sum, entry) => ({ files: sum.files + entry.summary.files, bytes: sum.bytes + entry.summary.bytes }), { files: 0, bytes: 0 });
  console.log(`[migrate] 预览：${plan.entries.length} 个目录，${total.files} 个文件，${total.bytes} 字节`);
  for (const entry of plan.entries) console.log(`[migrate] ${entry.source} -> ${entry.target} (${entry.summary.files} 文件, ${entry.summary.bytes} 字节)`);
  console.log("[migrate] 未执行移动、状态写入或线程重绑；使用 --apply 才会执行。");
}

export async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== "--apply");
  if (unknown.length) throw new Error(`未知参数: ${unknown.join(" ")}`);
  const apply = argv.includes("--apply");
  if (!apply) {
    printPreview(await planStandaloneMigration());
    return;
  }
  const result = await applyStandaloneMigration();
  console.log(`[migrate] 完成：${result.entries.length} 个目录，线程重绑 ${result.threadChanges.length} 个`);
  console.log(`[migrate] 记录：${result.recordFile}`);
  console.log(`[migrate] 状态备份：${result.backupFile}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[migrate] 失败：${error.stack || error}`);
    process.exitCode = 1;
  });
}
