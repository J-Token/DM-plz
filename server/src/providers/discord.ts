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
  PermissionResponse,
} from '../types.js';

export class DiscordProvider implements MessagingProvider {
  private baseUrl = 'https://discord.com/api/v10';
  private config: ServerConfig;
  private lastMessageId: string | null = null;
  private permissionChannelId: string | null = null;
  private dmChannelId: string | null = null;

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
  async requestPermission(message: string, timeoutMs: number): Promise<PermissionResponse> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2초마다 폴링 (Discord 레이트 리밋)
    const permissionChannelId = await this.resolvePermissionChannelId();

    // 권한 요청 메시지 전송
    const response = await fetch(`${this.baseUrl}/channels/${permissionChannelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message + '\n\n✅ 승인 | 🔄 세션 허용 | ❌ 거부' }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discord API error (${response.status}): ${error}`);
    }

    const sentMessage = (await response.json()) as DiscordMessage;
    const messageId = sentMessage.id;

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
          return 'approve';
        }

        // 세션 허용 반응 확인 (🔄)
        const sessionUsers = await this.getReactionUsers(messageId, '🔄');
        const userSessionApproved = sessionUsers.some((user) => user.id !== botId && !user.bot);
        if (userSessionApproved) {
          return 'approve_session';
        }

        // 거부 반응 확인 (❌)
        const rejectUsers = await this.getReactionUsers(messageId, '❌');
        const userRejected = rejectUsers.some((user) => user.id !== botId && !user.bot);
        if (userRejected) {
          return 'reject';
        }
      } catch (error) {
        console.error('Error checking reactions:', error);
      }

      // 타임아웃 확인
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for permission response');
      }
    }

    throw new Error('Timeout waiting for permission response');
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
    if (this.dmChannelId) {
      return this.dmChannelId;
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
    this.dmChannelId = channel.id;
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
