# Codex2Lark 项目规则

## 项目定位

- 本仓库用于开发和维护 codex2lark，桥接服务是本项目包含的运行组件。
- 飞书渠道特有的进度转发、文件交付和控制层约束由桥接在对应轮次中注入，不写入项目规则。

## GitHub 同步

- 远程项目地址：GitHub 仓库页面 `https://github.com/beifangzhishi-ops/codex2larkAOI`；Git 推送地址 `https://github.com/beifangzhishi-ops/codex2larkAOI.git`（本仓库远程名为 `origin`）。
- 本机（Songjx，game 机器）的所有更新提交后，统一推送到 GitHub 远程仓库的 `sjxgame` 分支；本机的 Codex 自动化与用户本人均可推送、维护 `sjxgame`。
- noha 机器的所有更新提交后，统一推送到 GitHub 远程仓库的 `noha` 分支；noha 机器上的自动化任务只操作 `noha` 和 `main`，不得推送、改写或同步 `sjxgame`。
- 本机（Songjx）只能动自己的 `sjxgame` 分支和 `main`，不能动其他分支（如 `noha`）。
- noha 机器只能动自己的 `noha` 分支和 `main`，不能动其他分支（如 `sjxgame`）。
- `main` 分支的合并必须经机器主人审核：各机器把稳定改动推送到自己的分支后，由该机器主人确认无误再合并进 `main`；自动化任务不直接推送 `main`。

### game 分支更新

- 本机从 `origin/main` 拉取稳定改动，合并进本地 `sjxgame` 分支，验证（`npm run check`）后推送到 `origin/sjxgame`；noha 机器以同样方式维护自己的 `noha` 分支。

### 合并到 main 的通用流程（两机通用）

1. 在自己的分支（`sjxgame` 或 `noha`）完成开发、测试、提交并推送。
2. 由该机器主人审核分支内容，确认可以进入稳定版。
3. 审核通过后，由机器主人执行：切到 `main` 拉取最新，合并自己的分支，解决冲突并验证，再推送 `origin/main`。
4. 合并完成后，各机器拉取 `origin/main` 更新自己的分支，避免后续合并冲突。

## AKA/AOI 双槽协作

- 只允许修改 AOI，禁止修改 AKA。
- 版本同步时，注意文本中的 AKA/AOI 互换。

## 参考 Hermes

- 只有当用户明确要求“参考 Hermes”“参考 Hermes 源码”或表达同等含义时，才查阅 Hermes 实现；普通开发任务不强制参考。
- 参考源使用 GitHub 官方仓库 `https://github.com/NousResearch/hermes-agent`，飞书相关实现优先查看 `gateway/platforms/feishu.py` 及仓库内对应测试和文档。
- 参考时只提取与当前需求直接相关且能验证的设计或实现，不自动复制 Hermes 专属行为、配置、提示词、`SOUL.md` 或工作流。
- 如果 Hermes 当前实现与本项目的 Codex App Server、`lark-cli` 架构或用户明确需求冲突，以本项目约束和用户需求为准，并说明差异。
