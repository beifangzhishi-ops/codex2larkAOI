import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requiredFiles, readRuntime, selectRuntime, prepareRuntime, runtimeStatus } from "../scripts/shared-runtime.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "共享运行时测试-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const make = (name, version, modified) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    for (const file of requiredFiles) fs.writeFileSync(path.join(dir, file), `${version}:${file}`);
    const executable = path.join(dir, "codex.exe");
    fs.utimesSync(executable, modified, modified);
    return executable;
  };
  return { root, make, cache: path.join(root, "独立副本") };
}

test("自动发现完整新版，跳过缺文件版本，桌面版本优先于扩展", (t) => {
  const { make } = fixture(t);
  const older = make("旧桌面", "v1", 1000);
  const newer = make("新桌面", "v2", 2000);
  const broken = make("不完整版本", "v3", 3000);
  const extension = make("扩展", "v4", 4000);
  fs.unlinkSync(path.join(path.dirname(broken), "codex-code-mode-host.exe"));
  const result = selectRuntime({ primary: [older, broken, newer], fallback: [extension] });
  assert.equal(result.selected.executable, newer);
  assert.match(result.rejected[0].reason, /codex-code-mode-host/);
  assert.equal(selectRuntime({ primary: [broken], fallback: [extension] }).selected.executable, extension);
});

test("桌面清理源工具后独立副本仍完整，重复准备可复用", (t) => {
  const { root, make, cache } = fixture(t);
  const source = make("桌面源", "v1", 1000);
  const selected = readRuntime(source);
  const saved = prepareRuntime(selected, cache);
  assert.equal(prepareRuntime(selected, cache).executable, saved.executable);
  const sourceDirectory = path.dirname(source);
  assert.equal(path.dirname(sourceDirectory), root);
  fs.rmSync(sourceDirectory, { recursive: true });
  assert.deepEqual(readRuntime(saved.executable).missing, []);
  assert.equal(readRuntime(saved.executable).fingerprint, selected.fingerprint);
  assert.equal(runtimeStatus(null, saved.executable, cache).managed, true);
});

test("新版使用不同目录，保留正在使用的旧副本并报告更新", (t) => {
  const { make, cache } = fixture(t);
  const old = prepareRuntime(readRuntime(make("旧源", "v1", 1000)), cache);
  const latest = readRuntime(make("新源", "v2", 2000));
  const status = runtimeStatus(latest, old.executable, cache);
  assert.equal(status.updateAvailable, true);
  const next = prepareRuntime(latest, cache);
  assert.notEqual(old.executable, next.executable);
  assert.equal(readRuntime(old.executable).fingerprint, old.fingerprint);
  assert.equal(runtimeStatus(latest, next.executable, cache).updateAvailable, false);
});

test("复制期间源内容变化时拒绝发布，临时文件清理完成", (t) => {
  const { make, cache } = fixture(t);
  const source = make("源", "v1", 1000);
  const selected = readRuntime(source);
  fs.writeFileSync(path.join(path.dirname(source), "codex-code-mode-host.exe"), "已变化");
  assert.throws(() => prepareRuntime(selected, cache), /源运行时发生变化/);
  assert.deepEqual(fs.readdirSync(cache), []);
});

test("副本损坏时报告错误，保留原文件且不覆盖运行中的程序", (t) => {
  const { make, cache } = fixture(t);
  const selected = readRuntime(make("源", "v1", 1000));
  const saved = prepareRuntime(selected, cache);
  const helper = path.join(path.dirname(saved.executable), "codex-code-mode-host.exe");
  fs.writeFileSync(helper, "损坏");
  assert.equal(runtimeStatus(selected, saved.executable, cache).integrityError, true);
  assert.throws(() => prepareRuntime(selected, cache), /校验失败/);
  assert.equal(fs.readFileSync(helper, "utf8"), "损坏");
  fs.unlinkSync(helper);
  assert.deepEqual(runtimeStatus(selected, saved.executable, cache).active.missing, ["codex-code-mode-host.exe"]);
});

test("没有完整运行时时明确失败，空工具文件也不能使用", (t) => {
  const { make, cache } = fixture(t);
  const source = make("源", "v1", 1000);
  fs.writeFileSync(path.join(path.dirname(source), "codex-command-runner.exe"), "");
  const result = selectRuntime({ primary: [source] });
  assert.equal(result.selected, null);
  assert.throws(() => prepareRuntime(result.selected, cache), /未发现完整/);
  assert.equal(fs.existsSync(cache), false);
});

test("Windows 短暂占用新副本时重试目录改名", (t) => {
  const { make, cache } = fixture(t);
  const selected = readRuntime(make("源", "v1", 1000));
  const originalRename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, "renameSync", (...args) => {
    if (attempts++ === 0) throw Object.assign(new Error("临时占用"), { code: "EPERM" });
    return originalRename(...args);
  });
  const saved = prepareRuntime(selected, cache);
  assert.equal(attempts, 2);
  assert.equal(readRuntime(saved.executable).fingerprint, selected.fingerprint);
});
