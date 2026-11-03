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
