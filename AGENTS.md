# Codex2Lark 项目规则

## 项目定位

- 本仓库用于开发和维护 codex2lark，桥接服务是本项目包含的运行组件。
- 飞书渠道的进度转发、文件交付与控制行为由桥接程序负责；普通业务轮次不额外注入渠道提示词。
- 自动生成会话标题使用独立临时线程及专用提示词，与普通业务轮次分离。

## 停止指令与运行配置

- `/stop` 只允许操作发出时绑定的会话与已有任务，校验原始飞书时间，禁止过期指令误中断随后启动的新轮次，也不能清除其后排队的消息。
- AOI 运行配置以各自 `.env` 为准；单轮执行超时统一设置为 259200000 毫秒（三天），不要只修改代码默认值。
- 配置共享 WebSocket 时，AOI 应在后端缺席时仍启动飞书监听，后台持续重连，不得自动启动独立 App Server。共享服务恢复时自动恢复订阅及交付；主动停止后不再重连。
- 6v 的 `Codex2Lark-AOI` 计划任务只负责登录后启动 AOI 桥接，不启动共享 Codex 或桌面端。部署入口为 `scripts/install-aoi-logon-task.ps1`，启动检查脚本为 `scripts/ensure-aoi-running.js`。
- 运行态仍有任务时不得直接重启桥接来激活配置，应先确认空闲。
- 安全重启入口 `scripts/restart-when-idle.js` 必须在连续确认绑定会话空闲后，通过 Node 直接调用 `src/service-control.js` 的 `stop` 和 `launch`，避免依赖 Windows `cmd.exe` 的引号拼接；不得停止共享 App Server。
- AOI 重启后的飞书事件就绪判断以实际日志的两个 `[event] ready event_key=...` 标记为准。已重启的 AOI 用 `scripts/restart-when-idle.js --verify` 单独验证，不应为了修正验收结果重复重启。

## /resume 会话列表

- 历史会话使用 Codex App Server 的 `thread/list`，按 `recency_at` 降序查询，并显示对应的 `recencyAt` 时间，不能用受元数据写入影响的 `updatedAt` 代替。
- 分页使用 App Server 游标，每页最多五个不同会话；同一会话 ID 在列表及跨页只能出现一次，重复记录须继续翻游标补齐本页。

## GitHub 同步

- 远程项目地址：GitHub 仓库页面 `https://github.com/beifangzhishi-ops/codex2larkAOI`；Git 推送地址 `https://github.com/beifangzhishi-ops/codex2larkAOI.git`（本仓库远程名为 `origin`）。
- 仓库只维护 `main` 一个长期/工作分支，不创建或维护其他远程分支。
- 所有机器和自动化开始工作前先同步 `origin/main`；开发和验证通过后直接提交并推送到 `origin/main`。
- 推送前必须运行 `npm run check`；如果当前环境无法运行，必须明确说明原因和未验证范围。
- 禁止 force push 覆盖其他机器的新提交。推送被拒绝时，先重新同步 `origin/main`，解决冲突并重新验证。
- 如发现历史遗留的其他远程分支，先确认其独有提交已经进入 `main`，再删除该分支；不要继续在遗留分支工作。

### main 更新流程

1. `git fetch origin`，切换到 `main` 并以 fast-forward 方式同步 `origin/main`。
2. 完成修改后运行 `npm run check`。
3. 验证通过后提交，并推送到 `origin/main`。
4. 如果推送时发现远端已有新提交，重新同步、解决冲突并再次运行检查后再推送；不要强推。

## AKA/AOI 双槽协作

- 只允许修改 AOI，禁止修改 AKA。
- 版本同步时，注意文本中的 AKA/AOI 互换。

## 参考 Hermes

- 只有当用户明确要求“参考 Hermes”“参考 Hermes 源码”或表达同等含义时，才查阅 Hermes 实现；普通开发任务不强制参考。
- 参考源使用 GitHub 官方仓库 `https://github.com/NousResearch/hermes-agent`，飞书相关实现优先查看 `gateway/platforms/feishu.py` 及仓库内对应测试和文档。
- 参考时只提取与当前需求直接相关且能验证的设计或实现，不自动复制 Hermes 专属行为、配置、提示词、`SOUL.md` 或工作流。
- 如果 Hermes 当前实现与本项目的 Codex App Server、`lark-cli` 架构或用户明确需求冲突，以本项目约束和用户需求为准，并说明差异。

## Shared-stack launcher ownership
- AOI is strictly a WebSocket client of the shared Codex App Server. It never launches a local Codex backend, cannot choose an independent Codex executable and must preserve offline reconnect plus thread recovery. Desktop window presence is not required; the shared backend comes solely from a complete Codex Desktop runtime through the shared launcher.
- Shared Codex backend kernel selection is Desktop-only: discover latest complete runtime from the Codex Desktop-managed cache and the installed Microsoft Store Codex package. Do not select a separate IDE/CLI runtime. Keep the fingerprinted independent running copy and never replace an active backend merely because Desktop updated. Apply the same source contract in CodexMobileUI and both AOI machines.
- Desktop launcher diagnostics must stream shared-stack progress live, not buffer all child output before reporting errors. Clash TCP availability probes must have explicit short timeouts and no lingering console progress; preserve phase markers for runtime, backend and proxy startup.
- Desktop is a single frontend per host. All AOI/CodexMobileUI Desktop launchers must use the same cross-checkout Desktop launch mutex spanning process detection, shared-stack attach/start, launch, and verification. An existing Desktop prevents a second launch; never stop an existing Desktop merely to attach another client.
- Shared App Server must remain running when Desktop closes. Desktop exit does not imply stop; only explicit owner-authorized shared-stop may terminate the shared processes.
- Shared stack launchers in AOI and CodexMobileUI must use the same 45789/45790 proxy/backend contract and the cross-checkout Windows mutex.
- Only the checkout that launched a process may stop it. Ownership is checked from the checkout-local PID file and the actual command/executable path. A second launcher hot-attaches only after verifying both listeners and readiness.
- A failed health/identity check must not kill or replace foreign processes. Do not restart the shared stack to restart the Feishu bridge or Mobile Gateway.
- Before explicit shutdown of an owned shared stack, check for active turns and other attached clients; explicit stop disconnects all clients.
- When launcher behavior changes, also update CodexMobileUI's standalone source copies and synchronize AOI main to 6v and noha. Do not introduce an AOI runtime dependency into CodexMobileUI.
