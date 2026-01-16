/**
 * Discord Provider
 *
 * Implements messaging via the Discord Bot API.
 */

import type {
  MessagingProvider,
  ServerConfig,
  DiscordChannel,
  DiscordMessage,
  DiscordUser,
  PermissionRequestContext,
  PermissionResponse,
  RejectReasonSource,
} from '../types.js';

interface RejectReasonResult {
  reason: string;
  reasonSource: RejectReasonSource;
}

export class DiscordProvider implements MessagingProvider {
  private baseUrl = 'https://discord.com/api/v10';
  private config: ServerConfig;
  private lastMessageId: string | null = null;
  private permissionChannelId: string | null = null;
  private dmChannelIds: Map<string, string> = new Map();

  /**
   * Creates a Discord provider instance.
   */
  constructor(config: ServerConfig) {
    this.config = config;
  }

  /**
   * Sends a message.
   */
  async sendMessage(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void> {
    // Discord uses Markdown by default.
    // If HTML mode is requested, convert to text.
    let content = text;
    if (parseMode === 'HTML') {
      // Basic HTML → text conversion
      content = text
        .replace(/<b>(.*?)<\/b>/g, '**$1**')
        .replace(/<i>(.*?)<\/i>/g, '*$1*')
        .replace(/<code>(.*?)<\/code>/g, '`$1`')
        .replace(/<a href="(.*?)">(.*?)<\/a>/g, '[$2]($1)')
        .replace(/<[^>]*>/g, ''); // Remove remaining HTML tags
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

  /**
   * Sends a message with quick reply options.
   * Discord doesn't have reply keyboard, so options are shown as text hints.
   */
  async sendMessageWithKeyboard(
    text: string,
    buttonTexts: string[],
    parseMode?: 'Markdown' | 'HTML'
  ): Promise<void> {
    // Append quick reply options as text
    const quickReplies = buttonTexts.map((t) => `\`${t}\``).join(' | ');
    const contentWithOptions = `${text}\n\n**Quick replies:** ${quickReplies}`;

    await this.sendMessage(contentWithOptions, parseMode);
  }

  /**
   * Builds the rejection reason prompt message.
   */
  private buildRejectReasonPrompt(timeoutMs: number, noReasonKeyword: string): string {
    const timeoutMinutes = Math.max(Math.ceil(timeoutMs / 60000), 1);

    return [
      '❌ You selected Reject.',
      '**Please enter a rejection reason (optional).**',
      'Your reason will be sent to Claude as the "next instruction" so the work can continue.',
      'Example: `Use 1.0.5`',
      `To reject without a reason, type \`${noReasonKeyword}\`.`,
      `Time limit: ${timeoutMinutes} min`,
    ].join('\n');
  }

  /**
   * Builds the expiration notice message.
   */
  private buildExpiredNotice(requestId?: string): string {
    const suffix = requestId ? ` (request_id: ${requestId})` : '';
    return `This permission request has already expired.${suffix}`;
  }

  /**
   * Builds the rejection reason result notice message.
   */
  private buildRejectReasonResultNotice(result: RejectReasonResult): string {
    if (result.reasonSource === 'user_input') {
      return 'Rejection reason recorded.';
    }

    if (result.reasonSource === 'timeout') {
      return 'Timed out waiting for a reason. Rejecting without a reason.';
    }

    return 'Rejected without a reason.';
  }

  /**
   * Normalizes a no-reason keyword.
   */
  private normalizeKeyword(value: string): string {
    return value.trim().toLowerCase();
  }

  /**
   * Waits for a user response.
   */
  async waitForReply(timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollInterval = 2000; // Poll every 2 seconds (Discord rate limit)

    // Message ID to start polling from
    const afterMessageId = this.lastMessageId;

    while (Date.now() - startTime < timeoutMs) {
      // Wait to respect rate limits
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

      // Check for timeout
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for user response');
      }
    }

    throw new Error('Timeout waiting for user response');
  }

  /**
   * Requests permission using approve/session allow/reject reactions.
   */
  async requestPermission(
    message: string,
    timeoutMs: number,
    context?: PermissionRequestContext
  ): Promise<PermissionResponse> {
    const startTime = Date.now();
    const pollInterval = 2000; // Poll every 2 seconds (Discord rate limit)
    const permissionChannelId = await this.resolvePermissionChannelId();
    const rejectReasonTimeoutMs = this.config.rejectReasonTimeoutMs;

    // Manage the permission request message body and prompt separately.
    // (After a decision, the message is edited to remove/disable the prompt.)
    const baseMessage = message;
    const promptSuffix = '\n\n✅ Approve | 🔄 Approve for session | ❌ Reject';

    // Send permission request message
    const response = await fetch(`${this.baseUrl}/channels/${permissionChannelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: `${baseMessage}${promptSuffix}` }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discord API error (${response.status}): ${error}`);
    }

    const sentMessage = (await response.json()) as DiscordMessage;
    const messageId = sentMessage.id;
    const originalMessage = sentMessage.content || `${baseMessage}${promptSuffix}`;

    // Add reactions to the message
    await this.addReaction(messageId, '✅');
    await new Promise((resolve) => setTimeout(resolve, 500)); // Short delay between reactions
    await this.addReaction(messageId, '🔄');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.addReaction(messageId, '❌');

    // Poll for user reactions
    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        const botId = await this.getBotUserId();

        // Check for approve reaction (✅)
        const approveUsers = await this.getReactionUsers(messageId, '✅');
        const userApproved = approveUsers.some((user) => user.id !== botId && !user.bot);
        if (userApproved) {
          await this.editMessage(permissionChannelId, messageId, `${baseMessage}\n\n✅ Approved`);
          await this.clearReactionsBestEffort(permissionChannelId, messageId);
          return 'approve';
        }

        // Check for session allow reaction (🔄)
        const sessionUsers = await this.getReactionUsers(messageId, '🔄');
        const userSessionApproved = sessionUsers.some((user) => user.id !== botId && !user.bot);
        if (userSessionApproved) {
          await this.editMessage(permissionChannelId, messageId, `${baseMessage}\n\n🔄 Approved for session`);
          await this.clearReactionsBestEffort(permissionChannelId, messageId);
          return 'approve_session';
        }

        // Check for reject reaction (❌)
        const rejectUsers = await this.getReactionUsers(messageId, '❌');
        const rejectUser = rejectUsers.find((user) => user.id !== botId && !user.bot);
        if (rejectUser) {
          const noReasonKeyword = this.config.rejectReasonNoReasonKeywords[0] || 'no_reason';
          const remainingMs = Math.max(timeoutMs - (Date.now() - startTime), 0);
          const waitTimeoutMs = Math.min(rejectReasonTimeoutMs, remainingMs);
          let reasonChannelId = permissionChannelId;

          try {
            reasonChannelId = await this.getOrCreateDmChannelId(rejectUser.id);
          } catch (error) {
            console.error('Failed to open DM channel for reject reason:', error);
          }

          // Send rejection reason request message
          const reasonPromptResponse = await fetch(`${this.baseUrl}/channels/${reasonChannelId}/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bot ${this.config.botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              content: this.buildRejectReasonPrompt(waitTimeoutMs, noReasonKeyword),
            }),
          });

          if (!reasonPromptResponse.ok) {
            await this.editMessage(permissionChannelId, messageId, `${baseMessage}\n\n❌ Rejected\nReason: none`);
            await this.clearReactionsBestEffort(permissionChannelId, messageId);
            return { type: 'reject', reason: '', reasonSource: 'explicit_skip' };
          }

          const reasonPromptMessage = (await reasonPromptResponse.json()) as DiscordMessage;

          const reasonResult =
            waitTimeoutMs > 0
              ? await this.waitForRejectReason(
                  reasonPromptMessage.id,
                  waitTimeoutMs,
                  reasonChannelId,
                  rejectUser.id,
                  this.config.rejectReasonNoReasonKeywords
                )
              : ({ reason: '', reasonSource: 'timeout' } as RejectReasonResult);

          await this.editMessage(
            reasonChannelId,
            reasonPromptMessage.id,
            this.buildRejectReasonResultNotice(reasonResult)
          );

          const trimmedReason = (reasonResult.reason || '').trim();
          const reasonSummary = `Reason: ${trimmedReason.length > 0 ? trimmedReason : 'none'}`;

          await this.editMessage(permissionChannelId, messageId, `${baseMessage}\n\n❌ Rejected\n${reasonSummary}`);
          await this.clearReactionsBestEffort(permissionChannelId, messageId);

          return {
            type: 'reject',
            reason: reasonResult.reason,
            reasonSource: reasonResult.reasonSource,
          };
        }
      } catch (error) {
        console.error('Error checking reactions:', error);
      }

      // Check for timeout
      if (Date.now() - startTime >= timeoutMs) {
        await this.markRequestExpired(permissionChannelId, messageId, originalMessage, context?.requestId);
        throw new Error('Timeout waiting for permission response');
      }
    }

    throw new Error('Timeout waiting for permission response');
  }

  /**
   * Waits for rejection reason input or skip.
   */
  private async waitForRejectReason(
    afterMessageId: string,
    timeoutMs: number,
    channelId: string,
    expectedUserId: string,
    noReasonKeywords: string[]
  ): Promise<RejectReasonResult> {
    const startTime = Date.now();
    const pollInterval = 2000;
    const normalizedKeywords = noReasonKeywords.map((keyword) => this.normalizeKeyword(keyword));

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        const messages = await this.getMessagesAfter(afterMessageId, channelId);

        for (const message of messages) {
          if (message.author.id !== expectedUserId) {
            continue;
          }

          const content = message.content.trim();
          const normalized = this.normalizeKeyword(content);

          if (normalizedKeywords.includes(normalized)) {
            return { reason: '', reasonSource: 'explicit_skip' };
          }

          return { reason: content, reasonSource: 'user_input' };
        }
      } catch (error) {
        console.error('Error polling for reason message:', error);
      }

      if (Date.now() - startTime >= timeoutMs) {
        return { reason: '', reasonSource: 'timeout' };
      }
    }

    return { reason: '', reasonSource: 'timeout' };
  }

  /**
   * Updates the message to expired state.
   */
  private async markRequestExpired(
    channelId: string,
    messageId: string,
    originalMessage: string,
    requestId?: string
  ): Promise<void> {
    const expiredContent = `${originalMessage}\n\n⏱️ Expired\n${this.buildExpiredNotice(requestId)}`;
    await this.editMessage(channelId, messageId, expiredContent);
  }

  /**
   * Edits a message.
   */
  private async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to edit message: ${error}`);
    }
  }

  /**
   * Clears reactions from the permission request message.
   *
   * May fail without Discord permission (Manage Messages), so handled as best-effort.
   */
  private async clearReactionsBestEffort(channelId: string, messageId: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/channels/${channelId}/messages/${messageId}/reactions`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bot ${this.config.botToken}`,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to clear reactions (ignored): ${error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to clear reactions (ignored): ${errorMessage}`);
    }
  }

  /**
   * Fetches messages after a specific message.
   */
  private async getMessagesAfter(afterMessageId: string, channelId: string): Promise<DiscordMessage[]> {
    const params = new URLSearchParams({
      after: afterMessageId,
      limit: '10',
    });

    const response = await fetch(`${this.baseUrl}/channels/${channelId}/messages?${params}`, {
      headers: {
        'Authorization': `Bot ${this.config.botToken}`,
      },
    });

    if (!response.ok) {
      return [];
    }

    const messages = (await response.json()) as DiscordMessage[];

    // Exclude bot messages
    const botId = await this.getBotUserId();
    return messages.filter((m) => m.author.id !== botId && !m.author.bot);
  }

  /**
   * Determines the channel ID to use for permission requests.
   */
  private async resolvePermissionChannelId(): Promise<string> {
    if (this.permissionChannelId) {
      return this.permissionChannelId;
    }

    if (this.config.permissionChatId) {
      this.permissionChannelId = this.config.permissionChatId;
      return this.permissionChannelId;
    }

    if (this.config.discordDmUserId) {
      this.permissionChannelId = await this.getOrCreateDmChannelId(this.config.discordDmUserId);
      return this.permissionChannelId;
    }

    this.permissionChannelId = this.config.chatId;
    return this.permissionChannelId;
  }

  /**
   * Creates or retrieves a user DM channel.
   */
  private async getOrCreateDmChannelId(recipientId: string): Promise<string> {
    const cachedChannelId = this.dmChannelIds.get(recipientId);
    if (cachedChannelId) {
      return cachedChannelId;
    }

    const response = await fetch(`${this.baseUrl}/users/@me/channels`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: recipientId }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create DM channel: ${error}`);
    }

    const channel = (await response.json()) as DiscordChannel;
    this.dmChannelIds.set(recipientId, channel.id);
    return channel.id;
  }

