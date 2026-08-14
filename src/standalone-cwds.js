import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pathPartsBelow(root, target) {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rest = relative(rootPath, targetPath);
  if (!rest || isAbsolute(rest) || rest === ".." || rest.startsWith(`..${sep}`)) return null;
  return rest.split(sep).filter(Boolean);
}

function validDateSegment(value) {
  const match = DATE_PATTERN.exec(String(value || ""));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function validUuid(value) {
  return UUID_PATTERN.test(String(value || ""));
}

export function formatLocalDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("无效的日期");
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function standaloneRoot(root = undefined) {
  return resolve(root || `${homedir()}\\Documents\\Codex`);
}

export function legacyStandaloneRoot(root = undefined) {
  return resolve(root || `${tmpdir()}\\codex2larkAOI\\standalone`);
}

export function standaloneWorkspaceRoot(cwd, { root = standaloneRoot() } = {}) {
  const parts = pathPartsBelow(root, cwd);
  if (!parts || parts.length < 2 || !validDateSegment(parts[0]) || !validUuid(parts[1])) return "";
  return resolve(root, parts[0], parts[1]);
}

export function isStandalonePath(cwd, { root = standaloneRoot() } = {}) {
  return Boolean(standaloneWorkspaceRoot(cwd, { root }));
}

export function isLegacyStandalonePath(cwd, { root = legacyStandaloneRoot() } = {}) {
  const parts = pathPartsBelow(root, cwd);
  return Boolean(parts && parts.length >= 1 && validUuid(parts[0]));
}

export function createStandaloneCwd({ root = standaloneRoot(), date = new Date(), uuid = randomUUID() } = {}) {
  if (!validUuid(uuid)) throw new Error(`独立对话目录 UUID 无效: ${uuid}`);
  const workspace = resolve(root, formatLocalDate(date), uuid);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(resolve(workspace, "outputs"), { recursive: true });
  mkdirSync(resolve(workspace, "work"), { recursive: true });
  return workspace;
}

export function ensureStandaloneCwd(cwd, { root = standaloneRoot() } = {}) {
  const workspace = standaloneWorkspaceRoot(cwd, { root });
  if (!workspace) throw new Error(`不是有效的 Codex 独立对话目录: ${cwd}`);
  const target = resolve(cwd);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(resolve(workspace, "outputs"), { recursive: true });
  mkdirSync(resolve(workspace, "work"), { recursive: true });
  mkdirSync(target, { recursive: true });
  return target;
}

export function normalizeStandaloneCwdAliases(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const aliases = {};
  for (const [source, destination] of Object.entries(value)) {
    if (typeof source !== "string" || typeof destination !== "string") continue;
    if (!source.trim() || !destination.trim()) continue;
    aliases[resolve(source)] = resolve(destination);
  }
  return aliases;
}

function pathIsAtOrBelow(source, target) {
  const rest = relative(resolve(source), resolve(target));
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
}

export function resolveStandaloneCwdAlias(cwd, aliases = {}) {
  const value = String(cwd || "").trim();
  if (!value) return "";
  const target = resolve(value);
  const normalized = normalizeStandaloneCwdAliases(aliases);
  let best = null;
  for (const [source, destination] of Object.entries(normalized)) {
    if (!pathIsAtOrBelow(source, target)) continue;
    if (!best || source.length > best.source.length) best = { source, destination };
  }
  if (!best) return value;
  const suffix = relative(best.source, target);
  return resolve(best.destination, suffix);
}

export function legacyDirectoryTarget(directory, { root = standaloneRoot(), date } = {}) {
  const uuid = basename(resolve(directory));
  if (!validUuid(uuid)) throw new Error(`旧独立对话目录名称不是 UUID: ${directory}`);
  const archiveDate = date || new Date();
  return resolve(root, formatLocalDate(archiveDate), uuid);
}

export { validDateSegment, validUuid };
