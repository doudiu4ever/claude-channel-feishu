import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import * as lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

const ACCESS_FILE = process.env.FEISHU_ACCESS_FILE ?? './access.json'
const CONFIG_FILE =
  process.env.FEISHU_CONFIG_FILE ??
  join(homedir(), '.claude', 'channels', 'feishu', 'config.json')

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

type Access = { allowFrom: string[] }
const saveAccess = (access: Access) =>
  writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2) + '\n')
const loadAccess = (): Access => {
  if (!existsSync(ACCESS_FILE)) saveAccess({ allowFrom: [] })
  return JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
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
      'Messages from Feishu arrive as <channel source="feishu" chat_id="..." open_id="...">. ' +
      'Reply with the reply tool, passing the chat_id from the tag. ' +
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

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply on Feishu. Pass the chat_id from the inbound <channel> tag.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The conversation to reply in' },
          text: { type: 'string', description: 'The message to send' },
        },
        required: ['chat_id', 'text'],
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
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    await sendText(chat_id, text)
    return { content: [{ type: 'text', text: 'sent' }] }
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

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!client) return
  const access = loadAccess()
  const text =
    `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
    `Reply "yes ${params.request_id}" or "no ${params.request_id}"`
  for (const open_id of access.allowFrom) {
    await client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: open_id,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
  }
})

const PERM_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async data => {
    const { message, sender } = data as {
      message: { chat_id: string; message_id: string; content: string }
      sender: { sender_id?: { open_id?: string } }
    }
    const access = loadAccess()
    const open_id = sender.sender_id?.open_id ?? ''
    if (!open_id) return

    if (!access.allowFrom.includes(open_id)) {
      const code = issuePairCode(open_id, message.chat_id)
      await sendText(
        message.chat_id,
        `You are not authorized yet.\n` +
          `Pairing code: ${code}\n` +
          `In the Claude Code terminal, say: pair ${code}\n` +
          `(valid for 10 minutes)`,
      )
      return
    }

    const parsed = JSON.parse(message.content) as { text?: string }
    const text = parsed.text ?? ''

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

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: {
          chat_id: message.chat_id,
          message_id: message.message_id,
          open_id,
        },
      },
    })
  },
})

function startFeishu(cfg: Config) {
  client = new lark.Client({ appId: cfg.app_id, appSecret: cfg.app_secret })
  wsClient = new lark.WSClient({ appId: cfg.app_id, appSecret: cfg.app_secret })
  wsClient.start({ eventDispatcher })
}

const initialConfig = loadConfig()
if (initialConfig) startFeishu(initialConfig)

await mcp.connect(new StdioServerTransport())

process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
