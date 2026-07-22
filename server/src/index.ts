#!/usr/bin/env bun

/**
 * DM-Plz MCP Server
 *
 * A stdio-based MCP server that sends messages via Telegram/Discord
 * when Claude needs user input or wants to report progress.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createProvider } from './providers/index.js';
import type {
  ServerConfig,
  MessagingProvider,
  MediaKind,
  MediaSendResult,
} from './types.js';

/**
 * Loads server configuration from environment variables.
 */
function loadConfig(): ServerConfig {
  const provider = (process.env.DMPLZ_PROVIDER || 'telegram') as 'telegram' | 'discord';

  // Platform-specific token/chat ID
  let botToken: string | undefined;
  let chatId: string | undefined;

  if (provider === 'telegram') {
    botToken = process.env.DMPLZ_TELEGRAM_BOT_TOKEN;
    chatId = process.env.DMPLZ_TELEGRAM_CHAT_ID;

    if (!botToken) {
      throw new Error('DMPLZ_TELEGRAM_BOT_TOKEN environment variable is required for Telegram');
    }
    if (!chatId) {
      throw new Error('DMPLZ_TELEGRAM_CHAT_ID environment variable is required for Telegram');
    }
  } else if (provider === 'discord') {
    botToken = process.env.DMPLZ_DISCORD_BOT_TOKEN;
    chatId = process.env.DMPLZ_DISCORD_CHANNEL_ID;

    if (!botToken) {
      throw new Error('DMPLZ_DISCORD_BOT_TOKEN environment variable is required for Discord');
    }
    if (!chatId) {
      throw new Error('DMPLZ_DISCORD_CHANNEL_ID environment variable is required for Discord');
    }
  } else {
    throw new Error(`Unsupported provider: ${provider}. Use 'telegram' or 'discord'`);
  }

  const questionTimeoutMs = parseInt(
    process.env.DMPLZ_QUESTION_TIMEOUT_MS || '10800000',
    10
  );
  const permissionChatId = process.env.DMPLZ_PERMISSION_CHAT_ID || undefined;
  const discordDmUserId = process.env.DMPLZ_DISCORD_DM_USER_ID || undefined;
  // Invalid values fall back to the defaults rather than failing startup.
  const mediaMaxBytes = Number(process.env.DMPLZ_MEDIA_MAX_BYTES);
  const mediaTimeoutMs = Number(process.env.DMPLZ_MEDIA_TIMEOUT_MS || '120000');

  return {
    provider,
    botToken,
    chatId,
    questionTimeoutMs,
    rejectReasonTimeoutMs: Number(process.env.DMPLZ_REJECT_REASON_TIMEOUT_MS || '600000'),
    rejectReasonMaxChars: Number(process.env.DMPLZ_REJECT_REASON_MAX_CHARS || '300'),
    rejectReasonLogPath: process.env.DMPLZ_REJECT_REASON_LOG_PATH || '',
    rejectReasonLogRotateBytes: Number(
      process.env.DMPLZ_REJECT_REASON_LOG_ROTATE_BYTES || '10485760'
    ),
    rejectReasonLogMaxFiles: Number(process.env.DMPLZ_REJECT_REASON_LOG_MAX_FILES || '10'),
    rejectReasonNoReasonKeywords: (
      process.env.DMPLZ_REJECT_REASON_NO_REASON_KEYWORDS || 'no_reason'
    ).split(','),
    permissionChatId,
    discordDmUserId,
    mediaEnabled: process.env.DMPLZ_MEDIA_ENABLED?.toLowerCase() !== 'false',
    mediaMaxBytes: Number.isFinite(mediaMaxBytes) && mediaMaxBytes > 0 ? mediaMaxBytes : undefined,
    mediaTimeoutMs: Number.isFinite(mediaTimeoutMs) && mediaTimeoutMs > 0 ? mediaTimeoutMs : 120000,
  };
}

/**
 * Initializes and runs the MCP server.
 */
