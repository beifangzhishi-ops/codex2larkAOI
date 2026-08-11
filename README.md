# Codex CLI 飞书桥接

本服务把飞书消息接入 Codex App Server，并保留每个聊天的持续会话：

```text
飞书消息 -> lark-cli event consume -> Codex App Server -> 飞书回复/文件
```

使用 App Server 而非一次性的 `codex exec`，因此支持运行中过程消息、工具调用、人工审批和中断。每个聊天独立保存 Codex thread、当前项目目录、审批模式、插话模式以及模型设置。

## 权限边界

- Codex 可读取本机文件；
- Codex 只可写当前 `/new 项目名或路径` 或 `/cd 项目名或路径` 选择的项目目录；
- 无工作区对话（`/new` 无参）不绑定项目目录，只可写本会话专属的系统临时目录，本机文件仍可只读访问；
- `auto` 模式使用 App Server Auto-review 代为处理后续轮次的按需审批，不解除沙箱；
- `manual` 模式把 Codex 的命令/文件审批转发到飞书；
- 切换审批模式不处理已经发出的审批请求；
- 不使用 `danger-full-access` 或 `--dangerously-bypass-approvals-and-sandbox`。

## 配置

当前机器需安装 `codex` 与 `lark-cli >= 1.0.74`，并完成独立测试机器人的配置。`1.0.74` 已包含本项目使用的 Markdown 原生云文档创建能力；`card.action.trigger` 的最低支持版本仍是 `1.0.58`：

```powershell
lark-cli config init --new
lark-cli auth login --recommend
lark-cli auth status
```

Windows 主机还必须安装非 AppX 形式的 PowerShell 7，例如用户便携版 `%LOCALAPPDATA%\\Programs\\PowerShell\\7\\pwsh.exe` 或 MSI 版 `%ProgramFiles%\\PowerShell\\7\\pwsh.exe`。服务启动时会自动查找并试运行该程序，把其目录放到后台子进程 `Path` 的最前面。AOI 明确排除用户目录中的 App Execution Alias 和 `%ProgramFiles%\\WindowsApps` 下的 Store/AppX 程序；它们可能在普通用户会话中运行，但无法由 Codex 的 `unelevated` Windows 沙箱受限令牌启动。如果没有合适的 PowerShell，AOI 会在启动阶段明确报错，不会通过管理员常驻、沙箱外自动重试或关闭 Codex 沙箱绕过问题。

在飞书开放平台启用机器人、订阅 `im.message.receive_v1`，并授予收取单聊消息、回复消息、上传文件、创建及管理云空间文件夹、创建云文档、管理云文档协作者和添加/删除消息表情所需权限。Markdown 云文档交付至少需要应用身份权限 `drive:drive`（云空间目录与协作者）和 `docx:document`（创建及编辑新版文档）。要使用审批卡片，还必须在“应用 -> 事件与回调 -> 回调配置”中启用回调并订阅 `card.action.trigger`，同时授予 `im:message:readonly`；长连接模式不需要配置回调 URL。

复制模板并填写配置：

```powershell
Copy-Item .env.example .env
notepad .env
```

关键配置：

- `CODEX_WORKDIR`：默认目录和目录名称搜索根目录；`/new 项目名或路径` 与 `/cd 项目名或路径` 可从当前目录或该根目录逐层匹配，也接受现有文件夹路径；
- `FEISHU_ALLOWED_OPEN_IDS`：允许操作机器人的明确 `ou_xxx`，禁止 `*`；这些用户同时获得机器人根目录 `codex` 文件夹的编辑权限；
- `LARKSUITE_CLI_CONFIG_DIR`：开发机器人独立的 lark-cli 配置目录；
- `CODEX_COMMAND`：仅用于启动预检的 `codex.exe` 绝对路径；留空时自动发现最新版 VS Code 扩展内置内核（与共享 app-server 一致）；实际连接走 `CODEX_APP_SERVER_WS_URL` 指定的共享 app-server，不要指向已删除的项目内旧版内核；
- `CODEX_MODEL`：可选的部署级默认模型；留空时使用 Codex 默认模型，飞书聊天可通过 `/model` 独立覆盖；
- `CODEX_TITLE_MODEL`、`CODEX_TITLE_EFFORT`：用于异步生成会话标题；模型留空或设为 `auto` 时，初始偏好 `gpt-5.6-terra`（经 CodexModelProxy 中转的 DeepSeek-V4-Flash），三次标题尝试失败后若该模型已不可用，则切换到首个成功业务轮次的模型并更新暂存值；档位留空或设为 `auto` 时取所选模型支持列表的最低档位；显式配置时不会跟随聊天的 `/model` 设置；
- `CODEX_APPROVAL_MODE=auto|manual`：新聊天的默认审批模式；
- `CODEX_INTERJECTION_MODE=guide|queue`：新聊天的默认插话模式；`guide` 会将消息注入正在运行的同一会话，`queue` 则等待当前任务结束；
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

