/**
 * Configuration for the DM-Plz MCP server
 */
export interface ServerConfig {
  provider: 'telegram' | 'discord';
  botToken: string;
  chatId: string;
  questionTimeoutMs: number;
}

/**
 * Provider interface - all messaging providers must implement this
 */
export interface MessagingProvider {
  /**
   * Send a message
   */
  sendMessage(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void>;

  /**
   * Wait for a reply from the user
   */
  waitForReply(timeoutMs: number): Promise<string>;

  /**
   * Get provider information
   */
  getInfo(): Promise<{ name: string; identifier: string }>;
}

/**
 * Telegram API response types
 */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

/**
 * Question state for tracking pending questions
 */
export interface QuestionState {
  questionId: string;
  lastUpdateId: number;
  sentAt: number;
  timeout: number;
}

/**
 * Discord API response types
 */
export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  avatar?: string;
  bot?: boolean;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  edited_timestamp?: string;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
}
