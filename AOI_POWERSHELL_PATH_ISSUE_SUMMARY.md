# AOI PowerShell 路径问题摘要

## 问题归属

这是 **codex2larkAOI** 的问题，不是 AKA 的问题。

## 问题现象

AOI 飞书桥接能够正常接收消息并启动 Codex，但 Codex 调用 PowerShell 执行终端命令时失败，日志中的核心错误为：

```text
windows sandbox: CreateProcessAsUserW failed: 5（拒绝访问）
```

失败时使用的 PowerShell 路径为：

```text
C:\Users\noha\AppData\Local\Microsoft\WindowsApps\pwsh.exe
```

同一台电脑上的其他正常 Codex 会话使用的是实际安装目录下的 PowerShell，例如：

```text
C:\Program Files\WindowsApps\Microsoft.PowerShell_*\pwsh.exe
```

## 原因判断

问题不是 CMD 本身造成的。AOI 的 `start.cmd` 默认会把桥接服务作为 detached 后台进程启动，并把启动时的环境变量继续传给桥接和 Codex App Server。

因此，后台 Codex 解析 `pwsh.exe` 时命中了用户目录中的 Windows App Execution Alias，而不是可正常启动的 PowerShell 实际程序。Windows 沙箱随后无法通过该别名创建 PowerShell 进程，最终返回“拒绝访问”。

旧的前台 PowerShell 启动方式与新的 CMD 后台启动方式具有不同的进程链和环境继承方式，因此从 PS1 改为 CMD 可能是问题的触发条件，但真正需要修复的是后台进程使用的 PowerShell 路径。

## 已确定的解决方向

修复 AOI 后台启动时的 PowerShell 路径解析，使 Codex 使用可直接执行的 `pwsh.exe` 实际路径，避免使用：

```text
C:\Users\noha\AppData\Local\Microsoft\WindowsApps\pwsh.exe
```

修复时应优先采用以下原则：

1. 在 AOI 服务启动阶段解析并验证真实的 PowerShell 可执行文件。
2. 将真实 PowerShell 所在目录放在后台子进程 `PATH` 的前面，或通过 Codex 支持的配置明确指定该程序。
3. 不硬编码带版本号的 `C:\Program Files\WindowsApps\Microsoft.PowerShell_*` 路径，避免 PowerShell 更新后失效。
4. 保留现有 AOI/AKA 飞书配置隔离，不修改 AKA。

## 不建议的处理方式

不建议长期以管理员身份运行整个 AOI 桥接服务。管理员启动可能因为用户令牌或环境变量发生变化而暂时绕过问题，但不能保证修复错误的 PowerShell 路径，同时会让长期运行的桥接进程获得不必要的高权限。

Codex 官方文档中的 `elevated` Windows 沙箱是由管理员批准完成初始化、随后使用专门的低权限沙箱用户运行命令；它不等于让 AOI 桥接服务一直以管理员身份运行。

官方参考：<https://developers.openai.com/codex/windows>

## 修复后的验证标准

1. 使用普通用户权限运行 `start.cmd`，AOI 能在后台正常启动。
2. 从 AOI 飞书 App 发起要求执行终端命令的测试任务。
3. 日志中不再出现 `CreateProcessAsUserW failed: 5`。
4. PowerShell 命令能够正常返回结果。
5. 停止 AOI 时只停止本项目桥接和事件消费者，不影响 AKA。

