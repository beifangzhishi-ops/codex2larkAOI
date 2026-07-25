# AOI 功能更新需求

## 1. 文档目的

本文记录从 codex2larkAKA 选择性迁移到 codex2larkAOI 的功能，以及 AOI 后续独立改进项。后续按阶段、小步实施，每一阶段单独补充测试、更新中文文档并提交，避免一次性大范围同步 AKA。

## 2. 总体边界

- 只修改 AOI，不修改 AKA。
- 不直接覆盖 AKA 的 `bridge.js`；按本文件确认的行为逐项迁移。
- 保留 AOI 专属能力：
  - `start.cmd`、`stop.cmd` 和 `src/service-control.js` 服务控制；
  - `CODEX_COMMAND` 配置及 Codex 可执行文件自动发现；
  - 飞书渠道规则通过 `turn/start.additionalContext` 按轮次注入；
  - AOI 的事件消费者就绪检查、后台启动和安全停止逻辑；
  - AOI 与 AKA 的飞书 App、`lark-cli` 配置和运行状态隔离。
- 不迁移 AKA 的槽位专属服务策略、旧脚本或已删除功能。
- 不增加 `/plan`。AKA 的一次性计划模式当前存在已知问题，本轮明确放弃。

## 3. 已确认的功能取舍

### 3.1 迁移功能

1. `/model` 模型和思考强度控制
   - 使用 App Server `model/list` 动态读取可用模型，不硬编码模型列表。
   - `/model` 显示模型卡片，再显示该模型支持的思考强度。
   - 支持 `/model default`、`/model <model-id>` 和 `/model <model-id> <effort>`。
   - 设置按飞书聊天持久化，只影响设置完成后的任务。
   - 模型下线或设置失效时安全回退到 Codex/部署默认值，并明确告知用户。

2. `/screen` 主机截屏
   - 仅支持 Windows 桥接主机。
   - 截取虚拟桌面，作为图片回复当前飞书消息。
   - 临时图片发送完成后删除；失败时返回可读错误。
   - 只响应授权用户发出的完整 `/screen` 命令。

3. Codex Auto-review 审批语义
   - `auto` 使用 App Server 的 `approvalsReviewer: "auto_review"`。
   - `manual` 使用 `approvalsReviewer: "user"`。
   - `approvalPolicy` 继续要求按需审批，不把 `auto` 实现为无条件放行。
   - 切换审批模式只影响后续任务，不自动批准已经发出的人工审批请求。
   - AOI 仍保持工作区写入沙箱，Auto-review 不扩大文件或网络权限。

4. `/help` 和 `/status` 增强
   - `/help` 增加继续会话、模型设置、审批切换、状态、截屏和停止操作入口。
   - 不显示或解析 `/plan`。
   - `/status` 显示工作目录、会话名、thread ID、审批方式、下一轮模型、思考强度和设置来源。
   - 卡片发送失败时保留完整的中文文本回退。

5. thread 标题可靠性
   - 新 thread 第一条任务生成简短标题，不额外调用模型。
   - `thread/name/set` 失败后保留待设置标题，在后续合适时机重试。
   - 成功后清除待重试状态，避免每轮重复命名。

### 3.2 明确保留 AOI 行为

`/new` 保持 AOI 语义：

- 立即清除当前聊天绑定的 thread 和相关恢复候选；
- 保留当前工作目录、审批模式和模型设置；
- 不在执行 `/new` 时创建空 thread；
- 下一条普通任务到达时再调用 `thread/start` 创建新 thread；
- 原 thread 中已经运行的任务不因 `/new` 自动中断。

### 3.3 采用 AKA 行为

`/cd` 采用 AKA 的目录与会话语义：

- 只接受完整 `/cd <路径或分层名称>`；
- 先从当前目录、再从 `CODEX_WORKDIR` 根目录开始逐层匹配；
- 每一层按不区分大小写的“精确、前缀、包含”顺序匹配；
- 匹配到多个目录时返回候选，不自行猜测；
- 成功切换目录后立即创建并选中新 thread；
- 创建失败时原子恢复之前的目录和 thread 绑定；
- 原 thread 中已经运行的任务继续运行并回复原飞书消息。

控制命令采用 AKA 的严格识别语义：

- 只把完整斜杠命令识别为控制命令；
- 删除“停止执行”“改为自动审批”“切换到某项目”等自然语言控制别名；
- 未识别的自然语言始终作为普通任务交给 Codex；
- 卡片按钮与对应斜杠命令必须走相同控制逻辑。

## 4. `/resume` 后回放最近一轮对话

### 4.1 用户行为

