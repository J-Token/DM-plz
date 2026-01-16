/**
 * DM-Plz MCP Server Configuration
 */
export interface ServerConfig {
  /**
   * Messaging platform to use
   */
  provider: 'telegram' | 'discord';
  /**
   * Bot token
   */
  botToken: string;
  /**
   * Default message chat/channel ID
   */
  chatId: string;
  /**
   * Timeout for waiting for question responses (in milliseconds)
   */
  questionTimeoutMs: number;
  /**
   * Timeout for waiting for rejection reason input (in milliseconds)
   */
  rejectReasonTimeoutMs: number;
  /**
   * Maximum length for rejection reason
   */
  rejectReasonMaxChars: number;
  /**
   * File path for rejection reason logs
   */
  rejectReasonLogPath: string;
  /**
   * Log rotation threshold in bytes
   */
  rejectReasonLogRotateBytes: number;
  /**
   * Maximum number of log files to retain
   */
  rejectReasonLogMaxFiles: number;
  /**
   * Keywords that indicate no reason provided
   */
  rejectReasonNoReasonKeywords: string[];
  /**
   * Chat/channel ID for permission requests (optional)
   */
  permissionChatId?: string;
  /**
   * Discord user ID to send permission requests via DM (optional)
   */
  discordDmUserId?: string;
}

/**
 * Source type for rejection reason
 */
export type RejectReasonSource = 'user_input' | 'explicit_skip' | 'timeout';

/**
 * Rejection response type
 */
export interface RejectPermissionResponse {
  type: 'reject';
  reason: string;
  reasonSource: RejectReasonSource;
}

/**
 * Permission request response type
 */
export type PermissionResponse = 'approve' | 'approve_session' | RejectPermissionResponse;

/**
 * Permission request context
 */
export interface PermissionRequestContext {
  requestId: string;
}

/**
 * Provider interface - must be implemented by all messaging providers
 */
export interface MessagingProvider {
  /**
   * Send a message
   */
  sendMessage(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void>;

  /**
   * Send a message with reply keyboard buttons (buttons that auto-fill input)
   * When user taps a button, the button text is sent as a message.
   */
  sendMessageWithKeyboard(
    text: string,
    buttonTexts: string[],
    parseMode?: 'Markdown' | 'HTML'
  ): Promise<void>;

  /**
   * Wait for user response
   */
  waitForReply(timeoutMs: number): Promise<string>;

  /**
   * Request user approval (approve/reject/approve for session)
   */
  requestPermission(
    message: string,
    timeoutMs: number,
    context?: PermissionRequestContext
  ): Promise<PermissionResponse>;

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

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

/**
 * State for tracking pending questions
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
