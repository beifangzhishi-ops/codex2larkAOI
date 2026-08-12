# Codex 写入锁冲突排查记录

记录日期：2026-08-11
状态：已解决（最终采用共享 Codex App Server 方案；旧内核方案已弃用）

> **弃用说明（2026-08-11）**：本记录中的旧内核 CodexLegacy 方案已弃用，AOI 最终采用仓库的共享 Codex App Server 方案（见 README“共享 Codex app-server”一节）。以下内容仅保留排查过程。

## 一、问题现象

飞书桥接执行 `/resume` 恢复历史会话时，飞书回复：

```text
最近一轮读取失败：thread/resume: thread <id> already has an active writer
```

本机桌面 Codex 打开过的历史会话全部无法从飞书恢复。

## 二、环境与版本

| 项目 | 本机（Songjx） | noha |
|---|---|---|
| 桥接源码 | 同一份（原样拷贝，未修改） | 同一份 |
| 桌面端 | Codex 桌面 App 26.803.5235（WindowsApps，内置 codex 0.147.0-alpha.6.5） | VS Code Codex 扩展 |
| 桥接 Codex 内核 | 排查期间依次使用：独立 CLI 0.147.0 稳定版 → 扩展 26.803.41515 内置 0.147.0-alpha.6.5 → 最终固定为 CodexLegacy 0.146.0-alpha.9.2 | 运行中的旧桥接实际使用已删除扩展 26.727.40816 内置 0.146.0-alpha.9.2 |
| 数据目录 | `C:\Users\Songjx\.codex` | `C:\Users\noha\.codex` |

## 三、根因分析

### 写入锁机制

Codex 自 2026-07-23 起（提交 "Enforce single-writer ownership for paginated threads"，编号 #34986）引入 thread 单写入者锁：

- 锁文件：`~/.codex/thread-writer-locks/<thread_id>.lock`，使用操作系统文件锁（Windows 为 LockFileEx）；
- 实现源码：`codex-rs/thread-store/src/local/writer_lock.rs`；
- 会话打开（`thread/start` 或 `thread/resume` 建立 live recorder）即持锁，直到会话关闭（`shutdown_thread` / `discard_thread`）或进程退出才释放；
- 另一个进程 resume 同一线程时 `try_lock` 失败，报 `thread <id> already has an active writer`。

### 实测结论

1. 两个进程使用完全相同的 0.147.0-alpha.6.5 内核，A 创建线程并跑完一轮 turn（连接保持），B resume 同一线程仍报 active writer。因此不是稳定版/alpha 版差异。
2. 旧版 0.146.0-alpha.9.2 跑完 turn 后锁文件会删除（释放）；0.147.0-alpha.6.5 跑完 turn 后锁仍被持有（只要 App Server 连接保持）。
3. 本机桌面 App 打开过的历史会话，锁文件全部存在且被占用（桌面 App 保持所有打开过的会话为 live writer）。
4. 旧版 0.146.0-alpha.9.2 能正常读取新版 0.147.0-alpha.6.5 创建的线程（历史轮次完整可读）；0.147.0 稳定版与 alpha 系列线程格式存在差异（曾出现 `no rollout found`）。

## 四、noha 对比排查结论

noha 机器不是特例：

- noha 运行中的 AOI 桥接实际拉起的是**已删除的旧扩展 26.727.40816 里的 codex.exe（0.146.0-alpha.9.2）**；旧内核跑完 turn 不持久占锁，所以飞书和桌面看起来能共用同一会话。
- 旧扩展目录已于 8/10 扩展更新时删除，进程是启动时加载进内存的；桥接一旦重启，自动发现逻辑会选中新扩展 26.803.41515 内置的 0.147.0-alpha.6.5。
- noha 重启 AOI 后同样复现 `already has an active writer`。
- noha 上桌面 App（WindowsApps）与桥接是三个独立 codex app-server 进程，无共享 daemon/control socket，`~/.codex/app-server-control` 不存在。

## 五、解决方案

桥接使用旧版 Codex 内核（0.146.0-alpha.9.2）：

- 旧内核部署位置：`C:\Users\Songjx\AppData\Local\Programs\CodexLegacy\codex.exe`（从已删除扩展 26.727.40816 提取，不会被 VS Code 更新覆盖）；
- `.env` 配置：`CODEX_COMMAND=C:\Users\Songjx\AppData\Local\Programs\CodexLegacy\codex.exe`；
- 旧内核跑完一轮任务后释放写入锁，飞书用完会话后桌面可以再接回同一个 thread，实现“飞书和桌面共用同一会话”（同一时间只有一个写入者，交替使用，不创建副本）。

## 六、使用方式与边界

1. 桌面 Codex 里**关闭**想从飞书继续的会话（不关闭则锁仍在桌面手里，任何版本 resume 都会失败）；
2. 飞书 `/resume` 同一个会话，继续原 thread，不创建副本；
3. 飞书任务跑完后，旧内核自动释放锁，桌面可以重新打开同一会话继续；
4. 桌面 App 打开着会话时，飞书 resume 仍会报 active writer（锁在桌面进程手里），这是 Codex 单写入者机制的统一行为。

## 七、回退与后续

- 想换回新版内核：修改 `.env` 的 `CODEX_COMMAND` 指向新版 codex.exe 后重启桥接即可；
- 旧内核不在官方维护路径，后续如需跟随新版 Codex，需重新评估写入锁冲突（例如等待官方提供空闲释放或共享 App Server 实例的能力）；
- 若使用 VS Code 扩展作为桥接内核，注意扩展更新后旧目录会被删除，避免桥接指向已删除路径。
- 2026-08-11 当天稍后，仓库已改用共享 Codex App Server（WebSocket）方案，旧内核方案弃用；本机不再使用 CodexLegacy。

## 八、相关路径与命令速查

```text
锁目录：            %USERPROFILE%\.codex\thread-writer-locks\
控制 socket 目录：  %USERPROFILE%\.codex\app-server-control\（当前不存在）
桥接日志：          .state\bridge.out.log / .state\bridge.err.log
旧内核：            %LOCALAPPDATA%\Programs\CodexLegacy\codex.exe
```

```powershell
# 查看桥接实际使用的 codex 路径（启动日志）
Get-Content .state\bridge.out.log | Select-String "\[bridge\] codex"

# 查看当前锁文件
Get-ChildItem "$env:USERPROFILE\.codex\thread-writer-locks" -Filter "*.lock"

# 重启桥接
.\stop.cmd --no-pause-on-error
.\start.cmd --no-pause-on-error
```
