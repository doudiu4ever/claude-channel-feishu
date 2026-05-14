import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import * as lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, dirname, extname, sep } from 'path'

const ACCESS_FILE =
  process.env.FEISHU_ACCESS_FILE ??
  join(homedir(), '.claude', 'channels', 'feishu', 'access.json')
const STATE_DIR = join(homedir(), '.claude', 'channels', 'feishu')
const CONFIG_FILE =
  process.env.FEISHU_CONFIG_FILE ??
  join(STATE_DIR, 'config.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')

type Config = { app_id: string; app_secret: string }

function loadConfig(): Config | null {
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    return {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }
  }
  if (!existsSync(CONFIG_FILE)) return null
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return null
  }
}

function saveConfig(cfg: Config) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')
  try { chmodSync(CONFIG_FILE, 0o600) } catch {}
}

let client: lark.Client | null = null
let wsClient: lark.WSClient | null = null
let lastChatId: string | null = null
let botOpenId: string | null = null

async function resolveBotIdentity() {
  if (!client) return
  try {
    const res = await client.request<{ bot?: { open_id?: string; app_name?: string } }>({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    })
    botOpenId = res.bot?.open_id ?? null
    if (botOpenId) {
      stderrLogger.info(`bot open_id resolved: ${botOpenId} (${res.bot?.app_name ?? '?'})`)
    } else {
      stderrLogger.warn('bot/v3/info returned no open_id; group @-mention detection disabled')
    }
  } catch (e) {
    stderrLogger.error('bot/v3/info failed:', String(e))
  }
}

// Feishu SDK defaults to stdout for info logs — but stdout is the MCP
// JSON-RPC stream, so any non-protocol write corrupts it and Claude drops
// the server. Route SDK logs to stderr instead.
const stderrLogger = {
  error: (...m: unknown[]) => process.stderr.write(`[feishu:error] ${m.join(' ')}\n`),
  warn: (...m: unknown[]) => process.stderr.write(`[feishu:warn] ${m.join(' ')}\n`),
  info: (...m: unknown[]) => process.stderr.write(`[feishu:info] ${m.join(' ')}\n`),
  debug: () => {},
  trace: () => {},
}