  /**
   * Adds a reaction to a message.
   */
  private async addReaction(messageId: string, emoji: string): Promise<void> {
    const targetChannelId = this.permissionChannelId || this.config.chatId;
    const encodedEmoji = encodeURIComponent(emoji);
    const response = await fetch(
      `${this.baseUrl}/channels/${targetChannelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${this.config.botToken}`,
          'Content-Length': '0',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to add reaction: ${error}`);
    }
  }

  /**
   * Fetches the list of users who reacted with a specific emoji.
   */
  private async getReactionUsers(messageId: string, emoji: string): Promise<DiscordUser[]> {
    const targetChannelId = this.permissionChannelId || this.config.chatId;
    const encodedEmoji = encodeURIComponent(emoji);
    const response = await fetch(
      `${this.baseUrl}/channels/${targetChannelId}/messages/${messageId}/reactions/${encodedEmoji}`,
      {
        headers: {
          'Authorization': `Bot ${this.config.botToken}`,
        },
      }
    );

    if (!response.ok) {
      // Return empty array if no reactions yet
      if (response.status === 404) {
        return [];
      }
      const error = await response.text();
      throw new Error(`Failed to get reactions: ${error}`);
    }

    return (await response.json()) as DiscordUser[];
  }

  /**
   * Retrieves bot information.
   */
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
      user.discriminator !== '0' ? `${user.username}#${user.discriminator}` : user.username;

    return {
      name: `Discord (${username})`,
      identifier: username,
    };
  }

  /**
   * Fetches recent messages.
   */
  private async getRecentMessages(after?: string | null): Promise<DiscordMessage[]> {
    const params = new URLSearchParams({
      limit: '10',
    });

    if (after) {
      params.set('after', after);
    }

    const response = await fetch(`${this.baseUrl}/channels/${this.config.chatId}/messages?${params}`, {
      headers: {
        'Authorization': `Bot ${this.config.botToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discord API error (${response.status}): ${error}`);
    }

    const messages = (await response.json()) as DiscordMessage[];

    // Exclude the bot's own messages
    const botInfo = await this.getBotUserId();
    return messages.filter((m) => m.author.id !== botInfo && !m.author.bot);
  }

  private botUserId: string | null = null;

  /**
   * Retrieves the bot user ID.
   */
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
