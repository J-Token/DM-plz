#!/usr/bin/env bun
/**
 * Claude Code AskUserQuestion Hook
 *
 * Claude Code의 AskUserQuestion 도구 호출을 텔레그램/디스코드로 라우팅합니다.
 * stdin으로 도구 입력을 받아서 사용자 응답을 JSON으로 출력합니다.
 */

import type { ServerConfig, PermissionResponse } from './types.js';

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface AskUserQuestionInput {
  tool_input: {
    questions: Question[];
  };
}

interface HookOutput {
  continue: boolean;
  result?: {
    answers: Record<string, string>;
  };
  reason?: string;
}

/**
 * 환경 변수에서 설정을 로드합니다.
 */
function loadConfig(): ServerConfig {
  const provider = (process.env.DMPLZ_PROVIDER || 'telegram') as 'telegram' | 'discord';
  const questionTimeoutMs = parseInt(process.env.DMPLZ_QUESTION_TIMEOUT_MS || '180000', 10);

  if (provider === 'telegram') {
    const botToken = process.env.DMPLZ_TELEGRAM_BOT_TOKEN;
    const chatId = process.env.DMPLZ_TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      throw new Error('Telegram 설정이 필요합니다: DMPLZ_TELEGRAM_BOT_TOKEN, DMPLZ_TELEGRAM_CHAT_ID');
    }

    return {
      provider,
      botToken,
      chatId,
      questionTimeoutMs,
      permissionChatId: process.env.DMPLZ_PERMISSION_CHAT_ID,
    };
  } else {
    const botToken = process.env.DMPLZ_DISCORD_BOT_TOKEN;
    const chatId = process.env.DMPLZ_DISCORD_CHANNEL_ID;

    if (!botToken || !chatId) {
      throw new Error('Discord 설정이 필요합니다: DMPLZ_DISCORD_BOT_TOKEN, DMPLZ_DISCORD_CHANNEL_ID');
    }

    return {
      provider,
      botToken,
      chatId,
      questionTimeoutMs,
      permissionChatId: process.env.DMPLZ_PERMISSION_CHAT_ID,
      discordDmUserId: process.env.DMPLZ_DISCORD_DM_USER_ID,
    };
  }
}

/**
 * stdin에서 JSON 입력을 읽습니다.
 */
async function readStdin(): Promise<string> {
  const chunks: string[] = [];

  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
  }

  return chunks.join('');
}

// ============== Telegram Implementation ==============

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

class TelegramQuestionHandler {
  private baseUrl: string;
  private chatId: string;
  private lastUpdateId: number = 0;

  constructor(botToken: string, chatId: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.chatId = chatId;
  }

  /**
   * 초기 업데이트 ID를 설정합니다.
   */
  async initialize(): Promise<void> {
    const updates = await this.getUpdates(0, 0);
    if (updates.length > 0) {
      this.lastUpdateId = Math.max(...updates.map(u => u.update_id));
    }
  }

  /**
   * 질문을 전송하고 응답을 받습니다.
   */
  async askQuestion(question: Question, timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollTimeout = 10;

    // 질문 메시지 생성
    let messageText = `❓ *Claude Code 질문*\n\n`;
    if (question.header) {
      messageText += `*[${question.header}]*\n`;
    }
    messageText += `${question.question}\n\n`;

    // 옵션 설명 추가
    question.options.forEach((opt, idx) => {
      messageText += `${idx + 1}. *${opt.label}*`;
      if (opt.description) {
        messageText += ` - ${opt.description}`;
      }
      messageText += '\n';
    });

    // 인라인 키보드 생성
    const keyboard: { text: string; callback_data: string }[][] = [];

    // 옵션 버튼 (2개씩 한 줄에)
    for (let i = 0; i < question.options.length; i += 2) {
      const row: { text: string; callback_data: string }[] = [];
      row.push({
        text: question.options[i].label,
        callback_data: `opt_${i}`,
      });
      if (i + 1 < question.options.length) {
        row.push({
          text: question.options[i + 1].label,
          callback_data: `opt_${i + 1}`,
        });
      }
      keyboard.push(row);
    }

    // 커스텀 입력 버튼
    keyboard.push([{ text: '✏️ 직접 입력', callback_data: 'custom_input' }]);

    // 메시지 전송
    const params = {
      chat_id: this.chatId,
      text: messageText,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard,
      },
    };

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json() as TelegramResponse<TelegramMessage>;
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    const messageId = data.result.message_id;
    const currentUpdateId = this.lastUpdateId;

