/**
 * 프로바이더 팩토리
 *
 * 설정에 따라 적절한 메시징 프로바이더를 생성합니다.
 */

import type { ServerConfig, MessagingProvider } from '../types.js';
import { TelegramProvider } from './telegram.js';
import { DiscordProvider } from './discord.js';

/**
 * 설정에 맞는 메시징 프로바이더를 생성합니다.
 */
export function createProvider(config: ServerConfig): MessagingProvider {
  switch (config.provider) {
    case 'telegram':
      return new TelegramProvider(config);
    case 'discord':
      return new DiscordProvider(config);
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

export { TelegramProvider } from './telegram.js';
export { DiscordProvider } from './discord.js';
