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
- Progress indicator: OK reaction + keepalive message after 20s
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

### 2. Mid-execution inbound: queue vs interrupt semantics

**Why**: if user DMs while Claude is mid-Bash, what happens? The channel
notification fires, but Claude's tool loop won't see it until the current
tool returns. Long Bash commands could delay delivery by minutes. Worse:
the eyes reaction fires on message N+1 while message N's reaction is still
live — `pendingByChat` only tracks one entry per chat (`server.ts:139`).

**Shape**:
- Verify actual behavior with a manual test (long `sleep 60 && echo done`
  Bash, send Feishu mid-execution, observe).
- Decide: queue messages (current implicit behavior) vs explicitly tell user
  "Claude is busy, will see this in a moment."
- If queueing: clean up `pendingByChat` to handle multiple in-flight
  inbounds — switch from single `Pending` to a list keyed by message_id, or
  reaction-only-on-first-of-burst.
- Consider: forward an explicit "📥 message queued — Claude is busy with
  Bash:..." card so the user knows their message arrived but isn't being
  processed yet.

---

## Tier P1 — richer interaction surface

### 4. Inbound + outbound attachments ✅

Implemented. `reply` accepts file paths for outbound images/documents;
inbound attachments are downloaded to `~/.claude/channels/feishu/inbox/`
and surfaced via `image_path` / `file_path` in channel meta.

### 5. Group chat support with @-mention gating

Today, `access.json` gates by sender open_id, so groups "work" but every
sender must be paired individually. For team workflows:

- Detect group messages (`chat_type === 'group'` on the message event).
- In groups, only respond when bot is @-mentioned (parse mentions from
  `event.message.mentions[]`).
- Optional: per-group access policy file (`access.json` extended with
  `allowGroups: [chat_id, ...]`).

### 6. Crash / restart recovery

If tmux session dies or the host reboots:

- On startup, if `loadConfig()` succeeds and `access.json` has entries, send
  each paired open_id a "Claude Code restarted at <time>. Last session was
  <session_id>." card with buttons: **Resume**, **New session**, **Just
  acknowledge**.
- "Resume" → exec `claude --resume <last_session_id>` (or set an env signal
  the launcher can pick up).
- Persist last session_id to `~/.claude/channels/feishu/last_session.json`
  on each successful turn (Claude side can call a `mark_session(id)` tool,
  or we read it from `~/.claude/projects/.../sessions/`).

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

`download_attachment` is already implemented. `react` (add emoji reaction
to messages) and `edit_message` (patch previously-sent bot messages) remain.
Lower priority than the items above.

### 10. Richer rendering

- Default text replies use `msg_type: 'text'`. For long answers with code,
  switch to `msg_type: 'interactive'` with `lark_md` so code blocks render
  properly on mobile.
- Threshold: auto-upgrade to card when reply contains ` ``` ` or exceeds
  some length.

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

1. P1.5 (group chat @-mention) — unlocks team workflows.
2. P2.9 (`react` / `edit_message` tools) — round out Telegram parity.
3. P0.2 (mid-execution semantics) — do once you have real usage data.
4. P1.6 (crash recovery) — once flow is otherwise smooth and you start
   hitting reliability limits.
5. Everything else: opportunistic.
