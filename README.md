# Codex CLI 飞书桥接

本服务把飞书消息接入 Codex App Server，并保留每个聊天的持续会话：

```text
飞书消息 -> lark-cli event consume -> Codex App Server -> 飞书回复/文件
```

使用 App Server 而非一次性的 `codex exec`，因此支持运行中过程消息、工具调用、人工审批和中断。每个聊天独立保存 Codex thread、当前项目目录、审批模式以及模型设置。

## 权限边界

- Codex 可读取本机文件；
- Codex 只可写当前 `/cd` 选择的项目目录；
- `auto` 模式使用 App Server Auto-review 代为处理后续轮次的按需审批，不解除沙箱；
- `manual` 模式把 Codex 的命令/文件审批转发到飞书；
- 切换审批模式不处理已经发出的审批请求；
- 不使用 `danger-full-access` 或 `--dangerously-bypass-approvals-and-sandbox`。

## 配置

当前机器需安装 `codex` 与 `lark-cli >= 1.0.58`，并完成独立测试机器人的配置。`1.0.58` 是 `card.action.trigger` 的最低支持版本：

```powershell
lark-cli config init --new
lark-cli auth login --recommend
lark-cli auth status
```

Windows 主机还必须安装非 AppX 形式的 PowerShell 7，例如用户便携版 `%LOCALAPPDATA%\\Programs\\PowerShell\\7\\pwsh.exe` 或 MSI 版 `%ProgramFiles%\\PowerShell\\7\\pwsh.exe`。服务启动时会自动查找并试运行该程序，把其目录放到后台子进程 `Path` 的最前面。AOI 明确排除用户目录中的 App Execution Alias 和 `%ProgramFiles%\\WindowsApps` 下的 Store/AppX 程序；它们可能在普通用户会话中运行，但无法由 Codex 的 `unelevated` Windows 沙箱受限令牌启动。如果没有合适的 PowerShell，AOI 会在启动阶段明确报错，不会通过管理员常驻、沙箱外自动重试或关闭 Codex 沙箱绕过问题。

在飞书开放平台启用机器人、订阅 `im.message.receive_v1`，并授予收取单聊消息、回复消息、上传文件和添加/删除消息表情所需权限。要使用审批卡片，还必须在“应用 -> 事件与回调 -> 回调配置”中启用回调并订阅 `card.action.trigger`，同时授予 `im:message:readonly`；长连接模式不需要配置回调 URL。

复制模板并填写配置：

```powershell
Copy-Item .env.example .env
notepad .env
```

关键配置：

- `CODEX_WORKDIR`：默认目录和目录名称搜索根目录；`/cd` 可从当前目录或该根目录逐层匹配，也接受现有文件夹路径；
- `FEISHU_ALLOWED_OPEN_IDS`：允许操作机器人的明确 `ou_xxx`，禁止 `*`；
- `LARKSUITE_CLI_CONFIG_DIR`：开发机器人独立的 lark-cli 配置目录；
- `CODEX_COMMAND`：可选的 `codex.exe` 绝对路径；留空时自动从 PATH 或当前用户的 VS Code OpenAI 扩展中查找；
- `CODEX_MODEL`：可选的部署级默认模型；留空时使用 Codex 默认模型，飞书聊天可通过 `/model` 独立覆盖；
- `CODEX_TITLE_MODEL`、`CODEX_TITLE_EFFORT`：仅用于异步生成会话标题，默认分别为 `gpt-5.6-luna` 和 `low`，不会跟随聊天的 `/model` 设置；
- `CODEX_APPROVAL_MODE=auto|manual`：新聊天的默认审批模式；
- `FEISHU_ALLOW_GROUPS=false`：默认禁用群聊；
- `FEISHU_REACTIONS=true`：执行普通 Codex 任务时显示消息表情状态。

开发版与稳定版必须使用不同的飞书 App 和不同的 `LARKSUITE_CLI_CONFIG_DIR`，不能共同消费同一个 App 的事件流。

## 运行

```cmd
npm run check
.\start.cmd
```

