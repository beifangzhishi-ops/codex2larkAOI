# Codex2Lark 项目规则

## 项目定位

- 本仓库用于开发和维护 codex2lark，桥接服务是本项目包含的运行组件。
- 飞书渠道特有的进度转发、文件交付和控制层约束由桥接在对应轮次中注入，不写入项目规则。

## GitHub 同步

- 远程项目地址：GitHub 仓库页面 `https://github.com/beifangzhishi-ops/codex2larkAOI`；Git 推送地址 `https://github.com/beifangzhishi-ops/codex2larkAOI.git`（本仓库远程名为 `origin`）。
- 仓库只维护 `main` 一个长期/工作分支，不创建或维护 `beta`、feature/fix 等其他远程分支。
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