用户通过命令或卡片成功选择历史 thread 后，桥接依次发送：

1. 恢复成功信息，包括会话名和工作目录；
2. 标题为“最近一轮对话”的文本回放。

重新选择当前 thread 时也发送最近一轮对话，不只回复“已经在该会话中”。

### 4.2 历史读取

- 未加载 thread 时优先复用 `thread/resume` 返回的 `thread.turns`。
- 已加载 thread、当前 thread 或响应没有 turns 时，调用 `thread/read`，并设置 `includeTurns: true`。
- 不依赖实验性的 `thread/turns/list`，除非后续确认稳定 API 已满足需求。
- 读取失败不撤销已经成功完成的 thread 切换；恢复确认后单独提示“最近一轮读取失败”。

### 4.3 最近一轮选择

- 按 turn 的时间和返回顺序确定真正的最后一轮。
- 不因最后一轮失败、中断或没有最终答复而静默跳到更早轮次。
- 没有 turns 时显示“该会话还没有对话记录”。
- 最后一轮没有最终答复时仍显示其用户输入，并注明“该轮没有最终答复”。

### 4.4 允许发送的内容

- `userMessage` 中的文本输入；
- 非文本输入使用简短占位说明，例如“[图片]”“[音频]”；
- `agentMessage.phase === "final_answer"` 的最终答复；
- 为兼容旧记录，可接受 `phase` 缺失但属于最终完成项的 agent message；
- 如果计划类历史 turn 没有 agent final，可使用已完成的最终 `plan` item 作为该轮结果。

### 4.5 必须过滤的中间过程

- `agentMessage.phase === "commentary"`；
- reasoning、reasoning summary 和原始推理内容；
- command execution、file change、MCP、动态工具、协作工具、网页搜索等工具项；
- item delta、命令输出、计划 delta 和其他流式过程；
- 审批请求、审批结果和过程状态提示。

历史最终答复中的 `FILE:`、`MEDIA:` 和本地文件链接只作为文本清理，不自动重新发送历史附件。

### 4.6 文本格式

建议格式：

```text
最近一轮对话

用户：...

Codex：...
```

复用 AOI 当前的飞书长文本分段能力，不能因回放内容较长而超过单条消息限制。

## 5. 斜杠命令立即处理

### 5.1 目标

所有已识别的斜杠命令及其卡片回调都不等待正在运行的 Codex turn 完成。当前普通任务运行期间，用户应能立即执行：

- `/help`、`/status`、`/screen`；
- `/cd`、`/new`、`/resume`；
- `/model`；
- `/approval auto|manual`、`/approve`、`/approve session`、`/deny`；
- `/stop`。

### 5.2 调度结构

不能简单地让所有命令并发调用状态修改逻辑，否则连续发送 `/new`、`/cd` 和普通任务时会发生选错 thread 的竞态。应改为两级队列：

1. `chatRouteQueues`
   - 按 `chatId` 短时串行处理所有消息的选路。
   - 控制命令在该队列内完成读取或状态修改，然后立即释放队列。
   - 普通任务只在该队列内确定 thread、目录、审批和模型设置快照，再投递到 thread 队列。
   - 不在路由队列内等待 Codex turn 完成。

2. `threadQueues`
   - 按 `threadId` 保存明确的待执行任务数组，不使用无法清空的长 Promise 链。
   - 同一 thread 的普通任务严格串行。
   - 不同 thread 可以并行运行；每个结果和过程消息仍回复各自原始飞书消息。

3. 活动状态
   - `activeThreads` 按 `threadId` 保存活跃 turn。
   - 按 `chatId` 记录该聊天仍在后台运行的 thread 集合，不能继续使用只能保存一个任务的 `activeChats` 作为唯一事实来源。
   - App Server 通知、审批和最终结果始终按 `threadId` 路由。

### 5.3 到达顺序

- 同一聊天内，控制命令和普通消息必须按桥接收到事件的顺序完成选路。
- `/new` 后紧接的普通任务必须进入延迟创建的新 thread。
- `/cd` 后紧接的普通任务必须进入目标目录中新建的 thread。
- `/resume` 后紧接的普通任务必须进入恢复后的 thread。
- `/model` 或审批模式切换后紧接的普通任务使用新设置。
- 已经投递到 thread 队列的任务使用投递时快照，不被后续设置追溯修改。

### 5.4 `/stop` 行为

- `/stop` 立即作用于当前选中的 thread。
- 原子阻止该 thread 继续出队，并清空尚未开始的任务。
- 有活跃 turn 时调用 `turn/interrupt`；没有活跃 turn 时只清空队列。
- 回复是否中断活跃任务以及清除了多少条排队消息。
- 不停止已经切换离开的其他后台 thread，也不停止桥接服务。
- `/new` 后尚未创建新 thread 时，当前选择为空；此时 `/stop` 不应误停已经切换离开的旧 thread。

