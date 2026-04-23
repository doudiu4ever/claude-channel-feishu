# claude-channel-feishu

Connect a Feishu (Lark) bot to your Claude Code session.

Inbound messages from the bot arrive in the Claude Code terminal as channel
events; Claude replies through a `reply` tool. Tool-use permission prompts can
also be relayed to Feishu so you approve them remotely from your phone.

> This is a [Claude Code channel](https://code.claude.com/docs/en/channels-reference) — an MCP server with the `claude/channel` capability. Modeled after the official [Telegram channel](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram).

## Prerequisites

- **Node 18+** — the server runs on `tsx` (no Bun needed).
- **Feishu 自建应用** with:
  - Bot capability enabled.
  - Event subscription set to **long connection** (no public URL required).
  - Subscribed event: `im.message.receive_v1`.
  - Scopes: `im:message`, `im:message:send_as_bot`, `im:chat:readonly`.
  - A released version (changes in the developer console take effect only after publishing).

You'll need the app's **App ID** (`cli_...`) and **App Secret** from the Feishu developer console.

## Install

```bash
git clone https://github.com/<you>/claude-channel-feishu.git
cd claude-channel-feishu
npm install
```

## Launch

Start Claude Code with the channel flag from inside the repo:

```bash
claude --dangerously-load-development-channels server:feishu
```

On first run Claude will ask you to approve the `.mcp.json` server — choose **Use this MCP server**.

> `--dangerously-load-development-channels` is required during the channels research preview for any channel not on Anthropic's approved list.

## Configure (first time only)

In the Claude Code session, just ask Claude to configure the bot. It will call the `configure` tool with your credentials:

> "configure feishu, app id `cli_xxx`, app secret `xxx`"

The credentials are written to `~/.claude/channels/feishu/config.json` (mode 0600). The Feishu WebSocket connects in the same process — no restart needed.

From then on, subsequent sessions pick up the saved config automatically. To override per-instance, export `FEISHU_APP_ID` / `FEISHU_APP_SECRET` in your shell — environment takes precedence over the config file.

## Pair (first time only)

Access is gated by Feishu `open_id`. On first DM from an unauthorized user, the bot replies with a 6-character pairing code:

```
You are not authorized yet.
Pairing code: ABC123
In the Claude Code terminal, say: pair ABC123
```

In your Claude Code session, say:

> "pair ABC123"

Claude calls the `pair` tool, the bot DMs back "Paired.", and your `open_id` is appended to `access.json`. Next messages flow as normal channel events. Codes expire after 10 minutes.

## Using it

Once configured and paired:

- **DM the bot** → the message appears in your Claude Code terminal as a `<channel source="feishu" ...>` event. Claude can respond by calling the `reply` tool.
- **Permission relay** — if Claude tries to run a tool that needs approval (e.g. `Bash`), the prompt is forwarded to allowlisted Feishu users. Reply `yes <id>` or `no <id>` from Feishu to approve/deny without touching the terminal.

## Files

| Path | Purpose | Committed? |
|---|---|---|
| `.mcp.json` | MCP launch command, no secrets | yes |
| `access.json` | Allowlist of paired `open_id`s | **no** (gitignored, auto-created) |
| `access.example.json` | Template for a fresh install | yes |
| `~/.claude/channels/feishu/config.json` | APP_ID / APP_SECRET (0600) | outside repo |

## Status & limitations

v0.1 is text-only. Not yet implemented:

- Image / file attachments (inbound + outbound).
- Interactive message cards for permission approval and for adding new senders after bootstrap.
- Group chat `@`-mention handling.
- `react`, `edit_message`, `download_attachment` tools.

Contributions welcome — see `CLAUDE.md` for the deferred list and architecture notes.

## License

Apache-2.0
