/**
 * Telegram Provider
 *
 * Implements messaging through the Telegram Bot API.
 */

import type {
  MessagingProvider,
  ServerConfig,
  TelegramResponse,
  TelegramMessage,
  TelegramUpdate,
  TelegramCallbackQuery,
  PermissionRequestContext,
  PermissionResponse,
  RejectReasonSource,
} from '../types.js';

interface RejectReasonResult {
  reason: string;
  reasonSource: RejectReasonSource;
}

export class TelegramProvider implements MessagingProvider {
  private baseUrl: string;
  private config: ServerConfig;
  private lastUpdateId: number = 0;
  private botUsername: string = '';
  private lastSentMessageId?: number;

  /**
   * Creates a Telegram provider instance.
   */
  constructor(config: ServerConfig) {
    this.config = config;
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`;
  }

  /**
   * Escapes special characters for Telegram Markdown V1.
   * Characters: _ * ` [
   */
  private escapeTelegramMarkdown(text: string): string {
    return text.replace(/([_*`\[])/g, '\\$1');
  }

  /**
   * Sends a message.
   */
  async sendMessage(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void> {
    // Escape special characters when using Markdown mode to prevent parsing issues
    const processedText = parseMode === 'Markdown' ? this.escapeTelegramMarkdown(text) : text;

    const params: Record<string, string> = {
      chat_id: this.config.chatId,
      text: processedText,
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

    this.lastSentMessageId = data.result.message_id;
  }

  /**
   * Sends a message with reply keyboard buttons.
   * When user taps a button, the button text is sent as a message.
   */
  async sendMessageWithKeyboard(
    text: string,
    buttonTexts: string[],
    parseMode?: 'Markdown' | 'HTML'
  ): Promise<void> {
    const processedText = parseMode === 'Markdown' ? this.escapeTelegramMarkdown(text) : text;

    // Create keyboard buttons (one button per row for better visibility)
    const keyboard = buttonTexts.map((buttonText) => [{ text: buttonText }]);

    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text: processedText,
      reply_markup: {
        keyboard,
        one_time_keyboard: true, // Hide keyboard after button press
        resize_keyboard: true, // Fit buttons to their text
        input_field_placeholder: 'Tap a button or type your message...',
      },
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

    this.lastSentMessageId = data.result.message_id;
  }

  /**
   * Builds the rejection reason prompt message.
   */
  private buildRejectReasonPrompt(timeoutMs: number): string {
    const timeoutMinutes = Math.max(Math.ceil(timeoutMs / 60000), 1);

    return [
      '❌ You selected Reject.',
      '*Please enter a rejection reason (optional).*',
      'Your reason will be sent to Claude as the "next instruction" so the work can continue.',
      'Example: `Use 1.0.5`',
      'To reject without a reason, tap the button below.',
      `Time limit: ${timeoutMinutes} min`,
    ].join('\n');
  }

  /**
   * Determines the chat ID for receiving rejection reason input.
   */
  private resolveRejectReasonChatId(permissionChatId: string): string {
    if (permissionChatId !== this.config.chatId) {
      return this.config.chatId;
    }

    return permissionChatId;
  }

  /**
   * Sends the rejection reason prompt message.
   */
  private async sendRejectReasonPrompt(chatId: string, timeoutMs: number): Promise<number | null> {
    const params = {
      chat_id: chatId,
      text: this.buildRejectReasonPrompt(timeoutMs),
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: 'Reject without reason', callback_data: 'reject_no_reason' }]],
      },
    };

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as TelegramResponse<TelegramMessage>;
    if (!data.ok) {
      return null;
    }

    return data.result?.message_id ?? null;
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
   * Checks if the bot is mentioned.
   */
  private isBotMentioned(message: TelegramMessage): boolean {
    // Check if bot is mentioned via @username
    if (message.entities) {
      const hasMention = message.entities.some(
        (entity) => entity.type === 'mention' && message.text?.includes(`@${this.botUsername}`)
      );
      if (hasMention) return true;
    }

    // Check if this is a reply to a bot message
    if (message.reply_to_message?.from?.username === this.botUsername) {
      return true;
    }

    // Check if this is a reply to the most recently sent message
    if (this.lastSentMessageId && message.reply_to_message?.message_id === this.lastSentMessageId) {
      return true;
    }

    return false;
  }

  /**
   * Consumes pending updates.
   */
  private async flushPendingUpdates(): Promise<void> {
    await this.getUpdates(this.lastUpdateId + 1, 0);
  }

  /**
   * Waits for user response.
   */
  async waitForReply(timeoutMs: number): Promise<string> {
    await this.flushPendingUpdates();
    const startTime = Date.now();
    const pollTimeout = 10; // Poll every 10 seconds
    const currentUpdateId = this.lastUpdateId;

    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      // Filter only messages that mention the bot from the configured chat
      const messages = updates
        .filter((u) => u.message && u.message.chat.id.toString() === this.config.chatId)
        .map((u) => u.message!)
        .filter((msg) => {
          if (msg.chat.type === 'private') {
            return true;
          }
          return this.isBotMentioned(msg);
        });

      if (messages.length > 0) {
        // Return the first message text
        const firstMessage = messages[0];
        return firstMessage.text || '(no text)';
      }

      // Check for timeout
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for user response');
      }
    }

    throw new Error('Timeout waiting for user response');
  }

  /**
   * Requests permission using approve/session allow/reject buttons.
   */
  async requestPermission(
    message: string,
    timeoutMs: number,
    context?: PermissionRequestContext
  ): Promise<PermissionResponse> {
    // Flush pending updates first to avoid processing stale button responses.
    await this.flushPendingUpdates();

    const startTime = Date.now();
    const pollTimeout = 10; // Poll every 10 seconds
    const currentUpdateId = this.lastUpdateId;
    const permissionChatId = this.config.permissionChatId || this.config.chatId;
    const reasonChatId = this.resolveRejectReasonChatId(permissionChatId);
    const rejectReasonTimeoutMs = this.config.rejectReasonTimeoutMs;

    // Send approve/session allow/reject buttons via inline keyboard
    const params = {
      chat_id: permissionChatId,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: 'approve' },
            { text: '🔄 Approve for session', callback_data: 'approve_session' },
            { text: '❌ Reject', callback_data: 'reject' },
          ],
        ],
      },
    };

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = (await response.json()) as TelegramResponse<TelegramMessage>;

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
    }

    // Save the ID of the message just sent (to process only responses to this message)
    const sentMessageId = data.result.message_id;
    const originalMessage = message;

    // Wait for callback query response
    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      // Search for callback queries
      for (const update of updates) {
        if (update.callback_query) {
          const query = update.callback_query;
          const queryChatId = query.message?.chat.id?.toString();
          const queryMessageId = query.message?.message_id;

          // Verify chat ID
          if (queryChatId !== permissionChatId) {
            continue;
          }

          // Check if this is a response to the message just sent (ignore responses to previous messages)
          if (queryMessageId !== sentMessageId) {
            continue;
          }

          // Handle approval
          if (query.data === 'approve') {
            await this.answerCallbackQuery(query.id, 'Approved');
            // Edit message: show approved status
            await this.editMessageText(
              permissionChatId,
              sentMessageId,
              `${originalMessage}\n\n✅ *Approved*`,
              { inline_keyboard: [] }
            );
            return 'approve';
          }

          // Handle session approval
          if (query.data === 'approve_session') {
            await this.answerCallbackQuery(query.id, 'Approved for this session');
            // Edit message: show session approval status
            await this.editMessageText(
              permissionChatId,
              sentMessageId,
              `${originalMessage}\n\n🔄 *Approved for session*`,
              { inline_keyboard: [] }
            );
            return 'approve_session';
          }

          // Handle rejection: request reason input
          if (query.data === 'reject') {
            const rejectNotice =
              reasonChatId !== permissionChatId
                ? '❌ Please send the rejection reason via DM'
                : '❌ Please enter the rejection reason';
            await this.answerCallbackQuery(query.id, rejectNotice);

            const remainingMs = Math.max(timeoutMs - (Date.now() - startTime), 0);
            const waitTimeoutMs = Math.min(rejectReasonTimeoutMs, remainingMs);
            let reasonPromptChatId = reasonChatId;
            let reasonPromptMessageId = await this.sendRejectReasonPrompt(reasonPromptChatId, waitTimeoutMs);

            if (reasonPromptMessageId === null && reasonChatId !== permissionChatId) {
              reasonPromptChatId = permissionChatId;
              reasonPromptMessageId = await this.sendRejectReasonPrompt(reasonPromptChatId, waitTimeoutMs);
            }

            if (reasonPromptMessageId === null) {
              await this.editMessageText(
                permissionChatId,
                sentMessageId,
                `${originalMessage}\n\n❌ *Rejected*\nReason: none`,
                { inline_keyboard: [] }
              );
              return { type: 'reject', reason: '', reasonSource: 'explicit_skip' };
            }

            const reasonResult =
              waitTimeoutMs > 0
                ? await this.waitForRejectReason(reasonPromptMessageId, waitTimeoutMs, reasonPromptChatId)
                : ({ reason: '', reasonSource: 'timeout' } as RejectReasonResult);

            const trimmedReason = (reasonResult.reason || '').trim();
            const reasonSummary = `Reason: ${trimmedReason.length > 0 ? trimmedReason : 'none'}`;

            await this.editMessageText(
              permissionChatId,
              sentMessageId,
              `${originalMessage}\n\n❌ *Rejected*\n${reasonSummary}`,
              { inline_keyboard: [] }
            );

            await this.editMessageText(
              reasonPromptChatId,
              reasonPromptMessageId,
              this.buildRejectReasonResultNotice(reasonResult),
              { inline_keyboard: [] }
            );

            return {
              type: 'reject',
              reason: reasonResult.reason,
              reasonSource: reasonResult.reasonSource,
            };
          }
        }
      }

      // Check for timeout
      if (Date.now() - startTime >= timeoutMs) {
        await this.markRequestExpired(permissionChatId, sentMessageId, originalMessage, context?.requestId);
        throw new Error('Timeout waiting for permission response');
      }
    }

    throw new Error('Timeout waiting for permission response');
  }

  /**
   * Sends a callback query response.
   */
  private async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text,
      }),
    });
  }

  /**
   * Updates the message to expired state.
   */
  private async markRequestExpired(
    chatId: string,
    messageId: number,
    originalMessage: string,
    requestId?: string
  ): Promise<void> {
    const expiredText = `${originalMessage}\n\n⏱️ *Expired*\n${this.buildExpiredNotice(requestId)}`;
    await this.editMessageText(chatId, messageId, expiredText, { inline_keyboard: [] });
  }

  /**
   * Edits a message.
   */
  private async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: Record<string, unknown>
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to edit message: ${error}`);
    }
  }

  /**
   * Waits for rejection reason input or skip.
   */
  private async waitForRejectReason(
    afterMessageId: number,
    timeoutMs: number,
    chatId: string
  ): Promise<RejectReasonResult> {
    const startTime = Date.now();
    const pollTimeout = 10;
    const currentUpdateId = this.lastUpdateId;

    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      for (const update of updates) {
        if (update.callback_query) {
          const query = update.callback_query;
          const queryChatId = query.message?.chat.id?.toString();
          const queryMessageId = query.message?.message_id;

          if (queryChatId !== chatId) {
            continue;
          }

          if (queryMessageId !== afterMessageId) {
            continue;
          }

          if (query.data === 'reject_no_reason') {
            await this.answerCallbackQuery(query.id, 'Rejected without a reason');
            return { reason: '', reasonSource: 'explicit_skip' };
          }
        }

        if (update.message && update.message.chat.id.toString() === chatId) {
          const message = update.message;

          if (message.message_id <= afterMessageId) {
            continue;
          }

          if (message.chat.type !== 'private' && !this.isBotMentioned(message)) {
            continue;
          }

          return { reason: message.text || '', reasonSource: 'user_input' };
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        return { reason: '', reasonSource: 'timeout' };
      }
    }

    return { reason: '', reasonSource: 'timeout' };
  }

  /**
   * Retrieves bot information.
   */
  async getInfo(): Promise<{ name: string; identifier: string }> {
    const response = await fetch(`${this.baseUrl}/getMe`);
    const data = (await response.json()) as TelegramResponse<{
      username: string;
      first_name: string;
    }>;

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
    }

    // Save bot username for mention detection
    this.botUsername = data.result.username;

    return {
      name: `Telegram (@${data.result.username})`,
      identifier: `@${data.result.username}`,
    };
  }

  /**
   * Fetches updates.
   */
  private async getUpdates(offset: number, timeout: number = 30): Promise<TelegramUpdate[]> {
    const params: Record<string, string | number> = {
      offset: offset || this.lastUpdateId + 1,
      timeout,
      allowed_updates: JSON.stringify(['message', 'callback_query']),
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

    // Update the last update ID
    if (data.result.length > 0) {
      const maxId = Math.max(...data.result.map((u) => u.update_id));
      this.lastUpdateId = maxId;
    }

    return data.result;
  }
}