## 共享 Codex app-server

共享 Codex app-server 让桌面端和飞书桥接连接同一个 App Server 实例，避免新版内核的线程写入锁冲突（`already has an active writer`），并让桌面端实时看到飞书会话的消息流。

AOI 桥接自身不再启动 codex 子进程：启动时通过 `CODEX_APP_SERVER_WS_URL` 以 WebSocket 连接共享 app-server；项目内旧版 `.runtime` 内核已删除。

- `shared-start.cmd`：双击启动共享 app-server（自动使用最新版 VS Code 扩展内置内核），并写入用户环境变量 `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:45789`；
- `shared-stop.cmd`：双击停止共享 app-server 并删除该环境变量。

环境变量变化后需重启一次桌面端才生效：变量存在时桌面端连接共享 app-server，删除后回退到内置内核。启动顺序：先双击 `shared-start.cmd`，再启动 AOI（`start.cmd`）。共享 app-server 与 AOI 相互独立，AOI 可随时启停。

异常恢复：共享进程被手动结束但环境变量仍在时，双击 `shared-stop.cmd` 会删除变量；若端口仍有监听进程，脚本会提示手动排查，不会误杀其他 codex 进程。

手动查看状态：

```powershell
Get-Process codex | Select-Object Id,StartTime,Path
netstat -ano | Select-String ':45789'
[Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')
```

## 飞书控制

