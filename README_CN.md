# claude-channel-feishu

将飞书机器人连接到你的 Claude Code 会话。

机器人收到的消息会以 channel 事件的形式出现在 Claude Code 终端中；Claude 通过 `reply` 工具回复消息。工具调用的权限提示也可以转发到飞书，让你直接在手机上远程审批。

> 这是一个 [Claude Code channel](https://code.claude.com/docs/en/channels-reference) —— 一个具备 `claude/channel` 能力的 MCP 服务器。参照官方 [Telegram channel](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) 构建。

## 前置条件

- **Node 18+**（服务器使用 `tsx` 运行）。
- **飞书自建应用**，需满足以下配置：
  - 已开启**机器人**能力。
  - **事件**订阅设为**长连接**模式（无需公网地址），已订阅 `im.message.receive_v1`。
  - **回调**订阅（在「事件与回调」的独立标签页下）也设为**长连接**模式，已订阅 `card.action.trigger` —— 这是权限提示卡片中允许/拒绝按钮的驱动机制。缺少此项，点击卡片会报错 200340。
  - （可选，群聊支持需要）同时订阅 `im.chat.member.bot.added_v1` —— 机器人被加入新群时给 admin 发送审批卡片所必需。
  - 权限范围（Scopes）：`im:message`、`im:message:send_as_bot`、`im:chat:readonly`。
  - 已发布一个**正式版本**（开发者后台的修改只有发布后才会生效）。

还需要从飞书开发者后台获取应用的 **App ID**（`cli_...`）和 **App Secret**。

## 安装

在任意 Claude Code 会话中执行：

```
/plugin marketplace add https://github.com/doudiu4ever/claude-channel-feishu.git
/plugin install feishu@feishu-plugins
```

插件会安装到 `~/.claude/plugins/` 目录，首次启动时自动处理依赖。

## 启动

退出当前会话，然后带上 channel 标志重新启动：

```bash
claude --dangerously-load-development-channels plugin:feishu@feishu-plugins
```

> 在 channels 研究预览阶段，所有不在 Anthropic 白名单中的 channel 都需要 `--dangerously-load-development-channels` 标志。

## 配置（仅首次）

在 Claude Code 会话中，直接让 Claude 配置机器人即可，它会调用插件的 `configure` 工具写入你的凭据：

> "configure feishu，app id `cli_xxx`，app secret `xxx`"

凭据会写入 `~/.claude/channels/feishu/config.json`（权限 0600）。飞书 WebSocket 在同一进程内建立连接，无需重启。后续会话会自动加载已保存的配置。

如需按实例覆盖，可在 shell 中导出 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` —— 环境变量优先于配置文件。

## 配对（每个发送方首次使用）

访问权限通过飞书 `open_id` 控制。未授权用户首次私信机器人时，机器人会回复一个 6 位配对码：

```
You are not authorized yet.
Pairing code: ABC123
In the Claude Code terminal, say: pair ABC123
```

在你的 Claude Code 会话中说：

> "pair ABC123"

如果已有管理员完成配对，他们会收到带有**允许** / **拒绝**按钮的交互卡片 —— 点一下允许即可授权新用户。

Claude 调用 `pair` 工具后，机器人会私信 "Paired."，你的 `open_id` 会追加到 `~/.claude/channels/feishu/access.json`。配对码 10 分钟后过期。

## 使用方法

完成配置和配对后：

- **私信机器人** → 消息以 `<channel source="feishu" ...>` 事件的形式出现在终端中，Claude 可以调用 `reply` 工具回复。
- **权限转发** —— 若 Claude 尝试运行需要审批的工具（如 `Bash`），提示会以带**允许** / **拒绝**按钮的交互卡片形式转发给白名单用户。点击按钮即可将结果返回给 Claude，无需操作终端。也可用文字 `yes <id>` / `no <id>` 作为备用方式。

## 群聊

机器人也支持群聊，采用**双重门禁**保证安全：消息只有在**三个条件同时满足**时才会被处理 —— 群在 `allowGroups`、发送人在 `allowFrom`、且机器人被 **@-提及**。任何一项不满足均静默忽略（群里不会出现配对码刷屏）。

配置流程：

1. 把机器人拉进飞书群聊。机器人会私信每个 admin 一张带群 `chat_id` 的允许/拒绝审批卡。
2. 点击**允许** → 该 `chat_id` 写入 `~/.claude/channels/feishu/access.json` 的 `allowGroups` 字段。
3. 群里尚未配对的成员需要**先私信机器人**走标准配对流程 —— 群里会静默忽略未授权成员，不会有任何提示。
4. 已配对成员在群里 `@机器人 <消息内容>` 即可与 Claude 对话；不被 @ 时机器人会忽略。

如果错过了审批卡，或想手动授权，可在终端让 Claude 调用：`pair_group oc_xxxxxxx`。

需开启飞书后台 `im.chat.member.bot.added_v1` 事件订阅（见上文「前置条件」）。

## 开发模式

如果你想在本地修改插件，而不是通过安装方式使用：

```bash
git clone https://github.com/doudiu4ever/claude-channel-feishu.git
cd claude-channel-feishu
npm install
claude --dangerously-load-development-channels server:feishu
```

`server:feishu` 方式会直接读取仓库的 `.mcp.json`。开发模式下，wrapper 运行 `tsx server.ts`，修改 `server.ts` 后重启会话即可生效。

发布变更前，需先重新构建插件模式所使用的 bundle：

```bash
npm run build
```

`dist/server.mjs` 是插件运行时加载的自包含 bundle，安装方不需要执行 `npm install`，因此首次启动即时生效。

## 文件说明

| 路径 | 用途 |
|---|---|
| `.claude-plugin/plugin.json` | 插件元数据 |
| `.claude-plugin/marketplace.json` | 单插件市场描述符 |
| `.mcp.json` | MCP 启动包装脚本（bash，首次运行时安装依赖） |
| `server.ts` | Channel 服务器实现 |
| `~/.claude/channels/feishu/config.json` | APP_ID / APP_SECRET（权限 0600，由 `configure` 工具创建） |
| `~/.claude/channels/feishu/access.json` | 已配对的 `open_id` 白名单（自动创建） |

## 飞书后台配置步骤

1. 前往[飞书开放平台](https://open.feishu.cn) → **我的应用** → 选择你的自建应用。
2. **添加应用能力** → 开启**机器人**。
3. **事件与回调**：
   - **事件订阅**：设为**长连接**模式，订阅 `im.message.receive_v1`。如需群聊支持，再订阅 `im.chat.member.bot.added_v1`。
   - **回调订阅**（独立标签页）：也设为**长连接**模式，订阅 `card.action.trigger` —— 这是交互卡片允许/拒绝按钮的驱动机制。
4. **权限管理**（Scopes）：添加 `im:message`、`im:message:send_as_bot`、`im:chat:readonly`。
5. **版本管理** → **发布**（修改只有发布后才会生效）。

还需要从应用的**凭证与基本信息**页面获取 **App ID**（`cli_...`）和 **App Secret**。

## 功能状态

已实现：

- 文本消息及图片/文件/音频/媒体附件（收发均支持）。
- 权限审批和新用户配对的交互消息卡片。
- `download_attachment` 工具，配合 `reply` 发送文件。
- 进度指示（长操作期间发送 OK 表情反应 + 保活消息）。

尚未实现：

- `edit_message` 工具（飞书仅允许对交互卡片做 patch，文本不行）。
- 离线消息队列（机器人仅在 Claude Code 运行期间接收消息）。

完整功能规划见 `ROADMAP.md`，架构说明见 `CLAUDE.md`。

## 许可证

Apache-2.0
