#!/usr/bin/env bun
/**
 * Claude Code AskUserQuestion Hook
 *
 * Routes Claude Code AskUserQuestion tool calls to Telegram/Discord.
 * Reads tool input from stdin and outputs the user response as JSON.
 */

import type { ServerConfig, PermissionResponse } from './types.js';

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface AskUserQuestionInput {
  tool_input: {
    questions: Question[];
  };
}

interface HookOutput {
  continue: boolean;
  result?: {
    answers: Record<string, string>;
  };
  reason?: string;
}

/**
 * Loads configuration from environment variables.
 */
function loadConfig(): ServerConfig {
  const provider = (process.env.DMPLZ_PROVIDER || 'telegram') as 'telegram' | 'discord';
  const questionTimeoutMs = parseInt(process.env.DMPLZ_QUESTION_TIMEOUT_MS || '180000', 10);

  if (provider === 'telegram') {
    const botToken = process.env.DMPLZ_TELEGRAM_BOT_TOKEN;
    const chatId = process.env.DMPLZ_TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      throw new Error('Telegram configuration is required: DMPLZ_TELEGRAM_BOT_TOKEN, DMPLZ_TELEGRAM_CHAT_ID');

    }

    return {
      provider,
      botToken,
      chatId,
      questionTimeoutMs,
      permissionChatId: process.env.DMPLZ_PERMISSION_CHAT_ID,
    };
  } else {
    const botToken = process.env.DMPLZ_DISCORD_BOT_TOKEN;
    const chatId = process.env.DMPLZ_DISCORD_CHANNEL_ID;

    if (!botToken || !chatId) {
      throw new Error('Discord configuration is required: DMPLZ_DISCORD_BOT_TOKEN, DMPLZ_DISCORD_CHANNEL_ID');

    }

    return {
      provider,
      botToken,
      chatId,
      questionTimeoutMs,
      permissionChatId: process.env.DMPLZ_PERMISSION_CHAT_ID,
      discordDmUserId: process.env.DMPLZ_DISCORD_DM_USER_ID,
    };
  }
}

/**
 * Reads JSON input from stdin.
 */
async function readStdin(): Promise<string> {
  const chunks: string[] = [];

  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
  }

  return chunks.join('');
}

// ============== Telegram Implementation ==============

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

class TelegramQuestionHandler {
  private baseUrl: string;
  private chatId: string;
  private lastUpdateId: number = 0;

  constructor(botToken: string, chatId: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.chatId = chatId;
  }

  /**
   * Initializes the update ID.
   */
  async initialize(): Promise<void> {
    const updates = await this.getUpdates(0, 0);
    if (updates.length > 0) {
      this.lastUpdateId = Math.max(...updates.map(u => u.update_id));
    }
  }

  /**
   * Sends a question and waits for a response.
   */
  async askQuestion(question: Question, timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollTimeout = 10;

    // Build question message
    let messageText = `❓ *Claude Code Question*\n\n`;

    if (question.header) {
      messageText += `*[${question.header}]*\n`;
    }
    messageText += `${question.question}\n\n`;

    // Add option descriptions
    question.options.forEach((opt, idx) => {
      messageText += `${idx + 1}. *${opt.label}*`;
      if (opt.description) {
        messageText += ` - ${opt.description}`;
      }
      messageText += '\n';
    });

    // Build inline keyboard
    const keyboard: { text: string; callback_data: string }[][] = [];

    // Option buttons (2 per row)
    for (let i = 0; i < question.options.length; i += 2) {
      const row: { text: string; callback_data: string }[] = [];
      row.push({
        text: question.options[i].label,
        callback_data: `opt_${i}`,
      });
      if (i + 1 < question.options.length) {
        row.push({
          text: question.options[i + 1].label,
          callback_data: `opt_${i + 1}`,
        });
      }
      keyboard.push(row);
    }

    // Custom input button
    keyboard.push([{ text: '✏️ Custom input', callback_data: 'custom_input' }]);


    // Send message
    const params = {
      chat_id: this.chatId,
      text: messageText,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard,
      },
    };

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json() as TelegramResponse<TelegramMessage>;
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    const messageId = data.result.message_id;
    const currentUpdateId = this.lastUpdateId;

    // Wait for response
    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      for (const update of updates) {
        // Callback query (button click)
        if (update.callback_query) {
          const query = update.callback_query;
          const queryChatId = query.message?.chat.id?.toString();

          if (queryChatId !== this.chatId) continue;

          await this.answerCallbackQuery(query.id);

          if (query.data === 'custom_input') {
            // Custom input mode
            await this.sendMessage('💬 Please type your answer:');

            const customAnswer = await this.waitForTextMessage(timeoutMs - (Date.now() - startTime));
            await this.editMessageReplyMarkup(messageId); // Remove buttons
            return customAnswer;
          } else if (query.data?.startsWith('opt_')) {
            const optIndex = parseInt(query.data.replace('opt_', ''), 10);
            const selectedOption = question.options[optIndex];
            await this.editMessageReplyMarkup(messageId); // Remove buttons
            return selectedOption.label;
          }
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for answer');
      }
    }

