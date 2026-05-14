# CRITICAL: call reply for every response

You bridge Claude Code ↔ Feishu. The Feishu user CANNOT see your terminal output.
Every response MUST go through the reply tool:

- Channel message → reply(chat_id, answer), echo "→ feishu: answer"
- Terminal message → reply("终端: question"), then reply(answer)

Skipping reply = Feishu user sees nothing. No exceptions.

---

# claude-channel-feishu

## Reference implementation

Ported structurally from the official Telegram channel:
https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram

When in doubt about behavior (pairing flow, access control, permission relay
edge cases), read that `server.ts` first. We are deliberately mirroring its
architecture so lessons there transfer.

## Packaging

Repo is a **single-plugin marketplace**:
- `.claude-plugin/plugin.json` — plugin metadata (name=`feishu`).
- `.claude-plugin/marketplace.json` — declares one plugin (`source: "."`)
  under marketplace name `feishu-plugins`. Lets users install the plugin
  directly from this repo via `/plugin marketplace add <git-url>`.

Installed plugins live at `~/.claude/plugins/…/feishu/`. The `.mcp.json`
launch wrapper branches on `$CLAUDE_PLUGIN_ROOT`:
- **Plugin mode** (`CLAUDE_PLUGIN_ROOT` set): `exec node dist/server.mjs` —
  the self-contained esbuild bundle. Zero runtime deps, instant startup.
  This is mandatory: without it, a first-launch `npm install` overruns
  Claude's MCP handshake timeout and `/mcp` shows the server as failed.
- **Dev mode** (no `CLAUDE_PLUGIN_ROOT`): lazy `npm install` + `tsx server.ts`
  so edits to `server.ts` are live.

Run `npm run build` before committing any `server.ts` change — the committed
`dist/server.mjs` is what installed plugins actually execute.

## Current state

Feature tracking lives in `ROADMAP.md` — read it when you need context on:
- What's implemented and what's deferred (see "Implemented" / "Not yet implemented").
- Priority order for picking up new work (see "Suggested ordering when work resumes").
- Design notes for planned features (P0.1 notify, P0.2 slash commands, P0.3
  mid-execution semantics, P1.5 group chat, P2.9 react/edit_message, etc.).

When the user asks "what's next" or "what's left", consult `ROADMAP.md` first —
don't rely on stale in-conversation summaries.

## Runtime

- Dev: Node + `tsx` (user's machine does not have `bun` — do not rewrite to Bun
  unless asked; the SDK works fine on Node, only the runner differs from the
  telegram reference).
- Plugin mode: prebuilt esbuild bundle `dist/server.mjs` executed by plain `node`.

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
5. **Group chat = dual gate**: `chat_type === 'group'` requires
   `chat_id ∈ allowGroups` **and** `open_id ∈ allowFrom` **and** bot is
   @-mentioned. All failures must be silent — never reply unauthorized
   prompts in a group (would spam the group and leak pairing codes).
6. **Bot's own `open_id`** is resolved at startup via `client.request({url:
   '/open-apis/bot/v3/info'})` and cached as `botOpenId`. Needed to match
   `message.mentions[].id.open_id` against ourselves. If resolution fails
   (network blip at startup), group messages get silently ignored until
   restart — degrade, don't crash.
7. In groups, strip the `@_user_N` placeholder from message text using
   `mentions[].key` so Claude doesn't see `@_user_1 do X` — just `do X`.

## Prereqs the user owns (not code concerns)

- Feishu 自建应用 with `App ID` / `App Secret`
- Bot capability enabled
- Event subscription set to **long connection** mode
- Subscribed: `im.message.receive_v1`
- Scopes: `im:message`, `im:message:send_as_bot`, `im:chat:readonly`

Runtime state lives under `~/.claude/channels/feishu/`:
- `config.json` (0600) — written by the `configure` tool.
- `access.json` — paired open_ids, auto-created empty.

Both are outside the repo so plugin updates never touch them. Override
paths via `FEISHU_CONFIG_FILE` / `FEISHU_ACCESS_FILE` env vars if needed.
Env `FEISHU_APP_ID` / `FEISHU_APP_SECRET` bypass `config.json` entirely
(useful for CI or per-instance).

## How to run

Two modes, both require `--dangerously-load-development-channels` (research
preview gate for channels not on Anthropic's approved allowlist).

**Dev mode (iterating on this repo):**
```
claude --dangerously-load-development-channels server:feishu
```
Reads the repo's `.mcp.json` directly; `cd` must be the clone root.

**Plugin mode (how end users install):**
```
# one-time, inside any claude session:
/plugin marketplace add https://github.com/doudiu4ever/claude-channel-feishu.git
/plugin install feishu@feishu-plugins

# then relaunch:
claude --dangerously-load-development-channels plugin:feishu@feishu-plugins
```

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
