/**
 * Telegram Provider
 *
 * Implements messaging via Telegram Bot API
 */

import type {
  MessagingProvider,
  ServerConfig,
  TelegramResponse,
  TelegramMessage,
  TelegramUpdate,
} from '../types.js';

export class TelegramProvider implements MessagingProvider {
  private baseUrl: string;
  private config: ServerConfig;
  private lastUpdateId: number = 0;
  private botUsername: string = '';

  constructor(config: ServerConfig) {
    this.config = config;
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`;
  }

  async sendMessage(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void> {
    const params: Record<string, string> = {
      chat_id: this.config.chatId,
      text,
    };

    if (parseMode) {
      params.parse_mode = parseMode;
    }

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = (await response.json()) as TelegramResponse<TelegramMessage>;

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
    }
  }

  private isBotMentioned(message: TelegramMessage): boolean {
    // Check if message mentions the bot via @username
    if (message.entities) {
      const hasMention = message.entities.some(
        (entity) => entity.type === 'mention' && message.text?.includes(`@${this.botUsername}`)
      );
      if (hasMention) return true;
    }

    // Check if message is a reply to bot's message
    if (message.reply_to_message?.from?.username === this.botUsername) {
      return true;
    }

    return false;
  }

  async waitForReply(timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollTimeout = 10; // Poll every 10 seconds
    const currentUpdateId = this.lastUpdateId;

    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      // Filter messages from the configured chat that mention the bot
      const messages = updates
        .filter((u) => u.message && u.message.chat.id.toString() === this.config.chatId)
        .map((u) => u.message!)
        .filter((msg) => this.isBotMentioned(msg));

      if (messages.length > 0) {
        // Return the first message text
        const firstMessage = messages[0];
        return firstMessage.text || '(no text)';
      }

      // Check if we've timed out
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for user response');
      }
    }

    throw new Error('Timeout waiting for user response');
  }

  async getInfo(): Promise<{ name: string; identifier: string }> {
    const response = await fetch(`${this.baseUrl}/getMe`);
    const data = (await response.json()) as TelegramResponse<{
      username: string;
      first_name: string;
    }>;

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
    }

    // Store bot username for mention detection
    this.botUsername = data.result.username;

    return {
      name: `Telegram (@${data.result.username})`,
      identifier: `@${data.result.username}`,
    };
  }

  private async getUpdates(offset: number, timeout: number = 30): Promise<TelegramUpdate[]> {
    const params: Record<string, string | number> = {
      offset: offset || this.lastUpdateId + 1,
      timeout,
      allowed_updates: JSON.stringify(['message']),
    };

    const response = await fetch(`${this.baseUrl}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = (await response.json()) as TelegramResponse<TelegramUpdate[]>;

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
    }

    // Update last update ID
    if (data.result.length > 0) {
      const maxId = Math.max(...data.result.map((u) => u.update_id));
      this.lastUpdateId = maxId;
    }

    return data.result;
  }
}