    throw new Error('Timeout waiting for answer');
  }

  /**
   * Waits for a text message.
   */
  private async waitForTextMessage(timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollTimeout = 10;
    const currentUpdateId = this.lastUpdateId;

    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      for (const update of updates) {
        if (update.message?.text && update.message.chat.id.toString() === this.chatId) {
          return update.message.text;
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for text input');
      }
    }

    throw new Error('Timeout waiting for text input');
  }

  /**
   * Sends a message.
   */
  private async sendMessage(text: string): Promise<void> {
    await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
      }),
    });
  }

  /**
   * Removes reply_markup from a message.
   */
  private async editMessageReplyMarkup(messageId: number): Promise<void> {
    await fetch(`${this.baseUrl}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    });
  }

  /**
   * Answers a callback query.
   */
  private async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  }

  /**
   * Fetches updates.
   */
  private async getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    const params = {
      offset: offset || this.lastUpdateId + 1,
      timeout,
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    };

    const response = await fetch(`${this.baseUrl}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json() as TelegramResponse<TelegramUpdate[]>;
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    if (data.result.length > 0) {
      const maxId = Math.max(...data.result.map(u => u.update_id));
      this.lastUpdateId = maxId;
    }

    return data.result;
  }
}

// ============== Discord Implementation ==============

interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; bot?: boolean };
}

interface DiscordUser {
  id: string;
  bot?: boolean;
}

class DiscordQuestionHandler {
  private baseUrl = 'https://discord.com/api/v10';
  private botToken: string;
  private channelId: string;
  private botUserId: string | null = null;

  constructor(botToken: string, channelId: string) {
    this.botToken = botToken;
    this.channelId = channelId;
  }

  /**
   * Fetches the bot user ID.
   */
  async initialize(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/users/@me`, {
      headers: { Authorization: `Bot ${this.botToken}` },
    });
    const user = await response.json() as DiscordUser;
    this.botUserId = user.id;
  }

  /**
   * Sends a question and waits for a response.
   */
  async askQuestion(question: Question, timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollInterval = 2000;

    // Build question message
    let messageText = `❓ **Claude Code Question**\n\n`;

    if (question.header) {
      messageText += `**[${question.header}]**\n`;
    }
    messageText += `${question.question}\n\n`;

    // Add option descriptions
    question.options.forEach((opt, idx) => {
      messageText += `${idx + 1}. **${opt.label}**`;
      if (opt.description) {
        messageText += ` - ${opt.description}`;
      }
      messageText += '\n';
    });

    messageText += `\nReply with a number or type your answer:`;


    // Send message
    const response = await fetch(`${this.baseUrl}/channels/${this.channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: messageText }),
    });

    const sentMessage = await response.json() as DiscordMessage;
    const afterMessageId = sentMessage.id;

    // Wait for response
    while (Date.now() - startTime < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const messages = await this.getMessagesAfter(afterMessageId);

      for (const msg of messages) {
        if (msg.author.id === this.botUserId || msg.author.bot) continue;

        const text = msg.content.trim();

        // Select option by number
        const num = parseInt(text, 10);
        if (!isNaN(num) && num >= 1 && num <= question.options.length) {
          return question.options[num - 1].label;
        }

        // Direct input
        return text;
      }

      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for answer');
      }
    }

    throw new Error('Timeout waiting for answer');
  }

  /**
   * Fetches messages after a specific message.
   */
  private async getMessagesAfter(afterId: string): Promise<DiscordMessage[]> {
    const response = await fetch(
      `${this.baseUrl}/channels/${this.channelId}/messages?after=${afterId}&limit=10`,
      {
        headers: { Authorization: `Bot ${this.botToken}` },
      }
    );

    return await response.json() as DiscordMessage[];
  }
}

/**
 * Outputs the result as JSON.
 */
function outputResult(answers: Record<string, string>): void {
  const output: HookOutput = {
    continue: true,
    result: { answers },
  };
  console.log(JSON.stringify(output));
}

/**
 * Outputs error result as JSON.
 */
function outputError(reason: string): void {
  const output: HookOutput = {
    continue: false,
    reason,
  };
  console.log(JSON.stringify(output));
}

/**
 * Main function
 */
async function main(): Promise<void> {
  try {
    // Read input from stdin
    const inputText = await readStdin();
    const input = JSON.parse(inputText) as AskUserQuestionInput;

    const questions = input.tool_input?.questions;
    if (!questions || questions.length === 0) {
      outputError('No questions provided');

      return;
    }

    // Load configuration
    const config = loadConfig();
    const answers: Record<string, string> = {};

    if (config.provider === 'telegram') {
      const handler = new TelegramQuestionHandler(
        config.botToken,
        config.permissionChatId || config.chatId
      );
      await handler.initialize();

      // Collect responses for each question
      for (let i = 0; i < questions.length; i++) {
        const answer = await handler.askQuestion(questions[i], config.questionTimeoutMs);
        answers[`question-${i}`] = answer;
      }
    } else {
      const handler = new DiscordQuestionHandler(
        config.botToken,
        config.permissionChatId || config.chatId
      );
      await handler.initialize();

      // Collect responses for each question
      for (let i = 0; i < questions.length; i++) {
        const answer = await handler.askQuestion(questions[i], config.questionTimeoutMs);
        answers[`question-${i}`] = answer;
      }
    }

    // Output result
    outputResult(answers);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Question hook error: ${errorMessage}`);
    outputError(`Error while handling question: ${errorMessage}`);

  }
}

main();
