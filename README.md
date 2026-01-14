# DM-Plz

**English** | 한국어(./README.ko.md)

**Get Telegram or Discord notifications when Claude Code needs your input.**

Inspired by [call-me](https://github.com/ZeframLou/call-me), DM-Plz lets Claude send you messages via Telegram or Discord when it completes tasks, needs decisions, or wants to report progress. Perfect for long-running tasks where you don't want to watch Claude work.

## Features

- **Multiple platforms** - Choose between Telegram or Discord
- **Simple notifications** - Get updates without phone calls
- **Ask questions** - Claude can ask you questions and wait for your response
- **No complex setup** - Just a bot token and channel/chat ID
- **Free** - Both Telegram and Discord Bot APIs are completely free
- **Async friendly** - Reply at your own pace, no real-time pressure

---

## Quick Start

Choose your preferred platform:

### Option 1: Telegram

#### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Give your bot a name (e.g., "Claude Code Bot")
4. Give your bot a username (e.g., "my_claude_code_bot")
5. Copy the **bot token** you receive (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

#### 2. Get Your Chat ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. Copy your **Chat ID** (a number like `123456789`)

#### 3. Configure Environment Variables

Add these to `~/.claude/settings.json`:

```json
{
  "env": {
    "DMPLZ_PROVIDER": "telegram",
    "DMPLZ_TELEGRAM_BOT_TOKEN": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "DMPLZ_TELEGRAM_CHAT_ID": "123456789"
  }
}
```

### Option 2: Discord

#### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to "Bot" section and click "Add Bot"
4. Under "Token", click "Copy" to get your **bot token**
5. Enable "MESSAGE CONTENT INTENT" under Privileged Gateway Intents

#### 2. Invite Bot to Your Server

1. Go to "OAuth2" > "URL Generator"
2. Select scopes: `bot`
3. Select permissions: `Send Messages`, `Read Messages`, `Read Message History`
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

#### 3. Get Channel ID

1. Enable Developer Mode in Discord (Settings > Advanced > Developer Mode)
2. Right-click the channel where you want notifications
3. Click "Copy ID" to get your **Channel ID**
4. (Optional) If you want permission requests in DMs, also copy your **User ID** (right-click your profile)

#### 4. Configure Environment Variables

Add these to `~/.claude/settings.json`:

```json
{
  "env": {
    "DMPLZ_PROVIDER": "discord",
    "DMPLZ_DISCORD_BOT_TOKEN": "your_discord_bot_token_here",
    "DMPLZ_DISCORD_CHANNEL_ID": "123456789012345678",
    "DMPLZ_DISCORD_DM_USER_ID": "123456789012345678",
    "DMPLZ_PERMISSION_CHAT_ID": "123456789012345678"
  }
}
```

---

## Installation

```bash
# Install from local directory
/plugin marketplace add /path/to/dm-plz
/plugin install dm-plz@dm-plz
```

Or if published to GitHub:

```bash
/plugin marketplace add yourusername/dm-plz
/plugin install dm-plz@dm-plz
```

Restart Claude Code. Done!

---

## Configuration Variables

| Variable                    | Required                 | Description                                      |
| --------------------------- | ------------------------ | ------------------------------------------------ |
| `DMPLZ_PROVIDER`            | No (default: `telegram`) | Platform to use: `telegram` or `discord`         |
| `DMPLZ_TELEGRAM_BOT_TOKEN`  | Yes (for Telegram)       | Bot token from @BotFather                        |
| `DMPLZ_TELEGRAM_CHAT_ID`    | Yes (for Telegram)       | Your personal chat ID from @userinfobot          |
| `DMPLZ_DISCORD_BOT_TOKEN`   | Yes (for Discord)        | Bot token from Discord Developer Portal          |
| `DMPLZ_DISCORD_CHANNEL_ID`  | Yes (for Discord)        | Channel ID (enable Developer Mode to copy)       |
| `DMPLZ_DISCORD_DM_USER_ID`  | No (Discord)             | User ID for sending permission requests via DM   |
| `DMPLZ_PERMISSION_CHAT_ID`  | No                       | Override chat/channel ID for permission requests |
| `DMPLZ_QUESTION_TIMEOUT_MS` | No (default: `10800000`) | Timeout for waiting for responses (3 hours)      |

Permission requests use `DMPLZ_PERMISSION_CHAT_ID` first if set, otherwise `DMPLZ_DISCORD_DM_USER_ID` (Discord only), and finally the default chat/channel.

---

## How It Works

```
Claude Code                DM-Plz MCP Server (local)
    ??                             ??
    ?? "Task completed!"          ??
    ??                             ??
Plugin ?�?�?�?�?�?�stdio?�?�?�?�?�?�?�?�?�?�?�??MCP Server
                                   ??
                                   ??HTTPS
                                   ??
                    Telegram Bot API / Discord API
                                   ??
                                   ??
                       Your Telegram / Discord app
```

The MCP server runs locally and uses the bot API with polling (no webhooks needed).

---

## Tools

### `send_message`

Send a simple notification message.

```typescript
await send_message({
  message: "Build completed successfully! ??,
  parse_mode: "Markdown" // optional
});
```

### `ask_question`

Ask a question and wait for the user's reply.

```typescript
const response = await ask_question({
  question: "I found 3 bugs. Should I fix them now or create issues?",
  parse_mode: "Markdown", // optional
});
// User's response is returned as text
```

### `send_notification`

Send a notification with a title and detailed message.

```typescript
await send_notification({
  title: "Deployment Complete",
  message:
    "Successfully deployed to production\n??15 files changed\n??0 errors\n??2 warnings",
  parse_mode: "Markdown", // optional
});
```

---

## Usage Examples

### Task Completion Notification

```
Claude: *finishes implementing authentication*
Claude: Uses send_message("Authentication system implemented! Added JWT tokens, login/logout, and password hashing.")
You: *receive notification on Telegram/Discord*
```

### Interactive Decision Making

```
Claude: *finds multiple approaches to solve a problem*
Claude: Uses ask_question("I can implement caching with Redis or in-memory. Which do you prefer?")
You: *reply on Telegram/Discord* "In-memory for now"
Claude: *continues with your choice*
```

### Progress Updates

```
Claude: *running tests*
Claude: Uses send_notification(title: "Tests Running", message: "Running 250 tests... this may take a few minutes")
You: *can go do something else*
Claude: *finishes tests*
Claude: Uses send_notification(title: "Tests Complete", message: "All 250 tests passed ??)
```

---

## Automatic Triggers

The plugin includes a **Stop hook** that automatically prompts Claude to evaluate if it should notify you when it stops working. This means Claude will often proactively message you without being explicitly told to.

You can customize this behavior by editing `.claude-plugin/plugin.json`.

### ⚠️ Important: Stop Hook Conflicts

If you are using other plugins that also have Stop hooks (like `oh-my-claude-sisyphus`), they may conflict with DM-Plz's Stop hook. Only one Stop hook response will be used by Claude Code.

**To disable other Stop hooks in your project**, add this to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": []
  }
}
```

This ensures only DM-Plz's Stop hook runs when Claude stops working.

### 🔧 Stop Hook Installation (Required for Continue Feature)

Due to a Claude Code bug ([#10412](https://github.com/anthropics/claude-code/issues/10412)), Stop hooks installed via plugins cannot use the `continueInstruction` feature. To enable the "continue via DM" functionality, you need to install the Stop hook directly.

**Option 1: Using npm script (Recommended)**

```bash
cd /path/to/dm-plz/server
bun run install-stop-hook
```

This will add the Stop hook to your `~/.claude/settings.json`.

**Option 2: Manual installation**

Add this to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bun run \"/path/to/dm-plz/server/src/stop-hook.ts\"",
            "timeout": 300000
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/dm-plz` with the actual path where DM-Plz is installed.

