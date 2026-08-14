# Codex2Lark 项目规则

## 项目定位

- 本仓库用于开发和维护 codex2lark，桥接服务是本项目包含的运行组件。
- 飞书渠道特有的进度转发、文件交付和控制层约束由桥接在对应轮次中注入，不写入项目规则。

## GitHub 同步

- 远程项目地址：GitHub 仓库页面 `https://github.com/beifangzhishi-ops/codex2larkAOI`；Git 推送地址 `https://github.com/beifangzhishi-ops/codex2larkAOI.git`（本仓库远程名为 `origin`）。
- 本机（Songjx，game 机器）的所有更新提交后，统一推送到 GitHub 远程仓库的 `sjxgame` 分支。
- noha 机器的所有更新提交后，统一推送到 GitHub 远程仓库的 `noha` 分支。
- 本机（Songjx）只能动自己的 `sjxgame` 分支和 `main`，不能动其他分支（如 `noha`）。
- noha 机器只能动自己的 `noha` 分支和 `main`，不能动其他分支（如 `sjxgame`）。
- `main` 为稳定汇合点：稳定改动需经用户明确确认，由自动化任务合并、验证并推送；未获确认前自动化不推送 `main`。
- `main` 的稳定内容由各机器自行拉取合并进自己的分支（`git fetch origin` 后 `git merge origin/main`，验证后推送本机分支）。

## AKA/AOI 双槽协作

- 只允许修改 AOI，禁止修改 AKA。
- 版本同步时，注意文本中的 AKA/AOI 互换。

## 参考 Hermes

- 只有当用户明确要求“参考 Hermes”“参考 Hermes 源码”或表达同等含义时，才查阅 Hermes 实现；普通开发任务不强制参考。
- 参考源使用 GitHub 官方仓库 `https://github.com/NousResearch/hermes-agent`，飞书相关实现优先查看 `gateway/platforms/feishu.py` 及仓库内对应测试和文档。
- 参考时只提取与当前需求直接相关且能验证的设计或实现，不自动复制 Hermes 专属行为、配置、提示词、`SOUL.md` 或工作流。
- 如果 Hermes 当前实现与本项目的 Codex App Server、`lark-cli` 架构或用户明确需求冲突，以本项目约束和用户需求为准，并说明差异。
