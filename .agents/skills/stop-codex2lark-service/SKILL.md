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

   ```cmd
   .\.agents\skills\stop-codex2lark-service\scripts\stop-service.cmd "C:\Users\noha\Documents\AAAVitalFile\codex2larkV1.0"
   ```

3. Confirm the PID recorded in `.state\bridge.pid` is absent. Treat a missing PID file as already stopped.
4. Report which project and PID stopped. State explicitly that no shared event bus was stopped.

## Restart an AOI instance

Use this sequence when restarting the development AOI bridge. Do not replace it with
`lark-cli event stop --all` or a direct event-consumer command.

1. Run the project-scoped stop wrapper with the absolute AOI path:

   ```powershell
   & ".\.agents\skills\stop-codex2lark-service\scripts\stop-service.cmd" `
     "C:\Users\noha\Documents\AAAVitalFile\codex2larkAOI"
   ```

2. Confirm the PID from `.state\bridge.pid` has exited and that the PID file is
   absent. If shutdown takes more than 10 seconds, inspect
   `.state\bridge.err.log` and `.state\bridge.out.log` before taking further action.

3. Start the AOI project through its own launcher:

   ```powershell
   & ".\start.cmd" "--no-pause-on-error"
   ```

   The launcher must resolve a non-AppX PowerShell 7 executable. In a Codex
   workspace sandbox, the child PowerShell probe can return `EPERM`; in that case,
   rerun the same `start.cmd` command with the approved sandbox escalation. Do not
   bypass the PowerShell check or edit service code for this environment issue.

4. Verify `.state\bridge.pid` contains a running process. Then check
   `.state\bridge.err.log` for both event consumers reporting `[event] ready` and
   the Feishu WebSocket reaching `connected`.

5. For AOI, confirm `.env` keeps
   `LARKSUITE_CLI_CONFIG_DIR=C:\Users\noha\.lark-cli-codex2lark-dev`.
   Report the old and new bridge PIDs and state explicitly that the shared event bus
   was not stopped.

## Safety rules

- Never use `lark-cli event stop --all` for normal project shutdown.
- Do not use `lark-cli event stop --force` while another project may be running.
- Let `stop.cmd` write `.state\stop-requested`; the bridge detects it, closes the selected `event consume` child's stdin, and exits gracefully.
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
