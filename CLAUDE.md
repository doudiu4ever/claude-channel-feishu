# claude-channel-feishu

## What this is

A Claude Code **channel** (MCP server) that bridges a Feishu/Lark bot to the local
Claude Code session. Inbound Feishu messages become `<channel source="feishu">`
events in the Claude conversation; Claude replies via a `reply` tool; tool-use
permission prompts can be relayed to Feishu for remote approval.

Channel protocol reference: https://code.claude.com/docs/en/channels-reference

## Reference implementation

Ported structurally from the official Telegram channel:
https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram

When in doubt about behavior (pairing flow, access control, permission relay
edge cases), read that `server.ts` first. We are deliberately mirroring its
architecture so lessons there transfer.

## Current state (v0.1.0 skeleton)

Done:
- MCP server with `claude/channel` + `claude/channel/permission` capabilities
- Feishu inbound via **long-connection** (`lark.WSClient`) — no public URL needed
- Subscribes to `im.message.receive_v1`
- `reply` tool: sends text back to a Feishu chat via `im.message.create`
- Permission relay: outbound sends prompt to allowlisted users; inbound
  `yes <id>` / `no <id>` parsed into verdict
- Sender gating by `sender.sender_id.open_id` against `access.json`
- Pairing flow: unauthorized senders receive a 6-char code; `pair` tool
  claims the code and appends the open_id to `access.json`. Codes are
  in-memory, 10-min TTL, one active code per open_id (new message replaces).
- `configure` tool: accepts `app_id` / `app_secret`, writes them to
  `~/.claude/channels/feishu/config.json` (0600) and starts the Feishu
  WSClient in-process. No restart required on first configure.
  `$FEISHU_APP_ID` + `$FEISHU_APP_SECRET` from the environment still
  override the config file if set.

Deferred (add incrementally, keep parity with telegram channel):
- Image / file attachments (inbound + outbound)
- Interactive message cards for permission approval AND for adding new
  senders after the bootstrap admin is paired (currently text-only yes/no)
- Group chat @-mention handling
- `react`, `edit_message`, `download_attachment` tools

## Runtime

Node + `tsx` (user's machine does not have `bun`). Do not rewrite to Bun unless
asked — the SDK works fine on Node, only the runner differs from the telegram
reference.

ESM project (`"type": "module"`). Keep `.ts` extension on import specifiers that
target local files if/when more files are added.

## Feishu-specific gotchas (already handled, don't re-discover)

1. `event.message.content` is a **JSON string**, not plain text. Must
   `JSON.parse` before use. Outbound `content` field must likewise be
   `JSON.stringify({ text })`.
2. Gate on `sender.sender_id.open_id`, **never** on `chat_id` — group members
   would otherwise all be implicitly trusted.
3. Long connection (`WSClient`) is preferred over webhook for local dev — no
   public endpoint, no ngrok.
4. Send API takes `receive_id_type` as a separate `params` object, not mixed
   into the body.

## Prereqs the user owns (not code concerns)

- Feishu 自建应用 with `App ID` / `App Secret`
- Bot capability enabled
- Event subscription set to **long connection** mode
- Subscribed: `im.message.receive_v1`
- Scopes: `im:message`, `im:message:send_as_bot`, `im:chat:readonly`
- `access.json` is **gitignored** (contains personal open_ids); the repo
  ships `access.example.json` as a template. On first run the server
  auto-creates `access.json` with `{"allowFrom": []}` if missing — the
  bootstrap admin then pairs themselves via the pairing flow below,
  no manual edit needed.

`.mcp.json` is checked in and contains **no secrets** — just the command
to launch the server. Credentials are collected at runtime via the
`configure` tool and stored in `~/.claude/channels/feishu/config.json`
(mode 0600). Setting `FEISHU_APP_ID` / `FEISHU_APP_SECRET` in the shell
environment bypasses the file (useful for CI or per-instance overrides).

## How to run

Development / code work (no channel activation needed):
```
claude
```

Actually exercising the channel end-to-end:
```
claude --dangerously-load-development-channels server:feishu
```

The `--dangerously-load-development-channels` flag is required during the
channel research preview for any channel not on Anthropic's approved allowlist.

## What success looks like for the next milestone

Main-path smoke test (fresh clone, no config file, empty `access.json`):
1. User runs `claude --dangerously-load-development-channels server:feishu`;
   the MCP server boots in "unconfigured" state (no Feishu WS yet)
2. User says anything → Claude (per instructions) asks for
   FEISHU_APP_ID / FEISHU_APP_SECRET → user provides → Claude calls the
   `configure` tool → WSClient starts in-process
3. User DMs the Feishu bot → bot replies with a 6-char pairing code
4. In the Claude Code terminal, user says `pair <code>` → Claude calls the
   `pair` tool → open_id is appended to `access.json`, bot DMs "Paired."
5. User DMs the bot again → message appears as `<channel source="feishu" ...>`
   in the Claude Code terminal
6. Claude calls `reply(chat_id, "...")` → message lands back in Feishu
7. Claude tries to run `Bash` → permission prompt arrives in Feishu DM → user
   replies `yes <id>` → local terminal prompt closes, command runs

Once that round-trips reliably, start moving deferred items above into scope.