    // 응답 대기
    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      for (const update of updates) {
        // 콜백 쿼리 (버튼 클릭)
        if (update.callback_query) {
          const query = update.callback_query;
          const queryChatId = query.message?.chat.id?.toString();

          if (queryChatId !== this.chatId) continue;

          await this.answerCallbackQuery(query.id);

          if (query.data === 'custom_input') {
            // 커스텀 입력 모드
            await this.sendMessage('💬 답변을 직접 입력해주세요:');
            const customAnswer = await this.waitForTextMessage(timeoutMs - (Date.now() - startTime));
            await this.editMessageReplyMarkup(messageId); // 버튼 제거
            return customAnswer;
          } else if (query.data?.startsWith('opt_')) {
            const optIndex = parseInt(query.data.replace('opt_', ''), 10);
            const selectedOption = question.options[optIndex];
            await this.editMessageReplyMarkup(messageId); // 버튼 제거
            return selectedOption.label;
          }
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for answer');
      }
    }

    throw new Error('Timeout waiting for answer');
  }

  /**
   * 텍스트 메시지를 대기합니다.
   */
  private async waitForTextMessage(timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollTimeout = 10;
    const currentUpdateId = this.lastUpdateId;

    while (Date.now() - startTime < timeoutMs) {
      const updates = await this.getUpdates(currentUpdateId + 1, pollTimeout);

      for (const update of updates) {
        if (update.message?.text && update.message.chat.id.toString() === this.chatId) {
          return update.message.text;
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for text input');
      }
    }

    throw new Error('Timeout waiting for text input');
  }

  /**
   * 메시지를 전송합니다.
   */
  private async sendMessage(text: string): Promise<void> {
    await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
      }),
    });
  }

  /**
   * 메시지의 reply_markup을 제거합니다.
   */
  private async editMessageReplyMarkup(messageId: number): Promise<void> {
    await fetch(`${this.baseUrl}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    });
  }

  /**
   * 콜백 쿼리에 응답합니다.
   */
  private async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  }

  /**
   * 업데이트를 가져옵니다.
   */
  private async getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    const params = {
      offset: offset || this.lastUpdateId + 1,
      timeout,
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    };

    const response = await fetch(`${this.baseUrl}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json() as TelegramResponse<TelegramUpdate[]>;
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    if (data.result.length > 0) {
      const maxId = Math.max(...data.result.map(u => u.update_id));
      this.lastUpdateId = maxId;
    }

    return data.result;
  }
}

// ============== Discord Implementation ==============

interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; bot?: boolean };
}

interface DiscordUser {
  id: string;
  bot?: boolean;
}

class DiscordQuestionHandler {
  private baseUrl = 'https://discord.com/api/v10';
  private botToken: string;
  private channelId: string;
  private botUserId: string | null = null;

  constructor(botToken: string, channelId: string) {
    this.botToken = botToken;
    this.channelId = channelId;
  }

