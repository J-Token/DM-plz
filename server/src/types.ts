/**
 * DM-Plz MCP 서버 설정
 */
export interface ServerConfig {
  /**
   * 사용 플랫폼
   */
  provider: 'telegram' | 'discord';
  /**
   * 봇 토큰
   */
  botToken: string;
  /**
   * 기본 메시지 채팅/채널 ID
   */
  chatId: string;
  /**
   * 질문 응답 대기 시간(밀리초)
   */
  questionTimeoutMs: number;
  /**
   * 거부 사유 입력 대기 시간(밀리초)
   */
  rejectReasonTimeoutMs: number;
  /**
   * 거부 사유 최대 길이
   */
  rejectReasonMaxChars: number;
  /**
   * 거부 사유 로그 파일 경로
   */
  rejectReasonLogPath: string;
  /**
   * 거부 사유 로그 로테이션 기준 바이트
   */
  rejectReasonLogRotateBytes: number;
  /**
   * 거부 사유 로그 보관 파일 개수
   */
  rejectReasonLogMaxFiles: number;
  /**
   * 사유 없음 키워드 목록
   */
  rejectReasonNoReasonKeywords: string[];
  /**
   * 권한 요청을 보낼 채팅/채널 ID (선택)
   */
  permissionChatId?: string;
  /**
   * Discord 권한 요청을 DM으로 보낼 사용자 ID (선택)
   */
  discordDmUserId?: string;
}

/**
 * 거부 사유 출처 타입
 */
export type RejectReasonSource = 'user_input' | 'explicit_skip' | 'timeout';

/**
 * 거부 응답 타입
 */
export interface RejectPermissionResponse {
  type: 'reject';
  reason: string;
  reasonSource: RejectReasonSource;
}

/**
 * 권한 요청 응답 타입
 */
export type PermissionResponse = 'approve' | 'approve_session' | RejectPermissionResponse;

/**
 * 권한 요청 컨텍스트
 */
export interface PermissionRequestContext {
  requestId: string;
}

/**
 * 프로바이더 인터페이스 - 모든 메시징 프로바이더가 구현해야 함
 */
export interface MessagingProvider {
  /**
   * 메시지 전송
   */
  sendMessage(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<void>;

  /**
   * 사용자 응답 대기
   */
  waitForReply(timeoutMs: number): Promise<string>;

  /**
   * 사용자 승인 요청 (승인/거부/세션허용)
   */
  requestPermission(
    message: string,
    timeoutMs: number,
    context?: PermissionRequestContext
  ): Promise<PermissionResponse>;

  /**
   * 프로바이더 정보 조회
   */
  getInfo(): Promise<{ name: string; identifier: string }>;
}

/**
 * Telegram API 응답 타입
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
 * 대기 중인 질문 추적용 상태
 */
export interface QuestionState {
  questionId: string;
  lastUpdateId: number;
  sentAt: number;
  timeout: number;
}

/**
 * Discord API 응답 타입
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