`start.cmd` 会先校验 PowerShell 7、确认 Codex App Server 和两个事件消费者均已就绪，再自动退出窗口；桥接继续在后台运行。启动时显示的 `[start] PowerShell` 应指向 `LocalAppData\\Programs` 或普通 `Program Files\\PowerShell` 安装目录，不应包含 `WindowsApps`。启动失败时会显示错误并等待按 Enter，便于从双击窗口排查问题。运行日志保存在 `.state\\bridge.out.log` 和 `.state\\bridge.err.log`。自动化调用可避免等待：

```cmd
.\start.cmd --no-pause-on-error
```

兼容旧自动化参数 `-NoPauseOnError`。使用 `.\start.cmd --foreground` 可在当前窗口实时查看启动日志；`npm start` 默认后台启动，`npm run start:foreground` 保持前台。看到 `im.message.receive_v1` 和 `card.action.trigger` 两个 `[event] ready` 标记后即可给机器人发送任务。停止服务：

```cmd
.\stop.cmd
```

也可从资源管理器双击 `start.cmd` 或 `stop.cmd`。停止脚本写入本项目 `.state\\stop-requested`，由桥接优雅关闭本项目事件消费者；它不调用共享的 `lark-cli event stop --all`，也不会停止其他项目实例。自动化停止使用 `.\stop.cmd --no-pause-on-error`。

## 飞书控制

- `/cd 分层名称或路径`：先从当前目录、再从 `CODEX_WORKDIR` 根目录逐层进行不区分大小写的精确、前缀、包含匹配；多个候选会要求用户明确选择；成功后立即在目标目录创建并选中新 thread；
- `/new`：清除当前聊天的 Codex thread，保留工作目录、审批模式和模型设置；下一条普通任务到达时再创建新 thread；
- `/resume`：用交互卡片按更新时间列出最近 5 个未归档的 Codex 历史会话（包括 App Server、CLI 和 IDE 会话）；已加载会话使用 App Server 的实时状态，未加载会话只读其最新轮次并显示“已完成”“已中断”“失败”“进行中”或“无记录”，可直接点击会话继续；
- 恢复卡片按需显示“上一页”和“下一页”，中间页共 5 个会话按钮和 2 个翻页按钮；也可使用 `/resume prev|next`；
- `/resume 编号|标题`：继续当前列表中的历史会话，将当前飞书聊天绑定到该 thread，并切换到其工作目录；标题必须唯一匹配；恢复后会回放真正的最近一轮用户输入和最终答复，不重发历史附件；
- `/model`：通过交互卡片选择模型，再选择该模型实际支持的思考强度；模型列表来自 App Server `model/list`，不会硬编码；
- `/model default`：恢复部署级 `CODEX_MODEL` 或 Codex 默认模型和默认思考强度；
- `/model <model-id>`：选择模型并采用该模型的默认思考强度；
- `/model <model-id> <思考强度>`：同时设置模型和思考强度；只有 `model/list` 当前返回的组合才会生效；
- 模型设置按飞书聊天持久化，只影响设置完成后的普通任务；模型或强度失效时会安全回退并明确提示；
- `/screen`：按物理像素截取 Windows 桥接主机的完整虚拟桌面，兼容多显示器和 DPI 缩放，并作为图片回复；发送完成后删除临时图片；
- 新建 Codex 会话首轮成功回复后，桥接通过独立的临时线程异步生成简短中文标题；失败任务会有限重试，且不会阻塞业务答复；
- `/stop`：中断当前选中 thread 的活跃 turn，并清除该 thread 尚未开始的任务；不停止桥接服务或已经切换离开的后台 thread；
- `/approval auto`：使用 App Server Auto-review 处理后续轮次的审批，仍受工作区沙箱限制；
- `/approval manual`：把审批请求作为飞书交互卡片发出，可点击“允许一次”“本会话允许”“拒绝”；按钮不可用时仍可使用下列文字命令；
- `/approve`：允许一个待审批操作；
- `/approve session`：允许当前 session 范围内的同类操作；
- `/deny`：拒绝一个待审批操作；
- `/status`：查看当前目录、会话名和 ID、审批方式、下一轮模型、思考强度、设置来源及权限；
- `/help`：显示带有继续对话、模型设置、切换审批模式、查看状态和停止操作按钮的交互卡片；`/new` 与 `/screen` 保留为卡片中的文字命令，不提供按钮。

