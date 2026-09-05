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
3. 如果 45789 未就绪，调用本仓库 `scripts/shared-stack.ps1 -Action start -NoGui` 启动：
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
