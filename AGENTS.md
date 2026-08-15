# Codex2Lark 项目规则

## 项目定位

- 本仓库用于开发和维护 codex2lark，桥接服务是本项目包含的运行组件。
- 飞书渠道特有的进度转发、文件交付和控制层约束由桥接在对应轮次中注入，不写入项目规则。

## GitHub 同步

- 远程项目地址：GitHub 仓库页面 `https://github.com/beifangzhishi-ops/codex2larkAOI`；Git 推送地址 `https://github.com/beifangzhishi-ops/codex2larkAOI.git`（本仓库远程名为 `origin`）。
- 所有更新默认推送到 GitHub 远程仓库的 `beta` 分支；各机器的 Codex 自动化与用户本人均可推送、维护 `beta`。
- 只能操作 `beta` 分支和 `main`，不能操作其他分支。
- `main` 为稳定分支：只有用户明确指令时才合并到 `main`；自动化任务不主动推送 `main`。

### beta 分支更新

- 所有机器从 `origin/main` 拉取稳定改动，合并进本地 `beta` 分支，验证（`npm run check`）后推送到 `origin/beta`。

### 合并到 main 的流程

1. 在 `beta` 分支完成开发、测试、提交并推送 `origin/beta`。
2. 用户明确指令合并到 `main` 后，执行：切到 `main` 拉取最新，合并 `beta`，解决冲突并验证，再推送 `origin/main`。
3. 合并完成后，各机器拉取 `origin/main` 合并进 `beta`，避免后续合并冲突。

## AKA/AOI 双槽协作

- 只允许修改 AOI，禁止修改 AKA。
- 版本同步时，注意文本中的 AKA/AOI 互换。

## 参考 Hermes

- 只有当用户明确要求“参考 Hermes”“参考 Hermes 源码”或表达同等含义时，才查阅 Hermes 实现；普通开发任务不强制参考。
- 参考源使用 GitHub 官方仓库 `https://github.com/NousResearch/hermes-agent`，飞书相关实现优先查看 `gateway/platforms/feishu.py` 及仓库内对应测试和文档。
- 参考时只提取与当前需求直接相关且能验证的设计或实现，不自动复制 Hermes 专属行为、配置、提示词、`SOUL.md` 或工作流。
- 如果 Hermes 当前实现与本项目的 Codex App Server、`lark-cli` 架构或用户明确需求冲突，以本项目约束和用户需求为准，并说明差异。
