---
name: stop-codex2lark-service
description: Safely stop one codex2lark bridge instance without stopping another project's shared lark-cli event bus. Use when stopping, restarting, moving, or diagnosing codex2larkV1.0 or codex2lark, and when checking production/test Feishu App and lark-cli configuration isolation.
---

# Stop codex2lark Service

Stop only the selected project's bridge process and its `event consume` child. Preserve every other project's event bus and consumer.

## Stop an instance

1. Identify the target explicitly:
   - `codex2larkV1.0`: stable release, production Feishu bot.
   - `codex2lark`: development build, test Feishu bot.
2. Run the bundled wrapper with an absolute project path:

   ```powershell
   .\.agents\skills\stop-codex2lark-service\scripts\stop-service.ps1 -ProjectRoot C:\Users\noha\Documents\AAAVitalFile\codex2larkV1.0
   ```

3. Confirm the PID recorded in `.state\bridge.pid` is absent. Treat a missing PID file as already stopped.
4. Report which project and PID stopped. State explicitly that no shared event bus was stopped.

## Safety rules

- Never use `lark-cli event stop --all` for normal project shutdown.
- Do not use `lark-cli event stop --force` while another project may be running.
- Let `stop.ps1` write `.state\stop-requested`; the bridge detects it, closes the selected `event consume` child's stdin, and exits gracefully.
- If shutdown exceeds 10 seconds, inspect `.state\bridge.err.log`, `.state\bridge.out.log`, and the recorded PID. Do not broaden the stop target automatically.
- Do not look for HTTP port conflicts. This project does not expose an HTTP listener.

## Keep stable and development isolated

Require all of the following before running both instances:

- Use different Feishu Apps and bots. Never point both at App `cli_aab92dc7aa381cd7`.
- Subscribe each App independently to `im.message.receive_v1`.
- Set `LARKSUITE_CLI_CONFIG_DIR=C:\Users\noha\.lark-cli` for the stable release.
- Set `LARKSUITE_CLI_CONFIG_DIR=C:\Users\noha\.lark-cli-codex2lark-dev` for development.
- Initialize and authenticate the development directory with the test App before starting development.

To initialize a directory without affecting the other instance:

```powershell
$env:LARKSUITE_CLI_CONFIG_DIR = 'C:\Users\noha\.lark-cli-codex2lark-dev'
lark-cli config init --new
lark-cli auth login --recommend
lark-cli auth status
```

Do not copy production App credentials into the development directory.