async function main() {
  // Load configuration
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Create messaging provider
  let messagingProvider: MessagingProvider;
  try {
    messagingProvider = createProvider(config);
  } catch (error) {
    console.error('Provider error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Verify bot connection
  console.error(`Connecting to ${config.provider}...`);
  try {
    const info = await messagingProvider.getInfo();
    console.error(`Connected: ${info.name}`);
    console.error(`Chat/Channel ID: ${config.chatId}`);
  } catch (error) {
    console.error(
      `Failed to connect to ${config.provider}:`,
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }

  // Create MCP server
  const mcpServer = new Server(
    {
      name: 'dm-plz',
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Provider name prefix
  const providerName = config.provider.charAt(0).toUpperCase() + config.provider.slice(1);

  // Handler for tool list requests
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'send_message',
          description: `Send a simple notification message via ${providerName}. Use this when you want to inform the user about something without needing a response (e.g., task completion, status update).`,
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'The message to send. Supports Markdown formatting.',
              },
              parse_mode: {
                type: 'string',
                enum: ['Markdown', 'HTML'],
                description: 'Optional: Message formatting mode (Markdown or HTML)',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'ask_question',
          description: `Send a question via ${providerName} and wait for the user's response. Use this when you need user input to make a decision or proceed with a task. The tool will poll for the user's reply with a 3-hour timeout by default.`,
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question to ask the user. Be clear and specific.',
              },
              parse_mode: {
                type: 'string',
                enum: ['Markdown', 'HTML'],
                description: 'Optional: Message formatting mode (Markdown or HTML)',
              },
            },
            required: ['question'],
          },
        },
        {
          name: 'send_notification',
          description: `Send a notification with a title and detailed message via ${providerName}. Use for important updates or completion reports.`,
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short title for the notification',
              },
              message: {
                type: 'string',
                description: 'Detailed message body',
              },
              parse_mode: {
                type: 'string',
                enum: ['Markdown', 'HTML'],
                description: 'Optional: Message formatting mode (Markdown or HTML)',
              },
            },
            required: ['title', 'message'],
          },
        },
        {
          name: 'request_permission',
          description: `Request user permission via ${providerName}. ${
            config.provider === 'telegram'
              ? 'Sends a message with inline keyboard buttons (Approve/Reject).'
              : 'Sends a message with emoji reactions (✅ for approve, ❌ for reject).'
          } Use this when you need explicit user approval before performing an important action.`,
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'The permission request message. Be clear about what action needs approval.',
              },
              timeout_ms: {
                type: 'number',
                description: 'Optional: Timeout in milliseconds (default: 10800000 = 3 hours)',
              },
            },
            required: ['message'],
          },
        },
        ...(config.mediaEnabled
          ? [
              {
                name: 'send_media',
                description: `Send one local file via ${providerName}. Takes an absolute path and an optional caption; the destination always comes from server configuration. Install the optional airec skill for screen-evidence workflows.`,
                inputSchema: {
                  type: 'object',
                  properties: {
                    file_path: {
                      type: 'string',
                      description: 'Absolute path to the local file.',
                    },
                    caption: {
                      type: 'string',
                      description: 'Optional caption shown with the attachment.',
                    },
                    kind: {
                      type: 'string',
                      enum: ['video', 'animation', 'document', 'photo'],
                      description: 'Optional override for how the file is presented.',
                    },
                  },
                  required: ['file_path'],
                },
              },
            ]
          : []),
      ],
    };
  });

  // Handler for tool execution requests
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;

      if (name === 'send_message') {
        const { message, parse_mode } = args as {
          message: string;
          parse_mode?: 'Markdown' | 'HTML';
        };

        await messagingProvider.sendMessage(message, parse_mode);

        return {
          content: [
            {
              type: 'text',
              text: `Message sent successfully via ${providerName}.`,
            },
          ],
        };
      }

      if (name === 'send_media') {
        const { file_path, caption, kind } = args as {
          file_path: string;
          caption?: string;
          kind?: MediaKind;
        };

        const result: MediaSendResult = config.mediaEnabled
          ? await messagingProvider
              .sendMedia(file_path, { caption, kind, parseMode: 'Markdown' })
              .catch((error) => ({
                error: {
                  code: 'MEDIA_SEND_FAILED',
                  message: error instanceof Error ? error.message : 'Unknown error',
                },
              }))
          : {
              error: {
                code: 'MEDIA_DISABLED',
                message: 'Media sending is disabled.',
              },
            };

        const payload =
          'error' in result
            ? { error: result.error }
            : { sent: true, message_id: result.messageId };

        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          ...('error' in result ? { isError: true } : {}),
        };
      }

      if (name === 'ask_question') {
        const { question, parse_mode } = args as {
          question: string;
          parse_mode?: 'Markdown' | 'HTML';
        };

        // Send question
        await messagingProvider.sendMessage(question, parse_mode);

        console.error('Question sent, waiting for reply...');

        try {
          // Wait for user response
          const reply = await messagingProvider.waitForReply(config.questionTimeoutMs);

          console.error(`Received reply: ${reply}`);

          return {
            content: [
              {
                type: 'text',
                text: `User's response:\n\n${reply}`,
              },
            ],
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Error waiting for reply: ${errorMsg}`);

          return {
            content: [
              {
                type: 'text',
                text: `Failed to get user response: ${errorMsg}`,
              },
            ],
            isError: true,
          };
        }
      }

      if (name === 'send_notification') {
        const { title, message, parse_mode } = args as {
          title: string;
          message: string;
          parse_mode?: 'Markdown' | 'HTML';
        };

        // Format message with title
        const formattedMessage =
          parse_mode === 'HTML'
            ? `<b>${title}</b>\n\n${message}`
            : `**${title}**\n\n${message}`;

        await messagingProvider.sendMessage(formattedMessage, parse_mode || 'Markdown');

        return {
          content: [
            {
              type: 'text',
              text: `Notification sent successfully via ${providerName}.`,
            },
          ],
        };
      }

      if (name === 'request_permission') {
        const { message, timeout_ms } = args as {
          message: string;
          timeout_ms?: number;
        };

        const timeoutMs = timeout_ms || config.questionTimeoutMs;

        console.error('Permission request sent, waiting for response...');

        try {
          // Request user approval
          const approved = await messagingProvider.requestPermission(message, timeoutMs);

          console.error(`Permission ${approved ? 'approved' : 'rejected'}`);

          return {
            content: [
              {
                type: 'text',
                text: approved
                  ? 'User approved the request.'
                  : 'User rejected the request.',
              },
            ],
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Error waiting for permission: ${errorMsg}`);

          return {
            content: [
              {
                type: 'text',
                text: `Failed to get permission response: ${errorMsg}`,
              },
            ],
            isError: true,
          };
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Tool execution error:', errorMessage);

      return {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Start MCP server with stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  const info = await messagingProvider.getInfo();
  console.error('');
  console.error('DM-Plz MCP server ready');
  console.error(`Provider: ${providerName} (${info.identifier})`);
  console.error(`Chat/Channel: ${config.chatId}`);
  console.error(`Question timeout: ${config.questionTimeoutMs}ms`);
  console.error('');

  // Handle graceful shutdown
  const shutdown = () => {
    console.error('\nShutting down...');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Handle top-level exceptions
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