- `/new`：进入无工作区独立对话并创建新 thread；不绑定项目目录、不加载项目 `AGENTS.md`，只可写本会话专属的系统临时目录（`%TEMP%\codex2larkAOI\standalone\<会话ID>`），本机文件仍可只读访问，生成的文件可正常以本地 Markdown 链接（或兼容的 `FILE:`/`MEDIA:` 指令）交付；
- `/new 分层名称或路径`：先从当前目录、再从 `CODEX_WORKDIR` 根目录逐层进行不区分大小写的精确、前缀、包含匹配；多个候选会要求用户明确选择；成功后立即在目标目录创建并选中新 thread；
- `/cd 分层名称或路径`：使用与 `/new` 相同的匹配规则，但保留当前会话，仅把后续任务的工作目录切换到目标目录；运行中的任务继续在原目录完成；`/cd` 无参数显示当前工作目录；
- `/plan`：持续进入计划模式；已有会话立即使用 App Server 的 `thread/settings/update` 更新模式，没有会话时会在创建下一会话后自动应用；
- `/plan 任务描述`：先进入计划模式，再把任务描述作为新一轮消息交给 Codex；
- `/default`：持续切回默认执行模式；不会恢复此前已经暂停的 Goal；
- `/goal 目标`：切回默认模式并启动 Goal；`/goal` 查看当前 Goal；`/goal pause|resume|clear` 分别暂停、恢复或清除 Goal；
- `/resume`：用交互卡片按更新时间列出最近 5 个未归档的 Codex 历史会话（包括 App Server、CLI 和 IDE 会话）；恢复列表优先显示桥接当前运行态、App Server 当前运行状态和 Goal 状态，最后才使用最新历史轮次，因此不会把桥接正在执行的会话误显示为“已中断”；
- 恢复卡片按需显示“上一页”和“下一页”，中间页共 5 个会话按钮和 2 个翻页按钮；也可使用 `/resume prev|next`；
- `/resume 编号|标题`：继续当前列表中的历史会话，将当前飞书聊天绑定到该 thread，并切换到其工作目录；标题必须唯一匹配；已完成轮次会回放真正的最近一轮用户输入和最终答复，不重发历史附件；运行中的普通会话或 Goal 会话会显示已接入提示，并回放最近一条 commentary 或推理摘要；随后实时转发后续过程消息，不显示空的历史输入或最终答复占位；
- `/rename 新标题`：重命名当前飞书聊天绑定的 Codex 会话；标题最多 80 个字符。手动重命名会取消该会话尚未完成的自动命名，避免被自动标题覆盖；
- `/model`：通过交互卡片选择模型，再选择该模型实际支持的思考强度；模型列表来自 App Server `model/list`，不会硬编码；
- `/model default`：恢复部署级 `CODEX_MODEL` 或 Codex 默认模型和默认思考强度；
- `/model <model-id>`：选择模型并采用该模型的默认思考强度；
- `/model <model-id> <思考强度>`：同时设置模型和思考强度；只有 `model/list` 当前返回的组合才会生效；
- 模型设置按飞书聊天持久化，只影响设置完成后的普通任务；模型或强度失效时会安全回退并明确提示；
- `/screen`：按物理像素截取 Windows 桥接主机的完整虚拟桌面，兼容多显示器和 DPI 缩放，并作为图片回复；发送完成后删除临时图片；
- `/temperature`：查询桥接主机本机温度（CPU、磁盘、风扇、GPU），由桥接直接读取 LibreHardwareMonitor 的温度服务并回复，不占用 Codex 会话；
- 新建 Codex 会话收到首轮用户消息后，桥接立即通过独立的临时线程异步生成简短中文标题，无需等待首轮业务回复成功；失败任务仅在后续业务轮次中有限重试，且不会阻塞业务答复；达到最终失败状态后不使用用户消息或截断文本替代标题；
- `/stop`：中断当前选中 thread 的活跃 turn，并清除该 thread 尚未开始的任务；不停止桥接服务或已经切换离开的后台 thread；
- `/approval auto`：使用 App Server Auto-review 处理后续轮次的审批，仍受工作区沙箱限制；
- `/approval manual`：把审批请求作为飞书交互卡片发出，可点击“允许一次”“本会话允许”“拒绝”；按钮不可用时仍可使用下列文字命令；
- `/interject guide`：将同一会话在运行中的普通任务或 Goal 的后续消息通过引导方式注入；
- `/interject queue`：将后续消息依次排队，等待当前任务结束后执行；
- `/approve`：允许一个待审批操作；
- `/approve session`：允许当前 session 范围内的同类操作；
- `/deny`：拒绝一个待审批操作；
- `/status`：以交互卡片查看当前目录、会话名和 ID、审批方式、插话方式、下一轮模型、思考强度、设置来源及权限；卡片提供“复制会话 ID / 复制会话名 / 复制工作目录 / 复制为深度链接 / 复制为 MD”按钮，前四项把对应内容作为纯文本直接发送到对话，最后一项把状态内容上传为云文档；
- `/help`：显示带有继续对话、模型设置、切换审批模式、切换插话模式、查看状态和停止操作按钮的交互卡片；两个模式按钮均会在原卡片内刷新为可切换的另一种模式；`/new` 与 `/screen` 保留为卡片中的文字命令，不提供按钮。

桥接只识别以上完整斜杠命令。自然语言中的“停止执行”“切换项目”“改为自动审批”等内容始终作为普通 Codex 任务处理。

## 查询本机温度

`/temperature` 由桥接直接读取本机 LibreHardwareMonitor（LHM）的温度服务（默认 `http://127.0.0.1:8085/data.json`），返回 CPU、磁盘、风扇、GPU 温度。LHM 需要以管理员权限运行才能读取底层传感器，首次配置步骤：

1. 以管理员身份运行 `scripts\install-lhm.cmd`：优先通过 winget 安装 LHM，并创建“登录时以最高权限运行”的计划任务 `LibreHardwareMonitor` 实现开机自启；
2. 手动以管理员运行一次 LHM，在“选项 → 远程网络服务器（Remote web server）”中勾选“运行”；
3. 用 `curl.exe http://127.0.0.1:8085/data.json` 确认能返回 JSON；
4. 在飞书发送 `/temperature` 即可查询。