**After installation**, restart Claude Code for the changes to take effect.

---

## Message Formatting

Both Markdown and HTML formatting are supported:

### Markdown (Recommended)

```
**bold** *italic* `code`
[link](https://example.com)
```

### HTML

```
<b>bold</b> <i>italic</i> <code>code</code>
<a href="https://example.com">link</a>
```

**Note**: Discord uses Markdown natively. HTML mode will be converted to Markdown for Discord.

---

## Costs

**$0.00** - Both Telegram and Discord Bot APIs are completely free!

---

## Comparison

| Feature          | Telegram               | Discord                   |
| ---------------- | ---------------------- | ------------------------- |
| Setup complexity | Very low               | Low                       |
| Personal DMs     | Yes                    | Yes (via channel)         |
| Markdown support | Yes                    | Yes (native)              |
| Rate limits      | Very generous          | Moderate                  |
| Polling speed    | 10s intervals          | 2s intervals              |
| Best for         | Personal notifications | Team/server notifications |

---

## Troubleshooting

### Claude doesn't use the tools

1. Check all environment variables are set in `~/.claude/settings.json`
2. Restart Claude Code after installing the plugin
3. Try explicitly: "Send me a message when you're done."

### Telegram: Messages not received

1. Verify bot token is correct
2. Make sure you've started a chat with your bot (send `/start`)
3. Check the chat ID is your personal chat ID (not a group)
4. Check MCP server logs with `claude --debug`

