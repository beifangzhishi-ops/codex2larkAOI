# AOI 共享 App Server 版 Codex Proxy

本仓库包含共享 App Server 版 Desktop 启动入口：

- `Start-Codex-Shared-Proxy.cmd`：给用户双击的共享版入口。
- `scripts/Start-Codex-Shared-Proxy.ps1`：Clash / Store Codex / shared stack 启动逻辑。
- `shared-start.cmd`：只启动共享 App Server 栈，不启动 Desktop。
- `shared-stop.cmd`：只停止共享 App Server 栈。

共享版拓扑：

```text
Codex Desktop ─┐
               ├─> 127.0.0.1:45789 compatibility proxy
AOI bridge ────┘                    |
                                    v
                              127.0.0.1:45790
                              real codex app-server

Codex Desktop -> Clash / system proxy -> Internet / Remote Control
```

`45789` compatibility proxy 只过滤缺少有效 transport 的 malformed `mcp_servers.codex_app` request override；其他 JSON-RPC 请求、响应、事件与有效 MCP 配置保持不变。

## 两种 Desktop 启动模式

### 共享模式

使用本仓库：

```text
Start-Codex-Shared-Proxy.cmd
```

行为：

1. 检查 Clash / Windows 系统代理。
2. 检查 AOI shared stack。
3. 调用本仓库 `scripts/shared-stack.ps1 -Action start -NoGui`，检查当前运行时并按需启动：
   - 45789 compatibility proxy
   - 45790 real codex app-server
4. 设置本次 Desktop 进程树：
   - `HTTP_PROXY`
   - `HTTPS_PROXY`
   - `ALL_PROXY`
   - `NO_PROXY=localhost,127.0.0.1,::1`
   - `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:45789`
5. 启动 Microsoft Store Codex Desktop。
6. shared stack 启动失败时不回退到内置 app-server。

### 自动发现与独立运行时

每次运行共享启动器都会检查桌面缓存与 Microsoft Store 安装目录，按主程序修改时间选择完整版本；两者均不可用时查找 VS Code 扩展。必须同时存在且非空的文件包括 `codex.exe`、`codex-code-mode-host.exe`、`codex-command-runner.exe` 和 `codex-windows-sandbox-setup.exe`。

启动前按文件内容生成指纹，将同目录 Codex 程序和动态库复制到 AOI 的 `.runtime/shared/<指纹>/`，校验通过后从副本启动。桌面端更新、清理自己的缓存不会影响该副本。独立目录不提交 Git，旧副本保留以供仍在运行的进程使用。

已有服务正常运行时，启动器检查工具文件并提示发现的不同版本；不自动中断任务。任务结束后停止并重新启动共享服务，即自动采用发现的完整版本。仍使用桌面缓存的既有进程也会提示在下次启动迁移。

只读检查运行时、可用更新和两个健康接口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\shared-stack.ps1 -Action status -NoGui
```

自动发现发生在启动或手动状态检查时，不安装后台定时监控。运行时检查发现文件缺失时会明确报错，即使健康接口仍返回成功也不会当作正常复用。

### 无共享模式

使用独立仓库：

```text
beifangzhishi-ops/codex-windows-proxy-launcher
Start-Codex-Proxy.cmd
```

该仓库只负责 Desktop + Clash。其 CMD 会只在本次进程树中清除 `CODEX_APP_SERVER_WS_URL`，确保 Desktop 使用内置 app-server；不会启动、停止或修改 AOI shared stack，也不会清除用户级 shared 环境变量。

## 使用原则

需要 Desktop 与 AOI 同时控制同一批 Codex thread 时，使用 AOI 的 `Start-Codex-Shared-Proxy.cmd`。

只想单独运行 Desktop、排除 shared app-server 变量影响时，使用独立 `codex-windows-proxy-launcher`。

切换两种模式前应完全退出当前 Codex Desktop，因为 Desktop 的 App Server 连接选择发生在启动阶段。
