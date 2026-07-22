# Codex CLI 飞书桥接

本服务把飞书消息接入 Codex App Server，并保留每个聊天的持续会话：

```text
飞书消息 -> lark-cli event consume -> Codex App Server -> 飞书回复/文件
```

使用 App Server 而非一次性的 `codex exec`，因此支持运行中过程消息、工具调用、人工审批和中断。每个聊天独立保存 Codex thread、当前项目目录和审批模式。

## 权限边界

- Codex 可读取本机文件；
- Codex 只可写当前 `/cd` 选择的项目目录；
- `auto` 模式是不弹审批，不是解除沙箱；
- `manual` 模式把 Codex 的命令/文件审批转发到飞书；
- 不使用 `danger-full-access` 或 `--dangerously-bypass-approvals-and-sandbox`。

## 配置

当前机器需安装 `codex` 与 `lark-cli`，并完成独立测试机器人的配置：

```powershell
lark-cli config init --new
lark-cli auth login --recommend
lark-cli auth status
```

在飞书开放平台启用机器人、订阅 `im.message.receive_v1`，并授予收取单聊消息、回复消息、上传文件和添加/删除消息表情所需权限。

复制模板并填写配置：

```powershell
Copy-Item .env.example .env
notepad .env
```

关键配置：

- `CODEX_WORKDIR`：默认目录和项目名搜索根目录；项目名优先模糊匹配其第一层目录，也可切换到任意现有文件夹路径；
- `FEISHU_ALLOWED_OPEN_IDS`：允许操作机器人的明确 `ou_xxx`，禁止 `*`；
- `LARKSUITE_CLI_CONFIG_DIR`：开发机器人独立的 lark-cli 配置目录；
- `CODEX_APPROVAL_MODE=auto|manual`：新聊天的默认审批模式；
- `FEISHU_ALLOW_GROUPS=false`：默认禁用群聊；
- `FEISHU_REACTIONS=true`：执行普通 Codex 任务时显示消息表情状态。

开发版与稳定版必须使用不同的飞书 App 和不同的 `LARKSUITE_CLI_CONFIG_DIR`，不能共同消费同一个 App 的事件流。

## 运行

```powershell
npm run check
.\start.ps1
```

看到 `[event] ready event_key=im.message.receive_v1` 后即可给机器人发送任务。后台实例可用以下命令停止：

```powershell
.\stop.ps1
```

`stop.ps1` 只停止本项目桥接及其子进程，不调用共享的 `lark-cli event stop --all`。

## 飞书控制

- `/cd 项目名或路径`：项目名不区分大小写地优先模糊匹配 `CODEX_WORKDIR` 第一层目录，也接受任意现有文件夹的绝对或相对路径；
- `切换到 X 项目`：`/cd X` 的自然语言形式；
- 第一层未找到项目时，机器人会询问位置；下一条可直接回复该文件夹的绝对路径；
- `/new`：清除当前聊天的 Codex thread，保留工作目录和审批模式；
- `/resume`：分页列出所有工作目录中未归档的 Codex 历史会话（包括 App Server、CLI 和 IDE 会话），并显示各自目录；
- `/resume 编号|thread-id|标题`：继续列表中的历史会话，将当前飞书聊天绑定到该 thread，并切换到其工作目录；标题必须唯一匹配；
- 新建 Codex 会话的首轮开始后，桥接会根据首条用户消息自动设置简短标题；
- `/stop`：通过 `turn/interrupt` 停止当前操作，不停止桥接服务；
- `/approval auto`：自动审批后续操作，仍受工作区沙箱限制；
- `/approval manual`：把审批请求发到飞书；
- `/approve`：允许一个待审批操作；
- `/approve session`：允许当前 session 范围内的同类操作；
- `/deny`：拒绝一个待审批操作；
- `/status`：查看当前目录、thread、审批和权限；
- `/help`：显示命令。

也可发送“改为自动审批”“改为手动审批”“同意执行”“拒绝执行”“停止当前操作”。自然语言控制只匹配短而明确的命令，普通讨论不会被截获。

## 过程消息

普通 Codex 任务开始执行时，桥接会在用户原消息上添加 `Typing` 表情；成功回复后移除，失败时替换为 `CrossMark`。表情接口异常只记录日志，不中断 Codex 任务。

桥接会实时发送：

- Codex 的 `commentary` 进度；
- 模型提供的可读推理摘要，不发送隐藏链式推理；
- 最终回答。

终端、文件修改、MCP、网页搜索等工具调用事件不会转发到飞书，避免过程消息过多。

同一聊天中的普通任务按顺序执行，`/stop` 和审批命令可绕过队列立即生效。

## 文件发送

项目级 [AGENTS.md](./AGENTS.md) 要求 Codex 在最终回答中输出独立的交付指令：

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
- `events`：事件去重窗口。

凭证仍由 `lark-cli` 和 `codex` 自行管理。项目提示词会作为 App Server 的 developer instructions 注入，同时目标项目自身的 `AGENTS.md` 仍按其工作目录加载。

Codex 协议依据：[App Server](https://developers.openai.com/codex/app-server)、[非交互模式与 JSONL 事件](https://developers.openai.com/codex/noninteractive)、[CLI 审批与工作目录参数](https://developers.openai.com/codex/cli/reference)。
