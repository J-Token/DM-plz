/**
 * Provider Factory
 *
 * Creates the appropriate messaging provider based on configuration
 */

import type { ServerConfig, MessagingProvider } from '../types.js';
import { TelegramProvider } from './telegram.js';
import { DiscordProvider } from './discord.js';

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