type Access = { allowFrom: string[]; allowGroups: string[] }
const saveAccess = (access: Access) => {
  mkdirSync(dirname(ACCESS_FILE), { recursive: true })
  writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2) + '\n')
}
const loadAccess = (): Access => {
  if (!existsSync(ACCESS_FILE)) saveAccess({ allowFrom: [], allowGroups: [] })
  const raw = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
  return {
    allowFrom: raw.allowFrom ?? [],
    allowGroups: raw.allowGroups ?? [],
  }
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LEN = 6
const CODE_TTL_MS = 10 * 60 * 1000

type PendingPair = { open_id: string; chat_id: string; expiresAt: number }
const pendingByCode = new Map<string, PendingPair>()
const codeByOpenId = new Map<string, string>()

function issuePairCode(open_id: string, chat_id: string): string {
  const prev = codeByOpenId.get(open_id)
  if (prev) pendingByCode.delete(prev)
  let code: string
  do {
    code = Array.from({ length: CODE_LEN }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
    ).join('')
  } while (pendingByCode.has(code))
  pendingByCode.set(code, { open_id, chat_id, expiresAt: Date.now() + CODE_TTL_MS })
  codeByOpenId.set(open_id, code)
  return code
}

function consumePairCode(code: string): PendingPair | null {
  const entry = pendingByCode.get(code)
  if (!entry) return null
  pendingByCode.delete(code)
  codeByOpenId.delete(entry.open_id)
  if (entry.expiresAt < Date.now()) return null
  return entry
}

function safeName(s: string | undefined): string {
  return (s ?? 'file').replace(/[<>\[\]\r\n;]/g, '_').slice(0, 200)
}

async function downloadResource(
  message_id: string,
  file_key: string,
  type: string,
): Promise<string | null> {
  if (!client) return null
  try {
    const res = await client.im.messageResource.get({
      params: { type },
      path: { message_id, file_key },
    })
    const typeExt: Record<string, string> = { image: 'jpg', file: 'bin', audio: 'amr', media: 'mp4' }
    let ext = typeExt[type] ?? 'bin'
    const disposition = (res.headers as Record<string, string>)?.['content-disposition'] ?? ''
    const fnMatch = disposition.match(/filename\*?=["']?([^"';\s]+)/i)
    if (fnMatch) {
      const fromHeader = (fnMatch[1].split('.').pop() ?? '').replace(/[^a-zA-Z0-9]/g, '')
      if (fromHeader) ext = fromHeader
    }
    const path = join(INBOX_DIR, `${Date.now()}-${file_key.slice(0, 12)}.${ext}`)
    mkdirSync(INBOX_DIR, { recursive: true })
    await res.writeFile(path)
    return path
  } catch {
    return null
  }
}

function assertSendable(f: string): void {
  let real: string
  try { real = realpathSync(f) } catch { return }

  // Block everything under the state directory except inbox
  try {
    const stateReal = realpathSync(STATE_DIR)
    const inbox = join(stateReal, 'inbox')
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('refusing')) throw e
    // STATE_DIR doesn't exist — fall through to the explicit file checks below
  }

  // Block the exact access/config files (including custom paths)
  for (const sensitive of [ACCESS_FILE, CONFIG_FILE]) {
    try {
      const sReal = realpathSync(sensitive)
      if (real === sReal) {
        throw new Error(`refusing to send channel state: ${f}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('refusing')) throw e
    }
  }
}

const mcp = new Server(
  { name: 'feishu', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions:
      'CRITICAL: you are a bridge to Feishu. The Feishu user CANNOT see your terminal output. ' +
      'You MUST call the reply tool for EVERY response. ' +
      'Channel message (<channel> tag) → reply(chat_id, answer), echo "→ feishu: answer". ' +
      'Terminal message → reply("终端: question"), then reply(answer). ' +
      'Skipping reply = Feishu user sees nothing. No exceptions. ' +
      'The reply tool returns the exact echo text (starting with "→ feishu:"). ' +
      'Your terminal output MUST be the literal text returned by the reply tool — do not paraphrase or shorten it. ' +
      'Attachments: inbound image/file events include image_path/file_path in meta — Read them directly. ' +
      'Use download_attachment(message_id, file_key, type) to fetch resources on demand. ' +
      'To send files, pass absolute paths in the reply files parameter. ' +
      'If the user has not yet configured Feishu credentials, ask them for FEISHU_APP_ID ' +
      '(starts with "cli_") and FEISHU_APP_SECRET, then call the configure tool. ' +
      'If the user says they have a pairing code (e.g., "pair ABC123"), call the pair tool.',
  },
)

async function sendText(chat_id: string, text: string) {
  if (!client) throw new Error('feishu is not configured')
  return client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chat_id,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  })
}

const CODE_BLOCK_RE = /```/
const RICH_THRESHOLD = 500

function hasRichContent(text: string) {
  return CODE_BLOCK_RE.test(text) || text.length > RICH_THRESHOLD
}

async function sendRichText(chat_id: string, text: string) {
  if (!client) throw new Error('feishu is not configured')
  if (!hasRichContent(text)) {
    return sendText(chat_id, text)
  }
  const card = {
    config: { wide_screen_mode: true },
    header: { template: 'grey', title: { tag: 'plain_text', content: 'Reply' } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  }
  return client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chat_id,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  })
}

// Per-chat progress state. While Claude is thinking, we tag the user's
// inbound message with an eyes reaction and — if Claude takes too long —
// post a "still working" placeholder that the reply tool later rewrites
// into the final answer (so the chat shows one message, not two).
type Pending = {
  inboundMessageId: string
  reactionId?: string
  transitionMessageId?: string
  timer?: ReturnType<typeof setTimeout>
}
const pendingByChat = new Map<string, Pending>()
const KEEPALIVE_MS = 20_000
const PROGRESS_EMOJI = 'OK'

function clearPending(chat_id: string): Pending | undefined {
  const p = pendingByChat.get(chat_id)
  if (!p) return undefined
  if (p.timer) clearTimeout(p.timer)
  pendingByChat.delete(chat_id)
  return p
}

async function startProgress(chat_id: string, message_id: string) {
  const prev = clearPending(chat_id)
  const pending: Pending = { inboundMessageId: message_id }
  pendingByChat.set(chat_id, pending)

  if (prev?.transitionMessageId && client) {
    client.im.message.delete({ path: { message_id: prev.transitionMessageId } }).catch(() => {})
  }

  if (client) {
    client.im.messageReaction
      .create({
        path: { message_id },
        data: { reaction_type: { emoji_type: PROGRESS_EMOJI } },
      })
      .then(r => {
        const rid = r.data?.reaction_id
        if (rid && pendingByChat.get(chat_id) === pending) pending.reactionId = rid
      })
      .catch(() => {})
  }

  pending.timer = setTimeout(() => {
    if (!client || pendingByChat.get(chat_id) !== pending) return
    client.im.message
      .create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chat_id,
          msg_type: 'text',
          content: JSON.stringify({ text: '⏳ still working on it...' }),
        },
      })
      .then(r => {
        const mid = r.data?.message_id
        if (mid && pendingByChat.get(chat_id) === pending) pending.transitionMessageId = mid
      })
      .catch(() => {})
  }, KEEPALIVE_MS)
}

async function finishProgress(chat_id: string, text: string) {
  if (!client) throw new Error('feishu is not configured')
  const pending = clearPending(chat_id)

  if (pending?.reactionId && pending.inboundMessageId) {
    client.im.messageReaction
      .delete({
        path: { message_id: pending.inboundMessageId, reaction_id: pending.reactionId },
      })
      .catch(() => {})
  }

  // Clean up the keepalive transition message if it exists.
  // Note: im.message.patch only supports interactive cards, not text messages,
  // so we always send a fresh reply rather than patching the transition message.
  if (pending?.transitionMessageId) {
    client.im.message
      .delete({ path: { message_id: pending.transitionMessageId } })
      .catch(() => {})
  }

  await sendRichText(chat_id, text)
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply on Feishu. Pass the chat_id from the inbound <channel> tag, or omit to use the last active conversation. Attach files by passing absolute file paths.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The conversation to reply in (optional — defaults to last active)' },
          text: { type: 'string', description: 'The message to send' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths to attach. Images (.jpg/.png/.gif/.webp/.bmp) send as inline images; other types as documents. Max 20MB each.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'notify',
      description:
        'Push a progress update to Feishu during long-running work. ' +
        'Unlike reply, this does NOT consume the inbound message — the reaction and keepalive stay active. ' +
        'Call this between major steps (at most every few turns, not every turn) so the user can monitor remotely. ' +
        'Renders as a small grey/blue/yellow card, visually distinct from reply text.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The conversation to notify (required — typically the inbound chat_id)' },
          text: { type: 'string', description: 'One-line progress message' },
          kind: {
            type: 'string',
            enum: ['status', 'milestone', 'warning'],
            description: 'Card style: status (grey), milestone (blue), warning (yellow). Defaults to status.',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'download_attachment',
      description: 'Download an image or file attachment from a Feishu message to the local inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'The message_id from the inbound channel meta' },
          file_key: { type: 'string', description: 'The image_key or file_key from the inbound channel meta' },
          type: { type: 'string', description: 'Resource type: "image", "file", "audio", or "media"' },
        },
        required: ['message_id', 'file_key', 'type'],
      },
    },
    {
      name: 'react',
      description:
        'Add an emoji reaction to a Feishu message. ' +
        'Use this to acknowledge receipt or signal status without sending a full text reply. ' +
        'Valid emoji types include: OK, THUMBSUP, HEART, SMILE, LAUGH, THINKING, DONE, CLAP, FIRE, and many more.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'The message_id from the inbound channel meta' },
          emoji_type: { type: 'string', description: 'Feishu emoji type, e.g. THUMBSUP, OK, HEART, SMILE' },
        },
        required: ['message_id', 'emoji_type'],
      },
    },
    {
      name: 'pair',
      description:
        'Authorize a new Feishu sender using the 6-character pairing code they received. ' +
        'Call this when the user says things like "pair ABC123" or "my code is ABC123".',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The 6-character pairing code' },
        },
        required: ['code'],
      },
    },
    {
      name: 'pair_group',
      description:
        'Authorize a Feishu group chat so the bot responds to @-mentions from paired users in it. ' +
        'Call when the user says things like "pair_group oc_xxx" or "allow group oc_xxx". ' +
        'Manual alternative to the approval card sent when the bot is added to a new group.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The group chat_id (starts with oc_)' },
        },
        required: ['chat_id'],
      },
    },
    {
      name: 'configure',
      description:
        'Save Feishu app credentials and start the bot. Call when the user provides ' +
        'FEISHU_APP_ID / FEISHU_APP_SECRET for the first time.',
      inputSchema: {
        type: 'object',
        properties: {
          app_id: { type: 'string', description: 'Feishu app id (starts with cli_)' },
          app_secret: { type: 'string', description: 'Feishu app secret' },
        },
        required: ['app_id', 'app_secret'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const args = req.params.arguments as { chat_id?: string; text: string; files?: string[] }
    const chat_id = args.chat_id ?? lastChatId
    if (!chat_id) {
      return {
        content: [{ type: 'text', text: 'no active Feishu conversation yet — send a message from Feishu first' }],
        isError: true,
      }
    }
    if (!client) throw new Error('feishu is not configured')

    const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.ico'])
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024
    const MAX_FILE_BYTES = 20 * 1024 * 1024

    await finishProgress(chat_id, args.text)

    const results: string[] = []
    if (args.files && args.files.length > 0) {
      for (const f of args.files) {
        assertSendable(f)
        const stat = statSync(f)
        const ext = extname(f).toLowerCase()
        const isImage = IMAGE_EXTS.has(ext)
        const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
        if (stat.size > limit) {
          results.push(`skipped ${f}: too large (${Math.round(stat.size / 1024 / 1024)}MB > ${Math.round(limit / 1024 / 1024)}MB)`)
          continue
        }
        if (isImage) {
          const upload = await client.im.image.create({
            data: { image_type: 'message', image: readFileSync(f) },
          })
          if (!upload?.image_key) { results.push(`failed to upload image: ${f}`); continue }
          await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chat_id, msg_type: 'image', content: JSON.stringify({ image_key: upload.image_key }) },
          })
          results.push(`sent image: ${f}`)
        } else {
          const upload = await client.im.file.create({
            data: { file_type: 'stream', file_name: f.split('/').pop() ?? 'file', file: readFileSync(f) },
          })
          if (!upload?.file_key) { results.push(`failed to upload file: ${f}`); continue }
          await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chat_id, msg_type: 'file', content: JSON.stringify({ file_key: upload.file_key }) },
          })
          results.push(`sent file: ${f}`)
        }
      }
    }

    const echo = `→ feishu: ${args.text}`
    const failures = results.filter(r => r.startsWith('skipped') || r.startsWith('failed'))
    for (const r of failures) stderrLogger.error(`reply attachment: ${r}`)
    return { content: failures.length > 0 ? [{ type: 'text', text: echo }, { type: 'text', text: failures.join('; ') }] : [{ type: 'text', text: echo }] }
  }
  if (req.params.name === 'notify') {
    const { chat_id, text, kind } = req.params.arguments as {
      chat_id: string; text: string; kind?: string
    }
    if (!client) throw new Error('feishu is not configured')
    const card = buildNotifyCard(kind ?? 'status', text)
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chat_id,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    return { content: [{ type: 'text', text: `notified ${chat_id}: ${text}` }] }
  }
  if (req.params.name === 'download_attachment') {
    const { message_id, file_key, type } = req.params.arguments as {
      message_id: string; file_key: string; type: string
    }
    const path = await downloadResource(message_id, file_key, type)
    if (!path) {
      return { content: [{ type: 'text', text: `download failed for ${file_key}` }], isError: true }
    }
    return { content: [{ type: 'text', text: path }] }
  }
  if (req.params.name === 'react') {
    const { message_id, emoji_type } = req.params.arguments as {
      message_id: string; emoji_type: string
    }
    if (!client) throw new Error('feishu is not configured')
    const res = await client.im.messageReaction.create({
      path: { message_id },
      data: { reaction_type: { emoji_type } },
    })
    const rid = res.data?.reaction_id ?? ''
    return { content: [{ type: 'text', text: rid ? `reacted ${emoji_type} (${rid})` : `reacted ${emoji_type}` }] }
  }
  if (req.params.name === 'pair') {
    const { code } = req.params.arguments as { code: string }
    const entry = consumePairCode(code.trim().toUpperCase())
    if (!entry) {
      return {
        content: [{ type: 'text', text: `pairing code not found or expired` }],
        isError: true,
      }
    }
    const access = loadAccess()
    if (!access.allowFrom.includes(entry.open_id)) {
      access.allowFrom.push(entry.open_id)
      saveAccess(access)
    }
    await sendText(entry.chat_id, 'Paired. You can now talk to the assistant.')
    return { content: [{ type: 'text', text: `paired ${entry.open_id}` }] }
  }
  if (req.params.name === 'pair_group') {
    const { chat_id } = req.params.arguments as { chat_id: string }
    const gid = chat_id.trim()
    if (!gid) {
      return { content: [{ type: 'text', text: 'chat_id is required' }], isError: true }
    }
    const access = loadAccess()
    if (access.allowGroups.includes(gid)) {
      return { content: [{ type: 'text', text: `group ${gid} already authorized` }] }
    }
    access.allowGroups.push(gid)
    saveAccess(access)
    if (client) {
      client.im.message
        .create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: gid,
            msg_type: 'text',
            content: JSON.stringify({ text: 'Group authorized. Paired users can @-mention me here.' }),
          },
        })
        .catch(e => stderrLogger.error('pair_group notify failed', String(e)))
    }
    return { content: [{ type: 'text', text: `authorized group ${gid}` }] }
  }
  if (req.params.name === 'configure') {
    const { app_id, app_secret } = req.params.arguments as {
      app_id: string
      app_secret: string
    }
    saveConfig({ app_id, app_secret })
    if (client) {
      return {
        content: [{
          type: 'text',
          text: 'credentials saved. restart Claude Code to pick up the new values.',
        }],
      }
    }
    startFeishu({ app_id, app_secret })
    return { content: [{ type: 'text', text: 'configured. feishu bot is now connected.' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

const decidedRequests = new Set<string>()

// --- Batched permission cards ---
// Instead of one card per tool call (which floods Feishu when Claude runs
// multiple tools in parallel), collect requests with a short debounce and
// send ONE card listing all pending approvals.

const PERM_BATCH_MS = 600
let permBatch: PermissionRequestParams[] = []
let permBatchTimer: ReturnType<typeof setTimeout> | null = null
let permBatchSeq = 0
const permBatchRidMap = new Map<string, string[]>()

type PermissionRequestParams = {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

function buildBatchCard(batchId: string, params: PermissionRequestParams[]) {
  const items = params
    .map(
      (r, i) =>
        `**${i + 1}. ${r.tool_name}**` +
        (r.description ? `\n${r.description}` : '') +
        (r.input_preview ? '\n```\n' + r.input_preview.slice(0, 300) + '\n```' : ''),
    )
    .join('\n\n')

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content:
          params.length === 1
            ? 'Claude permission request'
            : `Claude permission request (${params.length} pending)`,
      },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: items } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Allow All' },
            type: 'primary',
            value: { bid: batchId, d: 'allow' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Deny All' },
            type: 'danger',
            value: { bid: batchId, d: 'deny' },
          },
        ],
      },
    ],
  }
}

