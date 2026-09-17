import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const requiredFiles = [
  "codex.exe", "codex-code-mode-host.exe",
  "codex-command-runner.exe", "codex-windows-sandbox-setup.exe",
];

export function readRuntime(executable) {
  const directory = path.dirname(executable);
  const missing = requiredFiles.filter((name) => {
    try { const stat = fs.statSync(path.join(directory, name)); return !stat.isFile() || stat.size === 0; }
    catch { return true; }
  });
  if (missing.length) return { executable, missing };
  // 同目录的 Codex 程序和动态库一起保存，避免只复制主程序。
  const names = fs.readdirSync(directory).filter((name) => /^(codex.*\.exe|.*\.dll)$/i.test(name)).sort();
  const files = names.map((name) => ({
    name, hash: crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, name))).digest("hex"),
  }));
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { executable, missing, files, fingerprint, modified: fs.statSync(executable).mtimeMs };
}

export function selectRuntime({ primary = [], fallback = [] }) {
  const rejected = [];
  for (const group of [primary, fallback]) {
    const complete = [];
    for (const executable of new Set(group)) {
      try {
        const runtime = readRuntime(executable);
        if (!runtime.missing.length) complete.push(runtime);
        else rejected.push({ executable, reason: `缺少或为空：${runtime.missing.join("、")}` });
      } catch (error) { rejected.push({ executable, reason: error.message }); }
    }
    complete.sort((a, b) => b.modified - a.modified);
    if (complete.length) return { selected: complete[0], rejected };
  }
  return { selected: null, rejected };
}

export function prepareRuntime(selected, root) {
  if (!selected) throw new Error("未发现完整 Codex 运行时，请更新或修复桌面端安装。");
  const destination = path.join(path.resolve(root), selected.fingerprint);
  const executable = path.join(destination, "codex.exe");
  if (fs.existsSync(destination)) {
    if (readRuntime(executable).fingerprint !== selected.fingerprint) {
      throw new Error(`独立运行时校验失败，保留原目录以免影响正在运行的进程：${destination}`);
    }
    return { ...selected, source: selected.executable, executable };
  }
  fs.mkdirSync(root, { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.resolve(root), ".staging-"));
  try {
    for (const { name } of selected.files) {
      fs.copyFileSync(path.join(path.dirname(selected.executable), name), path.join(staging, name));
    }
    if (readRuntime(path.join(staging, "codex.exe")).fingerprint !== selected.fingerprint) {
      throw new Error("复制期间源运行时发生变化，请重新启动共享服务以再次发现完整版本。");
    }
    fs.writeFileSync(path.join(staging, "来源.json"), JSON.stringify({ 来源: selected.executable, 指纹: selected.fingerprint }, null, 2));
    // Windows 扫描新复制的程序时可能暂时锁定目录，仅对占用类错误有限重试。
    for (let attempt = 0; ; attempt += 1) {
      try { fs.renameSync(staging, destination); break; }
      catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 6) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (2 ** attempt));
      }
    }
  } finally {
    // staging 由本函数在指定运行时根目录内创建，绝不清理其他版本或源目录。
    if (path.dirname(path.resolve(staging)) !== path.resolve(root)) throw new Error("临时目录超出运行时根目录。");
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { ...selected, source: selected.executable, executable };
}

export function runtimeStatus(selected, activeExecutable, root) {
  if (!activeExecutable) return { active: null, updateAvailable: false, managed: false };
  const active = readRuntime(activeExecutable);
  const relative = path.relative(path.resolve(root), path.resolve(activeExecutable));
  const managed = relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const integrityError = managed && active.fingerprint && path.basename(path.dirname(activeExecutable)) !== active.fingerprint;
  return { active, managed, integrityError: Boolean(integrityError), updateAvailable: Boolean(selected && active.fingerprint !== selected.fingerprint) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = JSON.parse(fs.readFileSync(0, "utf8").replace(/^\uFEFF/, ""));
    const result = selectRuntime(request.candidates);
    if (process.argv[2] === "prepare") result.prepared = prepareRuntime(result.selected, request.runtimeRoot);
    else if (process.argv[2] === "inspect") Object.assign(result, runtimeStatus(result.selected, request.activeExecutable, request.runtimeRoot));
    else throw new Error("运行时检查命令无效。");
    process.stdout.write(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