桥接只识别以上完整斜杠命令。自然语言中的“停止执行”“切换项目”“改为自动审批”等内容始终作为普通 Codex 任务处理。

## 过程消息

普通 Codex 任务开始执行时，桥接会在用户原消息上添加 `Typing` 表情；成功回复后移除，失败时替换为 `CrossMark`。表情接口异常只记录日志，不中断 Codex 任务。

桥接会实时发送：

- Codex 的 `commentary` 进度；
- 模型提供的可读推理摘要，不发送隐藏链式推理；
- 最终回答。

终端、文件修改、MCP、网页搜索等工具调用事件不会转发到飞书，避免过程消息过多。

所有已识别的斜杠命令和控制卡片都通过聊天级短路由队列处理，不等待正在运行的 Codex turn。普通任务在选路时固定 thread、目录、模型、思考强度和审批模式，再进入 thread 队列；同一 thread 严格串行，不同 thread 可并行。因此 `/new`、`/cd` 或 `/resume` 后，旧 thread 的任务可以在后台继续回复原消息。

`/stop` 只作用于发出命令时当前选中的 thread：它会请求中断该 thread 的活跃 turn，并清除该 thread 尚未开始的任务，同时报告清除数量。`/new` 后当前选择为空，`/stop` 不会误停已经切换离开的后台 thread。

## 文件发送

桥接为每个飞书轮次注入的渠道指令要求 Codex 在最终回答中输出独立的交付指令：

```text
FILE:C:\absolute\path\report.pdf
MEDIA:C:\absolute\path\plot.png
```

桥接会验证文件非空，从文件父目录调用 `lark-cli`，并把文件或图片原生回复到当前飞书消息。用户也可直接发送上述指令。为兼容 Codex 的常规最终答复，指向真实本地文件的 Markdown 链接也会被识别为附件。指令行和本地文件链接不会显示在最终文字中，Codex 不直接接触飞书凭证。

## 状态

状态保存在 `.state/sessions.json`：

- `sessions`：聊天到 Codex thread；
- `workdirs`：聊天到当前项目目录；
- `pendingWorkdirQueries`：等待用户补充绝对目录位置的项目查询；
- `approvalModes`：聊天到审批模式；
- `modelSettings`：聊天到后续轮次的模型和思考强度策略；
- `pendingTitleJobs`：待生成或待写入的会话标题任务，保存有限输入摘要、重试次数和最近错误；
- `events`：事件去重窗口。

`chatRouteQueues`、`threadQueues`、活跃 turn、恢复候选和审批请求只存在于内存，不写入状态文件。服务重启后会恢复聊天绑定、目录、模型、审批模式和未完成标题任务，但不会把旧运行态误判为仍在执行。

每次更新后的推荐收尾顺序为：运行 `npm run check`，提交该阶段纯文本改动，执行 `stop.cmd --no-pause-on-error`，再执行 `start.cmd --no-pause-on-error`。确认新 PID 存在、两类事件消费者均输出 `[event] ready`，且 `.env` 中 `LARKSUITE_CLI_CONFIG_DIR` 仍指向 AOI 开发槽。不要使用 `lark-cli event stop --all`，否则可能影响其他项目实例。

凭证仍由 `lark-cli` 和 `codex` 自行管理。飞书渠道规则通过 `turn/start.additionalContext` 按轮次注入；项目规则不作为渠道提示词注入，目标项目的 `AGENTS.md` 由 Codex 按当前工作目录正常加载。

Codex 协议依据：[App Server](https://developers.openai.com/codex/app-server)、[非交互模式与 JSONL 事件](https://developers.openai.com/codex/noninteractive)、[CLI 审批与工作目录参数](https://developers.openai.com/codex/cli/reference)。