function buildPairCard(code: string, open_id: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: 'New user wants to connect' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `User \`${open_id}\` wants to talk to the assistant.\nPairing code: **${code}**`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Allow' },
            type: 'primary',
            value: { code, d: 'allow' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Deny' },
            type: 'danger',
            value: { code, d: 'deny' },
          },
        ],
      },
    ],
  }
}

function buildGroupApprovalCard(chat_id: string, chat_name: string, operator_open_id: string) {
  const safeName = chat_name || '(unnamed group)'
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: 'Bot added to a new group' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `Group: **${safeName}**\n` +
            `chat_id: \`${chat_id}\`\n` +
            `Added by: \`${operator_open_id || 'unknown'}\`\n\n` +
            `Allow the bot to respond to @-mentions from paired users in this group?`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Allow' },
            type: 'primary',
            value: { gid: chat_id, d: 'allow' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Deny' },
            type: 'danger',
            value: { gid: chat_id, d: 'deny' },
          },
        ],
      },
    ],
  }
}

async function sendGroupApprovalCardToAdmins(chat_id: string, chat_name: string, operator_open_id: string) {
  if (!client) return
  const access = loadAccess()
  if (access.allowGroups.includes(chat_id)) {
    stderrLogger.info(`group ${chat_id} already in allowGroups, skipping approval card`)
    return
  }
  if (access.allowFrom.length === 0) {
    stderrLogger.info('sendGroupApprovalCardToAdmins: no admins in access.json, skipping card')
    return
  }
  const card = buildGroupApprovalCard(chat_id, chat_name, operator_open_id)
  for (const open_id of access.allowFrom) {
    client.im.message
      .create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: open_id,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })
      .catch(e => stderrLogger.error('sendGroupApprovalCardToAdmins failed for', open_id, String(e)))
  }
}

