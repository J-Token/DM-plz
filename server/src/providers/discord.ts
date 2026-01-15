/**
 * Discord 프로바이더
 *
 * Discord Bot API를 통한 메시징을 구현합니다.
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
   * Discord 프로바이더를 생성합니다.
   */
  constructor(config: ServerConfig) {
    this.config = config;
  }

  /**
   * 메시지를 전송합니다.
   */
  async sendMessage(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void> {
    // Discord는 기본적으로 Markdown을 사용합니다.
    // HTML 모드가 요청되면 텍스트로 변환합니다.
    let content = text;
    if (parseMode === 'HTML') {
      // 기본 HTML → 텍스트 변환
      content = text
        .replace(/<b>(.*?)<\/b>/g, '**$1**')
        .replace(/<i>(.*?)<\/i>/g, '*$1*')
        .replace(/<code>(.*?)<\/code>/g, '`$1`')
        .replace(/<a href="(.*?)">(.*?)<\/a>/g, '[$2]($1)')
        .replace(/<[^>]*>/g, ''); // 남은 HTML 태그 제거
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
   * 거부 사유 입력 안내 메시지를 생성합니다.
   */
  private buildRejectReasonPrompt(timeoutMs: number, noReasonKeyword: string): string {
    const timeoutMinutes = Math.max(Math.ceil(timeoutMs / 60000), 1);

    return [
      '❌ 거부를 선택하셨습니다.',
      '**거부 사유를 입력해주세요 (선택).**',
      '입력한 사유는 Claude에게 "다음 지시"로 전달되어 작업이 다시 진행됩니다.',
      '예: `1.0.5로 해줘`',
      `사유 없이 거부하려면 \`${noReasonKeyword}\` 를 입력하세요.`,
      `시간 제한: ${timeoutMinutes}분`,
    ].join('\n');
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
   * 사유 없음 키워드를 정규화합니다.
   */
  private normalizeKeyword(value: string): string {
    return value.trim().toLowerCase();
  }

  /**
   * 사용자 응답을 대기합니다.
   */
  async waitForReply(timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2초마다 폴링 (Discord 레이트 리밋)

    // 폴링 시작 기준 메시지 ID
    const afterMessageId = this.lastMessageId;

    while (Date.now() - startTime < timeoutMs) {
      // 레이트 리밋을 지키기 위해 대기
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        const messages = await this.getRecentMessages(afterMessageId);

        if (messages.length > 0) {
          // 가장 최근 메시지 내용 반환
          return messages[0].content || '(no content)';
        }
      } catch (error) {
        console.error('Error polling for messages:', error);
      }

      // 타임아웃 확인
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for user response');
      }
    }

    throw new Error('Timeout waiting for user response');
  }

  /**
   * 승인/세션허용/거부 반응으로 권한을 요청합니다.
   */
  async requestPermission(
    message: string,
    timeoutMs: number,
    context?: PermissionRequestContext
  ): Promise<PermissionResponse> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2초마다 폴링 (Discord 레이트 리밋)
    const permissionChannelId = await this.resolvePermissionChannelId();
    const rejectReasonTimeoutMs = this.config.rejectReasonTimeoutMs;

    // 권한 요청 메시지 본문과 안내 문구를 분리해서 관리합니다.
    // (결정 후에는 안내 문구를 제거/무력화하기 위해 메시지를 수정합니다.)
    const baseMessage = message;
    const promptSuffix = '\n\n✅ 승인 | 🔄 세션 허용 | ❌ 거부';

    // 권한 요청 메시지 전송
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

    // 메시지에 반응 추가
    await this.addReaction(messageId, '✅');
    await new Promise((resolve) => setTimeout(resolve, 500)); // 반응 간 짧은 지연
    await this.addReaction(messageId, '🔄');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.addReaction(messageId, '❌');

    // 사용자 반응 폴링
    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        const botId = await this.getBotUserId();

        // 승인 반응 확인 (✅)
        const approveUsers = await this.getReactionUsers(messageId, '✅');
        const userApproved = approveUsers.some((user) => user.id !== botId && !user.bot);
        if (userApproved) {
          await this.editMessage(permissionChannelId, messageId, `${baseMessage}\n\n✅ 승인됨`);
          await this.clearReactionsBestEffort(permissionChannelId, messageId);
          return 'approve';
        }

        // 세션 허용 반응 확인 (🔄)
        const sessionUsers = await this.getReactionUsers(messageId, '🔄');
        const userSessionApproved = sessionUsers.some((user) => user.id !== botId && !user.bot);
        if (userSessionApproved) {
          await this.editMessage(permissionChannelId, messageId, `${baseMessage}\n\n🔄 세션 내 허용됨`);
          await this.clearReactionsBestEffort(permissionChannelId, messageId);
          return 'approve_session';
        }

        // 거부 반응 확인 (❌)
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

          // 거부 이유 입력 요청 메시지 전송
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
            await this.editMessage(permissionChannelId, messageId, `${baseMessage}\n\n❌ 거부됨\n사유: 이유없음`);
            await this.clearReactionsBestEffort(permissionChannelId, messageId);
            return { type: 'reject', reason: '', reasonSource: 'explicit_skip' };
          }

          const reasonPromptMessage = (await reasonPromptResponse.json()) as DiscordMessage;

          const reasonResult = waitTimeoutMs > 0
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
          const reasonSummary = `사유: ${trimmedReason.length > 0 ? trimmedReason : '이유없음'}`;

          await this.editMessage(permissionChannelId, messageId, `${baseMessage}\n\n❌ 거부됨\n${reasonSummary}`);
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

      // 타임아웃 확인
      if (Date.now() - startTime >= timeoutMs) {
        await this.markRequestExpired(permissionChannelId, messageId, originalMessage, context?.requestId);
        throw new Error('Timeout waiting for permission response');
      }
    }

    throw new Error('Timeout waiting for permission response');
  }

  /**
   * 거부 사유 입력 또는 생략을 대기합니다.
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
   * 만료 상태로 메시지를 갱신합니다.
   */
  private async markRequestExpired(
    channelId: string,
    messageId: string,
    originalMessage: string,
    requestId?: string
  ): Promise<void> {
    const expiredContent = `${originalMessage}\n\n⏱️ 만료됨\n${this.buildExpiredNotice(requestId)}`;
    await this.editMessage(channelId, messageId, expiredContent);
  }

  /**
   * 메시지를 수정합니다.
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
   * 권한 요청 메시지의 리액션을 제거합니다.
   *
   * Discord 권한(Manage Messages)이 없으면 실패할 수 있으므로 best-effort로 처리합니다.
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
   * 특정 메시지 이후의 메시지들을 가져옵니다.
   */
  private async getMessagesAfter(afterMessageId: string, channelId: string): Promise<DiscordMessage[]> {
    const params = new URLSearchParams({
      after: afterMessageId,
      limit: '10',
    });

    const response = await fetch(
      `${this.baseUrl}/channels/${channelId}/messages?${params}`,
      {
        headers: {
          'Authorization': `Bot ${this.config.botToken}`,
        },
      }
    );

    if (!response.ok) {
      return [];
    }

    const messages = (await response.json()) as DiscordMessage[];

    // 봇 메시지 제외
    const botId = await this.getBotUserId();
    return messages.filter((m) => m.author.id !== botId && !m.author.bot);
  }

  /**
   * 권한 요청에 사용할 채널 ID를 결정합니다.
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
   * 사용자 DM 채널을 생성하거나 조회합니다.
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
   * 메시지에 반응을 추가합니다.
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
   * 특정 반응을 누른 사용자 목록을 가져옵니다.
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
      // 아직 반응이 없으면 빈 배열 반환
      if (response.status === 404) {
        return [];
      }
      const error = await response.text();
      throw new Error(`Failed to get reactions: ${error}`);
    }

    return (await response.json()) as DiscordUser[];
  }

  /**
   * 봇 정보를 조회합니다.
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
      user.discriminator !== '0'
        ? `${user.username}#${user.discriminator}`
        : user.username;

    return {
      name: `Discord (${username})`,
      identifier: username,
    };
  }

  /**
   * 최근 메시지를 가져옵니다.
   */
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

    // 봇 본인의 메시지는 제외
    const botInfo = await this.getBotUserId();
    return messages.filter((m) => m.author.id !== botInfo && !m.author.bot);
  }

  private botUserId: string | null = null;

  /**
   * 봇 사용자 ID를 조회합니다.
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