LHM 未运行时，`/temperature` 会回复无法连接温度服务的提示。服务地址可用 `.env` 的 `TEMPERATURE_API_URL` 覆盖；桥接只读取本机回环地址，不提升自身权限，LHM 作为独立进程常驻后台。

## 过程消息

普通 Codex 任务开始执行时，桥接会在用户原消息上添加 `Typing` 表情；成功回复后移除，失败时替换为 `CrossMark`。表情接口异常只记录日志，不中断 Codex 任务。

桥接会实时发送：

- Codex 的 `commentary` 进度；
- 模型提供的可读推理摘要，不发送隐藏链式推理；
- 最终回答。

终端、文件修改、MCP、网页搜索等工具调用事件不会转发到飞书，避免过程消息过多。

所有已识别的斜杠命令和控制卡片都通过聊天级短路由队列处理，不等待正在运行的 Codex turn。普通任务在选路时固定 thread、目录、模型、思考强度和审批模式，再进入 thread 队列；同一 thread 严格串行，不同 thread 可并行。`/new` 或 `/resume` 切换选择后，旧 thread 的任务继续后台执行并保留历史，但不再向该飞书聊天推送进度、审批提示、最终答复、错误或附件；恢复一个仍在运行的 thread 后，桥接会重新加入该 thread 并接收此后的 commentary、推理摘要和最终答复。

`/stop` 只作用于发出命令时当前选中的 thread：它会请求中断该 thread 的活跃 turn，并清除该 thread 尚未开始的任务，同时报告清除数量。`/new` 后当前选择指向新建的会话，`/stop` 不会误停已经切换离开的后台 thread。

计划模式产生最终计划后，桥接会发送确认卡片。“否决，继续修改”会保持计划模式并等待修改意见；“接受并执行”会切换到默认执行模式，并自动发送“执行刚刚确认的计划”。每个计划项只能处理一次，处理状态会持久化，因此重复点击、旧卡片、跨会话点击或服务重启都不会重复执行。计划正文中的 Markdown 图片语法会在卡片中替换为替代文本，避免飞书卡片因缺少 `image_key` 渲染失败；若卡片发送仍失败，桥接会回退发送计划正文，并要求直接回复同意或修改意见。

运行中的 Goal 接收飞书普通消息时，桥接使用 `turn/steer` 注入当前轮次；普通会话仍使用原有串行队列。Goal 的 `/stop` 固定先暂停 Goal，再中断当前 turn；`/status` 在当前会话存在 Goal 时额外显示目标、状态和 Token 用量。

## 文件发送

飞书轮次不再要求 Codex 输出 `FILE:`/`MEDIA:` 指令，最终答复与桌面端保持一致：交付本地图片时输出指向真实本地文件的 Markdown 图片链接（如 `![图](C:\absolute\path\plot.png)`），交付其他文件时输出本地 Markdown 链接。桥接负责所有飞书侧转换，LLM 不需要接触飞书凭证。

桥接会验证文件非空，从文件父目录调用 `lark-cli`。图片在回复正文原位置内联展示（参考公式渲染的本地桥接处理）；非 Markdown 文件作为原生附件回复；扩展名为 `.md`（大小写不敏感）的文件使用 `docs +create --doc-format markdown` 转为飞书原生云文档，存入机器人根目录的公共 `codex` 文件夹，并回复单篇文档链接和文件夹入口。成功转换后不再重复发送原始 `.md`；目录初始化、权限授予或文档创建失败时，会说明原因并回退发送原始文件。

服务首次启动时会查找或创建 `codex` 文件夹，并把 `FEISHU_ALLOWED_OPEN_IDS` 中的用户批量设为可编辑协作者；后续云文档继承文件夹权限。用户可在飞书手机端通过机器人回复链接直接打开文档，也可从共享文件夹或搜索进入 `codex` 集中浏览。用户也可直接发送本地 Markdown 链接或旧式 `FILE:`/`MEDIA:` 指令。本地文件链接和指令行不会显示在最终文字中，Codex 不直接接触飞书凭证。