### Discord: Messages not received

1. Verify bot token and channel ID are correct
2. Make sure the bot has been invited to your server
3. Check bot has permissions: Send Messages, Read Messages, Read Message History
4. Verify MESSAGE CONTENT INTENT is enabled in Discord Developer Portal
5. Check MCP server logs with `claude --debug`

### Question timeout

1. Increase `DMPLZ_QUESTION_TIMEOUT_MS` if you need more time to respond
2. Make sure you're replying in the correct chat/channel

### API errors

1. Verify token format is correct
2. Check your internet connection
3. For Discord: Check bot hasn't been removed from server
4. For Telegram: Check bot hasn't been deleted by @BotFather

---

## Development

```bash
cd server
bun install
bun run dev
```

### Testing Your Configuration

Before using the plugin with Claude Code, you can test your configuration:

**Telegram:**

```bash
cd server
export DMPLZ_PROVIDER=telegram
export DMPLZ_TELEGRAM_BOT_TOKEN="your_token"
export DMPLZ_TELEGRAM_CHAT_ID="your_chat_id"
bun run test
```

**Discord:**

```bash
cd server
export DMPLZ_PROVIDER=discord
export DMPLZ_DISCORD_BOT_TOKEN="your_token"
export DMPLZ_DISCORD_CHANNEL_ID="your_channel_id"
bun run test
```

The test script will:

1. Verify your environment variables are set correctly
2. Test the connection to Telegram/Discord
3. Send a test message to confirm everything works

### Manual Testing

To test the server manually:

**Telegram:**

```bash
export DMPLZ_PROVIDER=telegram
export DMPLZ_TELEGRAM_BOT_TOKEN="your_token"
export DMPLZ_TELEGRAM_CHAT_ID="your_chat_id"
bun run src/index.ts
```

**Discord:**

```bash
export DMPLZ_PROVIDER=discord
export DMPLZ_DISCORD_BOT_TOKEN="your_token"
export DMPLZ_DISCORD_CHANNEL_ID="your_channel_id"
bun run src/index.ts
```

---

## Project Structure

```
dm-plz/
?��??� .claude-plugin/
??  ?��??� plugin.json          # Plugin configuration
??  ?��??� marketplace.json     # Marketplace metadata
?��??� server/
??  ?��??� src/
??  ??  ?��??� index.ts         # MCP server main
??  ??  ?��??� types.ts         # Type definitions
??  ??  ?��??� providers/
??  ??      ?��??� index.ts     # Provider factory
??  ??      ?��??� telegram.ts  # Telegram implementation
??  ??      ?��??� discord.ts   # Discord implementation
??  ?��??� package.json
?��??� .env.example
?��??� .gitignore
?��??� README.md
?��??� SETUP.md
```

---

## Contributing

Contributions are welcome! Please open an issue or PR.

---

## License

MIT

---

## Acknowledgments

- Inspired by [call-me](https://github.com/ZeframLou/call-me) by [@ZeframLou](https://github.com/ZeframLou)
- Referenced implementations:
  - [telegram-notification-mcp](https://github.com/kstonekuan/telegram-notification-mcp)
  - [claude-telegram-mcp](https://www.npmjs.com/package/@s1lverain/claude-telegram-mcp)
  - [innerVoice](https://github.com/RichardDillman/claude-telegram-bridge)
