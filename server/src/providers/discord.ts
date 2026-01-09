/**
 * Discord Provider
 *
 * Implements messaging via Discord Bot API
 */

import type {
  MessagingProvider,
  ServerConfig,
  DiscordMessage,
  DiscordUser,
} from '../types.js';

export class DiscordProvider implements MessagingProvider {
  private baseUrl = 'https://discord.com/api/v10';
  private config: ServerConfig;
  private lastMessageId: string | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  async sendMessage(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void> {
    // Discord uses Markdown by default
    // Convert HTML to text if HTML mode is requested
    let content = text;
    if (parseMode === 'HTML') {
      // Basic HTML to text conversion
      content = text
        .replace(/<b>(.*?)<\/b>/g, '**$1**')
        .replace(/<i>(.*?)<\/i>/g, '*$1*')
        .replace(/<code>(.*?)<\/code>/g, '`$1`')
        .replace(/<a href="(.*?)">(.*?)<\/a>/g, '[$2]($1)')
        .replace(/<[^>]*>/g, ''); // Remove any remaining HTML tags
    }

    const response = await fetch(`${this.baseUrl}/channels/${this.config.chatId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discord API error (${response.status}): ${error}`);
    }

    const message = (await response.json()) as DiscordMessage;
    this.lastMessageId = message.id;
  }

  async waitForReply(timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollInterval = 2000; // Poll every 2 seconds (Discord rate limits)

    // Get the message ID to start polling from
    const afterMessageId = this.lastMessageId;

    while (Date.now() - startTime < timeoutMs) {
      // Wait before polling to respect rate limits
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        const messages = await this.getRecentMessages(afterMessageId);

        if (messages.length > 0) {
          // Return the most recent message content
          return messages[0].content || '(no content)';
        }
      } catch (error) {
        console.error('Error polling for messages:', error);
      }

      // Check if we've timed out
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for user response');
      }
    }

    throw new Error('Timeout waiting for user response');
  }

  async getInfo(): Promise<{ name: string; identifier: string }> {
    const response = await fetch(`${this.baseUrl}/users/@me`, {
      headers: {
        'Authorization': `Bot ${this.config.botToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discord API error (${response.status}): ${error}`);
    }

    const user = (await response.json()) as DiscordUser;
    const username =
      user.discriminator !== '0'
        ? `${user.username}#${user.discriminator}`
        : user.username;

    return {
      name: `Discord (${username})`,
      identifier: username,
    };
  }

  private async getRecentMessages(after?: string | null): Promise<DiscordMessage[]> {
    const params = new URLSearchParams({
      limit: '10',
    });

    if (after) {
      params.set('after', after);
    }

    const response = await fetch(
      `${this.baseUrl}/channels/${this.config.chatId}/messages?${params}`,
      {
        headers: {
          'Authorization': `Bot ${this.config.botToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discord API error (${response.status}): ${error}`);
    }

    const messages = (await response.json()) as DiscordMessage[];

    // Filter out messages from the bot itself
    const botInfo = await this.getBotUserId();
    return messages.filter((m) => m.author.id !== botInfo && !m.author.bot);
  }

  private botUserId: string | null = null;

  private async getBotUserId(): Promise<string> {
    if (this.botUserId) {
      return this.botUserId;
    }

    const response = await fetch(`${this.baseUrl}/users/@me`, {
      headers: {
        'Authorization': `Bot ${this.config.botToken}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to get bot user ID');
    }

    const user = (await response.json()) as DiscordUser;
    this.botUserId = user.id;
    return user.id;
  }
}
