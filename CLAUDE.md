# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DM-Plz is a Claude Code plugin that sends Telegram or Discord notifications when Claude needs user input or wants to report progress. It's an MCP (Model Context Protocol) server that runs locally via stdio.

## Development Commands

```bash
cd server

# Install dependencies
bun install

# Run development server with hot reload
bun run dev

# Run the MCP server directly
bun run start

# Test your Telegram/Discord configuration
bun run test

# Full plugin startup command (install + run)
bun run mcp
```

### Testing Configuration

Set environment variables before running tests:

**Telegram:**

```bash
export DMPLZ_PROVIDER=telegram
export DMPLZ_TELEGRAM_BOT_TOKEN="your_token"
export DMPLZ_TELEGRAM_CHAT_ID="your_chat_id"
bun run test
```

**Discord:**

```bash
export DMPLZ_PROVIDER=discord
export DMPLZ_DISCORD_BOT_TOKEN="your_token"
export DMPLZ_DISCORD_CHANNEL_ID="your_channel_id"
bun run test
```

## Architecture

### MCP Server Design

The server uses the `@modelcontextprotocol/sdk` to expose tools to Claude Code via stdio transport:

- **Tools exposed**: `send_message`, `ask_question`, `send_notification`, `request_permission`
- **Communication**: stdio-based MCP protocol (no HTTP server)
- **Message polling**: Telegram uses 10s intervals, Discord uses 2s intervals

### Provider Pattern

`server/src/providers/` contains the messaging provider implementations:

- `index.ts` - Factory function `createProvider()` that instantiates the correct provider based on config
- `telegram.ts` - `TelegramProvider` class implementing `MessagingProvider` interface
- `discord.ts` - `DiscordProvider` class implementing `MessagingProvider` interface

All providers implement the `MessagingProvider` interface defined in `types.ts`:

- `sendMessage()` - Send one-way notification
- `waitForReply()` - Send message and poll for user response
- `requestPermission()` - Send approval request with buttons/reactions
- `getInfo()` - Get bot information for connection verification

### Hook System

The plugin uses Claude Code hooks defined in `.claude-plugin/plugin.json`:

- **PreToolUse (AskUserQuestion)**: `question-hook.ts` - Intercepts questions to route through Telegram/Discord
- **PermissionRequest**: `permission-hook.ts` - Routes permission dialogs to Telegram/Discord
- **Stop**: `stop-hook.ts` - Sends work summary when Claude stops and waits for next instruction

Hooks communicate via stdin (JSON input) and exit codes:

- Exit code 0: Normal completion
- Exit code 2: Continuation request (stderr contains JSON with `reason` field for next user message)

### Configuration Flow

1. Environment variables loaded via `loadConfig()` in each entry point
2. Provider-specific validation (Telegram requires bot token + chat ID, Discord requires bot token + channel ID)
3. Config passed to provider factory to instantiate correct `MessagingProvider`

## Key Files

| File                            | Purpose                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `server/src/index.ts`           | Main MCP server entry point                                |
| `server/src/types.ts`           | TypeScript interfaces for config, providers, and API types |
| `server/src/providers/`         | Telegram and Discord provider implementations              |
| `server/src/stop-hook.ts`       | Stop hook that sends summary and waits for continuation    |
| `server/src/permission-hook.ts` | Permission request hook handler                            |
| `server/src/question-hook.ts`   | Question routing hook handler                              |
| `.claude-plugin/plugin.json`    | Plugin configuration with hook definitions                 |

## Environment Variables

| Variable                    | Required               | Description                             |
| --------------------------- | ---------------------- | --------------------------------------- |
| `DMPLZ_PROVIDER`            | No (default: telegram) | `telegram` or `discord`                 |
| `DMPLZ_TELEGRAM_BOT_TOKEN`  | Yes (Telegram)         | Bot token from @BotFather               |
| `DMPLZ_TELEGRAM_CHAT_ID`    | Yes (Telegram)         | Chat ID from @userinfobot               |
| `DMPLZ_DISCORD_BOT_TOKEN`   | Yes (Discord)          | Bot token from Discord Developer Portal |
| `DMPLZ_DISCORD_CHANNEL_ID`  | Yes (Discord)          | Target channel ID                       |
| `DMPLZ_QUESTION_TIMEOUT_MS` | No (default: 10800000) | Reply wait timeout (3 hours)            |
