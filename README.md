# claude-channel-feishu

Connect a Feishu (Lark) bot to your Claude Code session.

Inbound messages from the bot arrive in the Claude Code terminal as channel
events; Claude replies through a `reply` tool. Tool-use permission prompts can
also be relayed to Feishu so you approve them remotely from your phone.

> This is a [Claude Code channel](https://code.claude.com/docs/en/channels-reference) — an MCP server with the `claude/channel` capability. Modeled after the official [Telegram channel](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram).

## Prerequisites

- **Node 18+** (the server runs on `tsx`).
- **Feishu 自建应用** with:
  - Bot capability enabled.
  - **Event** subscription set to **long connection** (no public URL required), subscribed to `im.message.receive_v1`.
  - **Callback** subscription (a separate tab under *Events and Callbacks*) also set to **long connection**, subscribed to `card.action.trigger` — this is what powers the Allow/Deny buttons for permission prompts. Without it the cards show error 200340 when tapped.
  - Scopes: `im:message`, `im:message:send_as_bot`, `im:chat:readonly`.
  - A **released** version (changes in the developer console take effect only after publishing).

You'll also need the app's **App ID** (`cli_...`) and **App Secret** from the Feishu developer console.

## Install

From inside any Claude Code session:

```
/plugin marketplace add https://github.com/doudiu4ever/claude-channel-feishu.git
/plugin install feishu@feishu-plugins
```

The plugin installs under `~/.claude/plugins/` and handles its own dependencies on first launch.

## Launch

Exit your session, then relaunch with the channel flag:

```bash
claude --dangerously-load-development-channels plugin:feishu@feishu-plugins
```

> `--dangerously-load-development-channels` is required during the channels research preview for any channel not on Anthropic's approved list.

## Configure (first time only)

In the Claude Code session, just ask Claude to configure the bot. It will call the plugin's `configure` tool with your credentials:

> "configure feishu, app id `cli_xxx`, app secret `xxx`"

The credentials are written to `~/.claude/channels/feishu/config.json` (mode 0600). The Feishu WebSocket connects in the same process — no restart required. Subsequent sessions pick up the saved config automatically.

To override per-instance, export `FEISHU_APP_ID` / `FEISHU_APP_SECRET` in your shell — environment takes precedence over the config file.

## Pair (first time per sender)

Access is gated by Feishu `open_id`. On first DM from an unauthorized user, the bot replies with a 6-character pairing code:

```
You are not authorized yet.
Pairing code: ABC123
In the Claude Code terminal, say: pair ABC123
```

In your Claude Code session, say:

> "pair ABC123"

Claude calls the `pair` tool, the bot DMs back "Paired.", and your `open_id` is appended to `~/.claude/channels/feishu/access.json`. Codes expire after 10 minutes.

## Using it

Once configured and paired:

- **DM the bot** → the message appears in your terminal as a `<channel source="feishu" ...>` event. Claude can respond by calling the `reply` tool.
- **Permission relay** — if Claude tries to run a tool that needs approval (e.g. `Bash`), the prompt is forwarded to allowlisted Feishu users as an interactive card with **Allow** / **Deny** buttons. Tap one and the verdict goes back to Claude without touching the terminal. Text fallback `yes <id>` / `no <id>` still works.

## Development mode

If you want to hack on the plugin locally instead of installing it:

```bash
git clone https://github.com/doudiu4ever/claude-channel-feishu.git
cd claude-channel-feishu
npm install
claude --dangerously-load-development-channels server:feishu
```

The `server:feishu` form reads the repo's `.mcp.json` directly. In dev mode the wrapper runs `tsx server.ts`, so edits to `server.ts` take effect on each session restart.

Before publishing a change, rebuild the bundle that plugin-mode installs consume:

```bash
npm run build
```

`dist/server.mjs` is the self-contained bundle the plugin loads at runtime — no `npm install` required on the installer's side, which is what makes first-launch instant.

## Files

| Path | Purpose |
|---|---|
| `.claude-plugin/plugin.json` | Plugin metadata |
| `.claude-plugin/marketplace.json` | Single-plugin marketplace descriptor |
| `.mcp.json` | MCP launch wrapper (bash — installs deps on first run) |
| `server.ts` | Channel server implementation |
| `~/.claude/channels/feishu/config.json` | APP_ID / APP_SECRET (mode 0600, created by the `configure` tool) |
| `~/.claude/channels/feishu/access.json` | Paired `open_id` allowlist (auto-created) |

## Status & limitations

v0.1 is text-only. Not yet implemented:

- Image / file attachments (inbound + outbound).
- Interactive message cards for permission approval and for admitting new senders after the bootstrap admin.
- Group chat `@`-mention handling.
- `react`, `edit_message`, `download_attachment` tools.

See `CLAUDE.md` for architecture notes and the deferred list.

## License

Apache-2.0
