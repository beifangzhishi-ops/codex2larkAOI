---
name: lark-send-file-to-me
description: Send a uniquely identified local file directly to the user's own Feishu/Lark direct chat with lark-cli as the configured bot. Use when the user says Chinese phrases such as "发 X 给我", "把 X 发给我", "将 X 发给我", "飞书发 X 给我", or equivalent requests to send a file to themselves. The request itself is standing approval for the recipient, file, and bot identity, so do not ask for a second confirmation.
---

# Send A File To My Feishu

Use `lark-cli im +messages-send` to upload the requested local file and send it to the user's own Feishu direct chat.

## Authorization

Treat an explicit request such as `发 X 给我` or `把 X 发给我` as complete approval for:

- recipient: the current user;
- content: the uniquely resolved local file `X`;
- identity: the configured Feishu application bot.

Send immediately without asking `确认发送吗`. Do not apply this standing approval when the recipient is another person or group, the requested item is not a file, or the file cannot be resolved uniquely.

## Workflow

1. Resolve the requested file.
   - Prefer an exact path supplied by the user.
   - Otherwise search the current project with `rg --files` and match the requested basename or description.
   - If exactly one reasonable match exists, use it without asking.
   - If no match or multiple equally plausible matches exist, ask one concise clarification question and do not send.

2. Verify the file before sending.
   - Confirm it is a regular, non-empty file.
   - Do not alter, rename, archive, or inspect its contents unless needed to disambiguate the request.
   - A sensitive-looking filename does not require another confirmation when the user explicitly named that file and the recipient is the user themself.

3. Read the configured identities:

   ```powershell
   lark-cli auth status
   ```

   Require `identities.bot.status` to be `ready`. Use `identities.user.openId` as the recipient even if the user token is expired; bot direct-message sending uses the open ID, not the user token. If the open ID is absent, ask the user to identify the target account.

4. Send from the file's parent directory because lark-cli accepts only cwd-relative media paths. Quote paths that contain spaces. Generate one idempotency key for the request and reuse the same key for every retry in that turn.

   ```powershell
   lark-cli im +messages-send --as bot --user-id <ou_xxx> --file ".\<filename>" --idempotency-key <request-key>
   ```

   Do not run `--dry-run` first for a normal request. The user's trigger phrase already authorizes the send.

5. Report the result.
   - On success, state the filename, recipient account name when available, bot identity, and send time.
   - Do not expose access tokens, app secrets, or other credentials.
   - If the response contains `_notice.update`, report the current and latest CLI versions after the send.

## Failure Handling

- Permission or scope error under bot identity: provide the returned `console_url` unchanged and name the missing scope. Do not run `auth login` for the bot.
- Bot has no direct-message relationship with the user: explain that the user must first open or message the bot, then retry after the user does so.
- Network or transient error: retry once with the same idempotency key.
- CLI rejects an unsafe path: change the working directory to the file's parent and pass only a relative filename; do not copy the file merely to bypass path checks.
- Never silently switch to user identity. The standing approval is specifically for bot identity.

## Examples

- `发 AGENTS.md 给我`
- `把刚生成的报告发给我`
- `将 C:\work\results.xlsx 飞书发给我`
- `飞书发这个 PDF 给我`

For all unambiguous examples, send immediately and report the result without a confirmation round trip.
