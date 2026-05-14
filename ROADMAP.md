# Roadmap

Iteration plan for `claude-channel-feishu`, oriented around the primary use case:
**a mobile control surface for a remote, tmux-resident Claude Code session running
long-lived development tasks** — the user wants to (a) check progress and (b)
inject new instructions from Feishu while away from the terminal.

---

## Implemented

- MCP server with `claude/channel` + `claude/channel/permission` capabilities
- Feishu inbound via long-connection (`lark.WSClient`), `im.message.receive_v1`
- `reply` tool (text + file attachments)
- Permission relay with interactive Allow/Deny cards via `card.action.trigger`
- Sender gating by `sender.sender_id.open_id` against `access.json`
- Pairing flow: 6-char codes + interactive approval cards for admins
- `configure` tool (credentials → `config.json`)
- `download_attachment` tool
- Image / file / audio / media attachment support (inbound + outbound)
- `notify` tool: proactive progress reporting during long-running tasks
- `react` tool: add emoji reactions to messages
- Rich text rendering: auto-upgrade reply to interactive card for code blocks
- Reply echo enforcement: tool returns exact "→ feishu:" text for consistent terminal output
- Busy notification card when messages arrive mid-processing
- Progress indicator: OK reaction + keepalive message after 20s
- Group chat support: dual-gate (`allowGroups` + `allowFrom`), @-mention required, bot.added approval card, `pair_group` tool
- Packaged as a Claude Code marketplace plugin (`dist/server.mjs` bundle)

## Not yet implemented

Pick one off the top of a tier when starting work.

---

## Tier P0 — closes the gap to the stated use case

### 1. Proactive progress reporting tool (`notify` / `progress`) ✅

Implemented. Exposed as `notify(chat_id, text, kind?)` MCP tool. Renders as
a small interactive card (grey/blue/yellow header, no buttons), visually
distinct from `reply`. Does not touch `pendingByChat` or `lastChatId`.

---

### 2. Mid-execution inbound: queue vs interrupt semantics ✅

Busy notification card implemented. When a message arrives while
`pendingByChat` already has this chat, the bot immediately sends a
"Message received. Claude is currently busy..." card. The actual
message still flows through to Claude (no queueing/interrupt in the
plugin layer — that's controlled by Claude's tool loop).

Remaining polish: `pendingByChat` multi-message handling (currently
overwrites previous entry per chat). Low urgency.

---

## Tier P1 — richer interaction surface

### 4. Inbound + outbound attachments ✅

Implemented. `reply` accepts file paths for outbound images/documents;
inbound attachments are downloaded to `~/.claude/channels/feishu/inbox/`
and surfaced via `image_path` / `file_path` in channel meta.

### 5. Group chat support with @-mention gating ✅

Implemented with **dual gate**: a group message is processed only if
`chat_id ∈ allowGroups` AND `sender open_id ∈ allowFrom` AND the bot is
@-mentioned (`message.mentions[].id.open_id === BOT_OPEN_ID`). All
failures are silent — groups never get spammed with pairing codes or
"not authorized" replies.

- Bot's own `open_id` resolved at startup via `bot/v3/info`.
- `im.chat.member.bot.added_v1` event triggers an Allow/Deny card DM'd
  to every admin in `allowFrom`. Allow writes `chat_id` into
  `allowGroups`.
- `pair_group(chat_id)` MCP tool as a manual escape hatch.
- Group requires new Feishu event subscription: `im.chat.member.bot.added_v1`.

### 7. Offline message queue

If Claude Code isn't running but Feishu messages still come in:
- The current architecture *can't* receive them — the WS client lives in
  the MCP process, which dies when Claude Code dies.
- Options:
  1. Run a tiny standalone listener (just the WS + persist-to-disk part)
     as a separate systemd/tmux service. On Claude startup, it hands queued
     messages to the MCP server.
  2. Or: accept the limitation and just show the "Claude Code restarted"
     notification on next launch (covered by P1.6).
- Option 1 is more work but materially better for the "I'm AFK and want
  someone to be able to leave instructions" case.

---

## Tier P2 — polish

### 6. Crash / restart recovery (downgraded from P1)

Downgraded: message delivery is lightweight — if a message is lost during
restart, the user can just resend. Not worth the complexity of message-id
deduplication or session tracking. The most useful piece (restart notification
card) can be implemented opportunistically.

### 8. Multi-session routing

If user runs multiple tmux panes each with its own Claude Code (e.g.
different projects), today they all collide on the same Feishu bot. Two
approaches:

- One Feishu app per session (heavy — requires multiple bots).
- Or: a session label in `config.json` (`session_name: "main"`), and the
  bot prefixes messages with the label. Multiple Claude Code instances
  share the same Feishu app but each takes a slice of `access.json`-routed
  chats. Needs careful design — defer until felt as pain.

### 9. Slash commands (`/status`, `/abort`, `/resume`, `/log`)

Downgraded from P0. Natural-language "how's it going?" already covers most
of the value. Implement when the gap between structured commands and free
text becomes noticeable in real usage.

### 10. `react`, `edit_message` tools

`react` is implemented. `edit_message` remains — but Feishu `im.message.patch`
only supports interactive cards, not text messages, so its utility is limited.
Low priority.

### 10. Richer rendering ✅

Implemented. `sendRichText` auto-detects code blocks (```) or text > 500 chars
and upgrades from `msg_type: 'text'` to `msg_type: 'interactive'` with `lark_md`
rendering.

---

## What I'm explicitly not putting on this roadmap

- **Migrating to cc-connect or any subprocess-bridge architecture.** The
  channel-injection model is the load-bearing differentiator for this
  project's stated use case. Don't lose it.
- **Bun rewrite.** Reference implementation uses Bun; CLAUDE.md notes user
  is on Node, leave it.
- **Web admin dashboard.** Cool, but not what the user needs. Tmux + Feishu
  is already the dashboard.

---

## Suggested ordering when work resumes

1. P2.9 (`edit_message`) — limited utility; Feishu only allows patching interactive cards.
2. P1.7 (offline message queue) — only matters if the AFK-instruction use case becomes painful.
3. Everything else: opportunistic.