  /**
   * 봇 사용자 ID를 조회합니다.
   */
  async initialize(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/users/@me`, {
      headers: { Authorization: `Bot ${this.botToken}` },
    });
    const user = await response.json() as DiscordUser;
    this.botUserId = user.id;
  }

  /**
   * 질문을 전송하고 응답을 받습니다.
   */
  async askQuestion(question: Question, timeoutMs: number): Promise<string> {
    const startTime = Date.now();
    const pollInterval = 2000;

    // 질문 메시지 생성
    let messageText = `❓ **Claude Code 질문**\n\n`;
    if (question.header) {
      messageText += `**[${question.header}]**\n`;
    }
    messageText += `${question.question}\n\n`;

    // 옵션 설명 추가
    question.options.forEach((opt, idx) => {
      messageText += `${idx + 1}. **${opt.label}**`;
      if (opt.description) {
        messageText += ` - ${opt.description}`;
      }
      messageText += '\n';
    });

    messageText += `\n숫자를 입력하거나 직접 답변을 입력하세요:`;

    // 메시지 전송
    const response = await fetch(`${this.baseUrl}/channels/${this.channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: messageText }),
    });

    const sentMessage = await response.json() as DiscordMessage;
    const afterMessageId = sentMessage.id;

    // 응답 대기
    while (Date.now() - startTime < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const messages = await this.getMessagesAfter(afterMessageId);

      for (const msg of messages) {
        if (msg.author.id === this.botUserId || msg.author.bot) continue;

        const text = msg.content.trim();

        // 숫자로 옵션 선택
        const num = parseInt(text, 10);
        if (!isNaN(num) && num >= 1 && num <= question.options.length) {
          return question.options[num - 1].label;
        }

        // 직접 입력
        return text;
      }

      if (Date.now() - startTime >= timeoutMs) {
        throw new Error('Timeout waiting for answer');
      }
    }

    throw new Error('Timeout waiting for answer');
  }

  /**
   * 특정 메시지 이후의 메시지를 가져옵니다.
   */
  private async getMessagesAfter(afterId: string): Promise<DiscordMessage[]> {
    const response = await fetch(
      `${this.baseUrl}/channels/${this.channelId}/messages?after=${afterId}&limit=10`,
      {
        headers: { Authorization: `Bot ${this.botToken}` },
      }
    );

    return await response.json() as DiscordMessage[];
  }
}

/**
 * 결과를 JSON으로 출력합니다.
 */
function outputResult(answers: Record<string, string>): void {
  const output: HookOutput = {
    continue: true,
    result: { answers },
  };
  console.log(JSON.stringify(output));
}

/**
 * 오류 결과를 JSON으로 출력합니다.
 */
function outputError(reason: string): void {
  const output: HookOutput = {
    continue: false,
    reason,
  };
  console.log(JSON.stringify(output));
}

/**
 * 메인 함수
 */
async function main(): Promise<void> {
  try {
    // stdin에서 입력 읽기
    const inputText = await readStdin();
    const input = JSON.parse(inputText) as AskUserQuestionInput;

    const questions = input.tool_input?.questions;
    if (!questions || questions.length === 0) {
      outputError('질문이 없습니다');
      return;
    }

    // 설정 로드
    const config = loadConfig();
    const answers: Record<string, string> = {};

    if (config.provider === 'telegram') {
      const handler = new TelegramQuestionHandler(
        config.botToken,
        config.permissionChatId || config.chatId
      );
      await handler.initialize();

      // 각 질문에 대해 응답 수집
      for (let i = 0; i < questions.length; i++) {
        const answer = await handler.askQuestion(questions[i], config.questionTimeoutMs);
        answers[`question-${i}`] = answer;
      }
    } else {
      const handler = new DiscordQuestionHandler(
        config.botToken,
        config.permissionChatId || config.chatId
      );
      await handler.initialize();

      // 각 질문에 대해 응답 수집
      for (let i = 0; i < questions.length; i++) {
        const answer = await handler.askQuestion(questions[i], config.questionTimeoutMs);
        answers[`question-${i}`] = answer;
      }
    }

    // 결과 출력
    outputResult(answers);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Question hook error: ${errorMessage}`);
    outputError(`질문 처리 중 오류: ${errorMessage}`);
  }
}

main();
