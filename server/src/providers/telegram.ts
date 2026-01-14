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
  PermissionResponse,
} from '../types.js';

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
  async requestPermission(message: string, timeoutMs: number): Promise<PermissionResponse> {
    const startTime = Date.now();
    const pollTimeout = 10; // 10초마다 폴링
    const currentUpdateId = this.lastUpdateId;
    const permissionChatId = this.config.permissionChatId || this.config.chatId;

    // 인라인 키보드로 승인/세션허용/거부 버튼 전송
    const params = {
      chat_id: permissionChatId,
      text: message,
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

          // 로딩 상태 제거를 위해 콜백 쿼리 응답
          await this.answerCallbackQuery(query.id);

          // 콜백 데이터 확인
          if (query.data === 'approve' || query.data === 'approve_session' || query.data === 'reject') {
            return query.data as PermissionResponse;
          }
        }
      }

      // 타임아웃 확인
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for permission response');
      }
    }

    throw new Error('Timeout waiting for permission response');
  }

  /**
   * 콜백 쿼리 응답을 전송합니다.
   */
  private async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
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