### 5.5 卡片行为

- 模型、恢复、审批、状态和停止按钮与斜杠命令进入同一个 `chatRouteQueues`。
- 恢复和模型卡片翻页不等待 Codex turn。
- 卡片回调与文本命令之间仍按到达顺序修改状态。
- 所有卡片回调继续校验操作人、动作类型和参数，不信任客户端提交的 thread、模型或 effort。

## 6. 状态持久化

在现有 `.state/sessions.json` 兼容基础上增加或维护：

- `modelSettings`：聊天级模型策略和思考强度；
- `pendingThreadTitles`：待重试的 thread 标题；
- 原有 `sessions`、`workdirs`、`approvalModes`、`pendingWorkdirQueries` 和 `events` 需向后兼容读取。

运行时队列、活跃 turn、恢复候选和审批请求不直接持久化。服务重启后不得把旧运行态误认为仍然活跃。

## 7. 分阶段实施建议

### 阶段 1：调度基础

- 引入 `chatRouteQueues`、`threadQueues` 和按 thread 的活动状态。
- 保持现有用户功能不变，先完成普通任务串行、跨 thread 并行和通知路由测试。
- 实现 `/stop` 清空当前 thread 待执行任务。

### 阶段 2：严格命令与即时控制

- 删除自然语言控制别名。
- 将所有斜杠命令和控制卡片迁入短时路由队列。
- 保持 `/new` 的 AOI 延迟建 thread 行为。
- 迁移 AKA 的 `/cd` 逐层匹配和新建 thread 行为。

### 阶段 3：Resume 回放

- 实现最近一轮提取、最终消息过滤和中文格式化。
- 接入命令选择、卡片选择和重新选择当前 thread 三条路径。
- 覆盖空历史、失败 turn、旧记录无 phase 和读取失败。

### 阶段 4：审批语义

- 接入 `approvalsReviewer`。
- 修正 `/approval`、审批卡片和状态文字。
- 验证 Auto-review 不扩大沙箱权限、不处理既有人工审批。

### 阶段 5：模型控制与标题重试

- 迁移 `/model`、模型卡片、effort 卡片、设置持久化和安全回退。
- 普通任务按选路时的模型设置快照运行。
- 增加 thread 标题持久化重试。
- 更新 `/status`。

### 阶段 6：截屏与帮助界面

- 迁移 `/screen`，完成临时文件清理和失败处理。
- 更新 `/help` 卡片与文本回退。
- 完成 README 和配置说明的最终整理。

每一阶段完成后都运行完整测试并独立提交，不把后续阶段未完成的状态字段或用户入口提前暴露。

## 8. 测试与验收

至少覆盖以下场景：

1. 长任务运行时，`/help`、`/status`、`/model`、`/screen`、`/resume` 和 `/cd` 能及时响应。
2. 连续发送控制命令和普通任务时，普通任务使用其前面最近一次已完成控制操作确定的 thread 与设置。
3. 同一 thread 的多个任务不并发；不同 thread 的任务可以并发，结果不会串到其他飞书消息。
4. `/stop` 中断当前选中 thread 并清空其排队任务，不影响后台其他 thread。
5. `/new` 不创建空 thread；下一条任务创建新 thread。
6. `/cd` 成功后立即创建新 thread，失败时恢复旧状态。
7. 自然语言“停止执行”“切换到项目”等不再触发控制命令。
8. `/resume` 只回放最近一轮用户输入和最终结果，不包含 commentary、推理或工具过程。
9. `/resume` 最后一轮失败、被中断或无最终答复时不回退到更早轮次。
10. `/model` 只允许 `model/list` 当前返回的模型和 effort，失效设置能安全回退。
11. Auto-review 和人工审批分别路由正确，切换模式不处理旧审批。
12. `/screen` 只向授权用户发送有效图片，并删除临时文件。
13. App Server 断开或关闭时，所有活跃 thread 正确失败收尾，不遗留卡死队列。
14. `npm run check` 全部通过，AOI 启动、停止、文件交付和渠道上下文注入无回归。

## 9. 非目标

- 不迁移或修复 `/plan`。
- 不修改 AKA。
- 不把自然语言重新解释为桥接控制命令。
- 不重新发送恢复历史中的本地附件。
- 不引入 `danger-full-access`、跳过审批或关闭沙箱。
- 不在本需求中重写 AOI 的服务启动与停止体系。