function buildNotifyCard(kind: string, text: string) {
  const templates: Record<string, string> = { status: 'grey', milestone: 'blue', warning: 'yellow' }
  const labels: Record<string, string> = { status: 'Status', milestone: 'Milestone', warning: 'Warning' }
  return {
    config: { wide_screen_mode: false },
    header: {
      template: templates[kind] ?? 'grey',
      title: { tag: 'plain_text', content: labels[kind] ?? 'Status' },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  }
}

async function sendPairCardToAdmins(code: string, new_open_id: string) {
  if (!client) return
  const access = loadAccess()
  if (access.allowFrom.length === 0) {
    stderrLogger.info('sendPairCardToAdmins: no admins in access.json, skipping card')
    return
  }
  const card = buildPairCard(code, new_open_id)
  for (const open_id of access.allowFrom) {
    client.im.message
      .create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: open_id,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })
      .catch(e => stderrLogger.error('sendPairCardToAdmins failed for', open_id, String(e)))
  }
}

function flushPermBatch() {
  if (!client || permBatch.length === 0) return
  const batch = permBatch
  permBatch = []
  permBatchTimer = null

  const batchId = `b${++permBatchSeq}`
  const rids = batch.map(r => r.request_id)
  const card = buildBatchCard(batchId, batch)
  const access = loadAccess()
  for (const open_id of access.allowFrom) {
    client.im.message
      .create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: open_id,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })
      .catch(() => {})
  }

  permBatchRidMap.set(batchId, rids)
  setTimeout(() => permBatchRidMap.delete(batchId), 5 * 60 * 1000)
}

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!client) return

  permBatch.push({
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
  })

  if (permBatchTimer) clearTimeout(permBatchTimer)
  permBatchTimer = setTimeout(flushPermBatch, PERM_BATCH_MS)
})

