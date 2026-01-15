/**
 * Telegram 프로바이더
 *
 * Telegram Bot API를 통한 메시징을 구현합니다.
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
   * Telegram 프로바이더를 생성합니다.
   */
  constructor(config: ServerConfig) {
    this.config = config;
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`;
  }

  /**
   * 메시지를 전송합니다.
   */
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

    this.lastSentMessageId = data.result.message_id;
  }

  /**
   * 거부 사유 입력 안내 메시지를 생성합니다.
   */
  private buildRejectReasonPrompt(timeoutMs: number): string {
    const timeoutMinutes = Math.max(Math.ceil(timeoutMs / 60000), 1);

    return [
      '❌ 거부를 선택하셨습니다.',
      '*거부 사유를 입력해주세요 (선택).*',
      '입력한 사유는 Claude에게 "다음 지시"로 전달되어 작업이 다시 진행됩니다.',
      '예: `1.0.5로 해줘`',
      '사유 없이 거부하려면 아래 버튼을 누르세요.',
      `시간 제한: ${timeoutMinutes}분`,
    ].join('\n');
  }

  /**
   * 거부 사유 입력을 받을 채팅 ID를 결정합니다.
   */
  private resolveRejectReasonChatId(permissionChatId: string): string {
    if (permissionChatId !== this.config.chatId) {
      return this.config.chatId;
    }

    return permissionChatId;
  }

  /**
   * 거부 사유 입력 요청 메시지를 전송합니다.
   */
  private async sendRejectReasonPrompt(chatId: string, timeoutMs: number): Promise<number | null> {
    const params = {
      chat_id: chatId,
      text: this.buildRejectReasonPrompt(timeoutMs),
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '사유 없이 거부', callback_data: 'reject_no_reason' }]],
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
   * 만료 안내 메시지를 생성합니다.
   */
  private buildExpiredNotice(requestId?: string): string {
    const suffix = requestId ? ` (request_id: ${requestId})` : '';
    return `이 권한 요청은 이미 만료되었습니다.${suffix}`;
  }

  /**
   * 거부 사유 입력 결과 메시지를 생성합니다.
   */
  private buildRejectReasonResultNotice(result: RejectReasonResult): string {
    if (result.reasonSource === 'user_input') {
      return '거부 사유가 입력되었습니다.';
    }

    if (result.reasonSource === 'timeout') {
      return '거부 사유 입력 시간이 만료되어 사유 없이 거부합니다.';
    }

    return '사유 없이 거부가 확정되었습니다.';
  }

  /**
   * 봇 멘션 여부를 확인합니다.
   */
  private isBotMentioned(message: TelegramMessage): boolean {

    // @username으로 봇을 멘션했는지 확인
    if (message.entities) {
      const hasMention = message.entities.some(
        (entity) => entity.type === 'mention' && message.text?.includes(`@${this.botUsername}`)
      );
      if (hasMention) return true;
    }

    // 봇 메시지에 대한 답글인지 확인
    if (message.reply_to_message?.from?.username === this.botUsername) {
      return true;
    }

    // 최근 보낸 메시지에 대한 답글인지 확인
    if (this.lastSentMessageId && message.reply_to_message?.message_id === this.lastSentMessageId) {
      return true;
    }

    return false;
  }

   /**
    * 대기 중인 업데이트를 소비합니다.
    */
   private async flushPendingUpdates(): Promise<void> {
     await this.getUpdates(this.lastUpdateId + 1, 0);
   }

   /**
    * 사용자 응답을 대기합니다.
    */
   async waitForReply(timeoutMs: number): Promise<string> {
     await this.flushPendingUpdates();
    const startTime = Date.now();
    const pollTimeout = 10; // 10초마다 폴링
    const currentUpdateId = this.lastUpdateId;

    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      // 설정된 채팅에서 봇을 멘션한 메시지만 필터링
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
        // 첫 번째 메시지 텍스트 반환
        const firstMessage = messages[0];
        return firstMessage.text || '(no text)';
      }

      // 타임아웃 확인
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for user response');
      }
    }

    throw new Error('Timeout waiting for user response');
  }

  /**
   * 승인/세션허용/거부 버튼으로 권한을 요청합니다.
   */
  async requestPermission(
    message: string,
    timeoutMs: number,
    context?: PermissionRequestContext
  ): Promise<PermissionResponse> {
    // 이전 업데이트가 남아 있으면 잘못된 버튼 응답을 처리할 수 있으므로 먼저 비웁니다.
    await this.flushPendingUpdates();

    const startTime = Date.now();
    const pollTimeout = 10; // 10초마다 폴링
    const currentUpdateId = this.lastUpdateId;
    const permissionChatId = this.config.permissionChatId || this.config.chatId;
    const reasonChatId = this.resolveRejectReasonChatId(permissionChatId);
    const rejectReasonTimeoutMs = this.config.rejectReasonTimeoutMs;



    // 인라인 키보드로 승인/세션허용/거부 버튼 전송
    const params = {
      chat_id: permissionChatId,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ 승인', callback_data: 'approve' },
            { text: '🔄 세션 허용', callback_data: 'approve_session' },
            { text: '❌ 거부', callback_data: 'reject' },
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

    // 방금 보낸 메시지의 ID 저장 (이 메시지에 대한 응답만 처리하기 위해)
    const sentMessageId = data.result.message_id;
    const originalMessage = message;

    // 콜백 쿼리 응답 대기
    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      // 콜백 쿼리 탐색
      for (const update of updates) {
        if (update.callback_query) {
          const query = update.callback_query;
          const queryChatId = query.message?.chat.id?.toString();
          const queryMessageId = query.message?.message_id;

          // 채팅 ID 확인
          if (queryChatId !== permissionChatId) {
            continue;
          }

          // 방금 보낸 메시지에 대한 응답인지 확인 (이전 메시지 응답 무시)
          if (queryMessageId !== sentMessageId) {
            continue;
          }

          // 승인 처리
          if (query.data === 'approve') {
            await this.answerCallbackQuery(query.id, '✅ 승인되었습니다');
            // 메시지 수정: 승인 상태 표시
            await this.editMessageText(
              permissionChatId,
              sentMessageId,
              `${originalMessage}\n\n✅ *승인됨*`,
              { inline_keyboard: [] }
            );
            return 'approve';
          }

          // 세션 허용 처리
          if (query.data === 'approve_session') {
            await this.answerCallbackQuery(query.id, '🔄 세션 내 허용되었습니다');
            // 메시지 수정: 세션 허용 상태 표시
            await this.editMessageText(
              permissionChatId,
              sentMessageId,
              `${originalMessage}\n\n🔄 *세션 내 허용됨*`,
              { inline_keyboard: [] }
            );
            return 'approve_session';
          }

          // 거부 처리: 이유 입력 요청
          if (query.data === 'reject') {
            const rejectNotice =
              reasonChatId !== permissionChatId
                ? '❌ 거부 사유를 DM으로 입력해주세요'
                : '❌ 거부 사유를 입력해주세요';
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
                `${originalMessage}\n\n❌ *거부됨*\n사유: 이유없음`,
                { inline_keyboard: [] }
              );
              return { type: 'reject', reason: '', reasonSource: 'explicit_skip' };
            }

            const reasonResult = waitTimeoutMs > 0
              ? await this.waitForRejectReason(reasonPromptMessageId, waitTimeoutMs, reasonPromptChatId)
              : ({ reason: '', reasonSource: 'timeout' } as RejectReasonResult);

            const trimmedReason = (reasonResult.reason || '').trim();
            const reasonSummary = `사유: ${trimmedReason.length > 0 ? trimmedReason : '이유없음'}`;

            await this.editMessageText(
              permissionChatId,
              sentMessageId,
              `${originalMessage}\n\n❌ *거부됨*\n${reasonSummary}`,
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

      // 타임아웃 확인
      if (Date.now() - startTime >= timeoutMs) {
        await this.markRequestExpired(permissionChatId, sentMessageId, originalMessage, context?.requestId);
        throw new Error('Timeout waiting for permission response');
      }

    }

    throw new Error('Timeout waiting for permission response');
  }

  /**
   * 콜백 쿼리 응답을 전송합니다.
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
   * 만료 상태로 메시지를 갱신합니다.
   */
  private async markRequestExpired(
    chatId: string,
    messageId: number,
    originalMessage: string,
    requestId?: string
  ): Promise<void> {
    const expiredText = `${originalMessage}\n\n⏱️ *만료됨*\n${this.buildExpiredNotice(requestId)}`;
    await this.editMessageText(chatId, messageId, expiredText, { inline_keyboard: [] });
  }

  /**
   * 메시지를 수정합니다.
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
   * 거부 사유 입력 또는 생략을 대기합니다.
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
            await this.answerCallbackQuery(query.id, '사유 없이 거부 처리되었습니다');
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
   * 봇 정보를 조회합니다.
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

    // 멘션 감지를 위해 봇 사용자명 저장
    this.botUsername = data.result.username;

    return {
      name: `Telegram (@${data.result.username})`,
      identifier: `@${data.result.username}`,
    };
  }

  /**
   * 업데이트를 가져옵니다.
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

    // 마지막 업데이트 ID 갱신
    if (data.result.length > 0) {
      const maxId = Math.max(...data.result.map((u) => u.update_id));
      this.lastUpdateId = maxId;
    }

    return data.result;
  }
}