## 状态

维护记录：2026-07-28 完成 AKA 会话对 AOI 文件修改及 AOI 服务重启验证；2026-08-11 约定本项目所有更新统一推送到 GitHub 的 `noha` 分支，并修复恢复会话回放中本地音频/图片 Markdown 残留 `!` 前缀的显示问题；计划确认卡片支持解析本地图片并以上传的 `image_key` 内嵌显示。

状态保存在 `.state/sessions.json`：

- `sessions`：聊天到 Codex thread；
- `threadModes`：thread 的持续协作模式；
- `pendingChatModes`：尚未创建 thread 的聊天待应用模式；
- `planReviews`：计划确认卡片及其处理状态；
- `workdirs`：聊天到当前项目目录；
- `standaloneChats`：标记处于无工作区独立对话模式的聊天；
- `pendingWorkdirQueries`：等待用户补充绝对目录位置的项目查询；
- `approvalModes`：聊天到审批模式；
- `interjectionModes`：聊天到插话模式；
- `modelSettings`：聊天到后续轮次的模型和思考强度策略；
- `autoTitleModel`：自动标题模式下最后一次可用的标题模型；
- `pendingTitleJobs`：待生成或待写入的会话标题任务，保存有限输入摘要、首个业务轮次模型、任务级标题模型/档位、重试次数和最近错误；
- `markdownDelivery`：机器人 `codex` 文件夹的 token、链接和已授予编辑权限的允许用户；
- `events`：事件去重窗口。

`chatRouteQueues`、`threadQueues`、活跃 turn、恢复候选和审批请求只存在于内存，不写入状态文件。服务重启后会恢复聊天绑定、目录、模型、审批模式、插话模式和未完成标题任务，但不会把旧运行态误判为仍在执行。

每次更新后的推荐收尾顺序为：运行 `npm run check`，提交该阶段纯文本改动，执行 `stop.cmd --no-pause-on-error`，再执行 `start.cmd --no-pause-on-error`。确认新 PID 存在、两类事件消费者均输出 `[event] ready`，且 `.env` 中 `LARKSUITE_CLI_CONFIG_DIR` 仍指向 AOI 开发槽。不要使用 `lark-cli event stop --all`，否则可能影响其他项目实例。

凭证仍由 `lark-cli` 和 `codex` 自行管理。飞书渠道规则通过 `turn/start.additionalContext` 按轮次注入；项目规则不作为渠道提示词注入，目标项目的 `AGENTS.md` 由 Codex 按当前工作目录正常加载。

## GitHub 同步与另一台电脑部署

本仓库公开托管在 GitHub：<https://github.com/beifangzhishi-ops/codex2larkAOI>。`.env`、`.state/`、`.runtime/`、`node_modules/`、`user/` 均不进入仓库；飞书凭据、lark-cli 配置和运行状态需要在每台电脑单独配置。

另一台电脑首次部署：

1. `git clone https://github.com/beifangzhishi-ops/codex2larkAOI.git`
2. `cd codex2larkAOI`
3. `npm install`（需要 Node.js >= 20）
4. `Copy-Item .env.example .env`，并填写 `CODEX_WORKDIR`、`FEISHU_ALLOWED_OPEN_IDS` 等配置
5. 初始化开发槽：先设置 `LARKSUITE_CLI_CONFIG_DIR` 为 `C:\Users\<你的用户名>\.lark-cli-codex2lark-dev`，再依次执行 `lark-cli config init --new`、`lark-cli auth login --recommend`、`lark-cli auth status`
6. 安装 VS Code Codex 扩展；需要共享 App Server 时先运行 `shared-start.cmd`，再运行 `start.cmd`

日常更新：本机提交后 `git push origin main`；另一台电脑执行 `git pull origin main`，依赖变化时补 `npm install`，然后按上文“每次更新后的推荐收尾顺序”重启桥接。

Codex 协议依据：[App Server](https://developers.openai.com/codex/app-server)、[非交互模式与 JSONL 事件](https://developers.openai.com/codex/noninteractive)、[CLI 审批与工作目录参数](https://developers.openai.com/codex/cli/reference)。