const PERM_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const eventDispatcher = new lark.EventDispatcher({ logger: stderrLogger }).register({
  'im.chat.member.bot.added_v1': async data => {
    const { chat_id, name, operator_id } = data as {
      chat_id?: string
      name?: string
      operator_id?: { open_id?: string }
    }
    if (!chat_id) return
    stderrLogger.info(`bot added to chat ${chat_id} (${name ?? '?'}) by ${operator_id?.open_id ?? '?'}`)
    await sendGroupApprovalCardToAdmins(chat_id, name ?? '', operator_id?.open_id ?? '')
  },
  'im.message.receive_v1': async data => {
    const { message, sender } = data as {
      message: {
        chat_id: string
        message_id: string
        content: string
        message_type: string
        chat_type?: string
        mentions?: Array<{ key: string; id?: { open_id?: string }; name?: string }>
      }
      sender: { sender_id?: { open_id?: string } }
    }
    const access = loadAccess()
    const open_id = sender.sender_id?.open_id ?? ''
    if (!open_id) return

    const isGroup = message.chat_type === 'group'

    if (isGroup) {
      // Dual gate: group must be allowlisted AND sender must be paired AND bot must be @-mentioned.
      // All failures are silent to keep groups quiet.
      if (!access.allowGroups.includes(message.chat_id)) return
      if (!access.allowFrom.includes(open_id)) return
      if (!botOpenId) {
        stderrLogger.warn(`group message in ${message.chat_id} but bot open_id not yet resolved; ignoring`)
        return
      }
      const mentions = message.mentions ?? []
      if (!mentions.some(m => m.id?.open_id === botOpenId)) return
    } else if (!access.allowFrom.includes(open_id)) {
      const code = issuePairCode(open_id, message.chat_id)
      await sendText(
        message.chat_id,
        `You are not authorized yet.\n` +
          `Pairing code: ${code}\n` +
          `In the Claude Code terminal, say: pair ${code}\n` +
          `(valid for 10 minutes)`,
      )
      sendPairCardToAdmins(code, open_id)
      return
    }

    const rawContent = JSON.parse(message.content)

    // Feishu "post" (rich text) messages have nested content blocks — flatten them
    if (message.message_type === 'post' && Array.isArray(rawContent.content)) {
      const blocks = rawContent.content.flat()
      const imgBlock = blocks.find((b: any) => b.tag === 'img')
      const textBlocks = blocks.filter((b: any) => b.tag === 'text')
      if (imgBlock) rawContent.image_key = imgBlock.image_key
      if (textBlocks.length > 0) rawContent.text = textBlocks.map((b: any) => b.text).join('')
    }

    const parsed = rawContent as { text?: string; image_key?: string; file_key?: string; file_name?: string }
    let text = parsed.text ?? ''
    const extraMeta: Record<string, string> = {}

    // Handle attachments — check content keys regardless of message_type
    // Sticker must be handled before generic image_key (its resources can't be downloaded)
    if (message.message_type === 'sticker' && parsed.image_key) {
      extraMeta['sticker_key'] = parsed.image_key
      if (!text) text = '(sticker)'
    } else if (parsed.file_key) {
      const resType = message.message_type === 'audio' ? 'audio' : message.message_type === 'media' ? 'media' : 'file'
      const path = await downloadResource(message.message_id, parsed.file_key, resType)
      extraMeta['file_key'] = parsed.file_key
      if (path) extraMeta['file_path'] = path
      if (!text) {
        if (resType === 'audio') text = '(audio)'
        else if (resType === 'media') text = `(media: ${parsed.file_name ?? 'video'})`
        else text = '(file)'
      }
    }
    if (parsed.image_key && message.message_type !== 'sticker') {
      const path = await downloadResource(message.message_id, parsed.image_key, 'image')
      extraMeta['image_key'] = parsed.image_key
      if (path) extraMeta['image_path'] = path
      if (!text) text = '(image)'
    }

    // In groups, strip the @bot placeholder (Feishu emits literal "@_user_N" in text where
    // mentions[].key matches) so Claude sees just the user's words.
    if (isGroup && botOpenId) {
      const botMention = (message.mentions ?? []).find(m => m.id?.open_id === botOpenId)
      if (botMention?.key) {
        text = text.split(botMention.key).join('').replace(/\s+/g, ' ').trim()
      }
    }

    const m = PERM_RE.exec(text)
    if (m) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: m[2].toLowerCase(),
          behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      })
      return
    }

    // If Claude is still processing a previous message from this chat,
    // let the user know the new message landed but will be handled later.
    // Placed after the permission-command short-circuit so yes/no replies
    // don't trigger a misleading busy card.
    if (pendingByChat.has(message.chat_id) && client) {
      const busyCard = buildNotifyCard(
        'warning',
        'Message received. Claude is currently busy and will see this when the current operation finishes.',
      )
      client.im.message
        .create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: message.chat_id,
            msg_type: 'interactive',
            content: JSON.stringify(busyCard),
          },
        })
        .catch(() => {})
    }

    void startProgress(message.chat_id, message.message_id)

    lastChatId = message.chat_id

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: {
          chat_id: message.chat_id,
          message_id: message.message_id,
          open_id,
          ...extraMeta,
        },
      },
    })
  },
  'card.action.trigger': async data => {
    const d = data as {
      action?: { value?: Record<string, string> }
      operator?: { open_id?: string }
    }
    const value = d.action?.value ?? {}
    const decision = value['d'] as 'allow' | 'deny' | undefined
    const open_id = d.operator?.open_id ?? ''
    if (!decision || !open_id) return
    const access = loadAccess()
    if (!access.allowFrom.includes(open_id)) return

    const pairingCode = value['code']
    const bid = value['bid']
    const rid = value['rid']
    const gid = value['gid']

    // Group approval card: allow/deny a group
    if (gid) {
      if (decision === 'allow') {
        try {
          const updated = loadAccess()
          if (!updated.allowGroups.includes(gid)) {
            updated.allowGroups.push(gid)
            saveAccess(updated)
          }
        } catch (e) {
          stderrLogger.error('group approval saveAccess failed', String(e))
          return { toast: { type: 'error', content: 'Approval failed.' } }
        }
        // Best-effort heads-up in the group itself so paired users know they can now @ the bot.
        if (client) {
          client.im.message
            .create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: gid,
                msg_type: 'text',
                content: JSON.stringify({ text: 'Group authorized. Paired users can @-mention me here.' }),
              },
            })
            .catch(e => stderrLogger.error('group approval notify failed', String(e)))
        }
        return { toast: { type: 'success', content: 'Group authorized.' } }
      }
      if (decision === 'deny') {
        return { toast: { type: 'warning', content: 'Group denied.' } }
      }
    }

    // Pairing card: approve/deny a new user
    if (pairingCode) {
      if (decision === 'allow') {
        const pending = pendingByCode.get(pairingCode)
        if (!pending || pending.expiresAt < Date.now()) {
          return { toast: { type: 'warning', content: 'Pairing code expired or already handled.' } }
        }
        try {
          const updated = loadAccess()
          if (!updated.allowFrom.includes(pending.open_id)) {
            updated.allowFrom.push(pending.open_id)
            saveAccess(updated)
          }
        } catch (e) {
          stderrLogger.error('pairing card saveAccess failed', String(e))
          return { toast: { type: 'error', content: 'Approval failed. Please try the terminal pair command.' } }
        }
        consumePairCode(pairingCode)
        const sendOk = await sendText(pending.chat_id, 'Paired. You can now talk to the assistant.')
          .then(() => true)
          .catch(e => {
            stderrLogger.error('pairing card sendText failed', String(e))
            return false
          })
        return {
          toast: {
            type: sendOk ? 'success' : 'warning',
            content: sendOk ? 'User approved.' : 'User approved but notification failed — they may not know they are paired.',
          },
        }
      }
      // Deny
      if (decision === 'deny') {
        const entry = consumePairCode(pairingCode)
        if (entry) {
          sendText(entry.chat_id, 'Your pairing request was denied.').catch(e =>
            stderrLogger.error('pairing card deny sendText failed', String(e)),
          )
        }
        return {
          toast: {
            type: 'warning',
            content: entry ? 'User denied.' : 'Pairing code expired or already handled.',
          },
        }
      }
    }

    // Batch card: resolve rids from batch map
    if (bid) {
      const rids = permBatchRidMap.get(bid)
      if (!rids || rids.length === 0) {
        return { toast: { type: 'info', content: 'Already handled.' } }
      }
      permBatchRidMap.delete(bid)

      for (const r of rids) {
        if (decidedRequests.has(r)) continue
        decidedRequests.add(r)
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: r, behavior: decision },
        })
      }

      return {
        toast: {
          type: decision === 'allow' ? 'success' : 'warning',
          content:
            decision === 'allow'
              ? `Allowed ${rids.length} request${rids.length > 1 ? 's' : ''}.`
              : `Denied ${rids.length} request${rids.length > 1 ? 's' : ''}.`,
        },
      }
    }

    // Legacy single-request card
    if (!rid) return
    if (decidedRequests.has(rid)) {
      return { toast: { type: 'info', content: 'Already handled.' } }
    }
    decidedRequests.add(rid)

    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: rid, behavior: decision },
    })

    return {
      toast: {
        type: decision === 'allow' ? 'success' : 'warning',
        content: decision === 'allow' ? 'Allowed.' : 'Denied.',
      },
    }
  },
})

function startFeishu(cfg: Config) {
  const opts = { appId: cfg.app_id, appSecret: cfg.app_secret, logger: stderrLogger }
  client = new lark.Client(opts)
  wsClient = new lark.WSClient(opts)
  wsClient.start({ eventDispatcher })
  void resolveBotIdentity()
}

const initialConfig = loadConfig()
if (initialConfig) startFeishu(initialConfig)

await mcp.connect(new StdioServerTransport())

process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
