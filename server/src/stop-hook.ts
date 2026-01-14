#!/usr/bin/env bun
/**
 * Claude Code Stop Hook
 * 
 * Claude가 작업을 멈출 때 텔레그램/디스코드로 작업 요약을 알림 보내고
 * 사용자의 다음 지시를 받아서 Claude가 계속 작업하도록 합니다.
 */

import { TelegramProvider } from './providers/telegram.js';
import { DiscordProvider } from './providers/discord.js';
import type { ServerConfig, MessagingProvider } from './types.js';
import { readFileSync, existsSync } from 'fs';

interface StopHookInput {
  session_id: string;
  transcript_path: string;  // JSONL 파일 경로
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  stop_hook_active: boolean;
}

interface TranscriptEntry {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  message?: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      name?: string;  // tool name
      input?: Record<string, unknown>;
    }>;
  };
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/**
 * Exit code 2 + stderr JSON 방식의 Stop hook 출력
 * 
 * Claude Code는 exit code 2를 받으면 stderr의 JSON을 파싱하여
 * reason 필드를 새로운 사용자 메시지로 처리합니다.
 * 
 * @see https://github.com/anthropics/claude-code/issues/10412
 */
interface StopHookOutput {
  continue: boolean;
  stopReason: string;
  suppressOutput: boolean;
  decision: 'block' | 'allow';
  reason: string;
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
 * 프로바이더를 생성합니다.
 */
function createProvider(config: ServerConfig): MessagingProvider {
  if (config.provider === 'telegram') {
    return new TelegramProvider(config);
  } else {
    return new DiscordProvider(config);
  }
}

/**
 * stdin에서 JSON 입력을 읽고 파싱합니다.
 */
async function readStdin(): Promise<StopHookInput | null> {
  try {
    const chunks: string[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(new TextDecoder().decode(chunk));
    }
    const input = chunks.join('');
    if (input.trim()) {
      return JSON.parse(input) as StopHookInput;
    }
  } catch (e) {
    // 파싱 실패 시 null 반환
  }
  return null;
}

/**
 * Transcript 파일을 읽고 최근 작업 내용을 추출합니다.
 */
function extractRecentWork(transcriptPath: string, maxLines: number = 50): string {
  try {
    if (!existsSync(transcriptPath)) {
      return '';
    }

    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    // 최근 항목들만 가져옴
    const recentLines = lines.slice(-maxLines);
    
    const workSummary: string[] = [];
    const toolsUsed: Set<string> = new Set();
    const filesModified: Set<string> = new Set();
    let lastAssistantMessage = '';

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        
        // Assistant 메시지에서 텍스트 추출
        if (entry.type === 'assistant' && entry.message?.content) {
          for (const block of entry.message.content) {
            if (block.type === 'text' && block.text) {
              lastAssistantMessage = block.text;
            }
            // Tool use 정보
            if (block.type === 'tool_use' && block.name) {
              toolsUsed.add(block.name);
              // 파일 관련 tool이면 파일 경로 추출
              if (block.input && (block.name === 'Write' || block.name === 'Edit' || block.name === 'Read')) {
                const filePath = block.input.file_path || block.input.filePath;
                if (typeof filePath === 'string') {
                  // 경로에서 파일명만 추출
                  const fileName = filePath.split(/[/\\]/).pop() || filePath;
                  filesModified.add(fileName);
                }
              }
            }
          }
        }
      } catch {
        // JSON 파싱 실패 무시
      }
    }

    // 요약 생성
    if (toolsUsed.size > 0) {
      workSummary.push(`🔧 사용한 도구: ${Array.from(toolsUsed).slice(0, 5).join(', ')}`);
    }
    
    if (filesModified.size > 0) {
      workSummary.push(`📁 작업한 파일: ${Array.from(filesModified).slice(0, 5).join(', ')}`);
    }

    // 마지막 Assistant 메시지 (200자로 제한)
    if (lastAssistantMessage) {
      const truncated = lastAssistantMessage.length > 200 
        ? lastAssistantMessage.substring(0, 200) + '...'
        : lastAssistantMessage;
      workSummary.push(`💬 마지막 응답: ${truncated}`);
    }

    return workSummary.join('\n');
  } catch (e) {
    // 파일 읽기 실패 시 빈 문자열 반환
    return '';
  }
}

/**
 * 알림 메시지를 생성합니다.
 */
function buildNotificationMessage(input: StopHookInput | null): string {
  let message = '🏁 *작업이 완료되었습니다.*\n\n';
  
  // Transcript에서 작업 내용 추출
  if (input?.transcript_path) {
    const workSummary = extractRecentWork(input.transcript_path);
    if (workSummary) {
      message += `📋 *작업 요약:*\n${workSummary}\n\n`;
    }
  }
  
  message += '💬 다음 지시를 입력하면 계속 진행합니다:';
  
  return message;
}

async function main() {
  try {
    // stdin 입력 읽기 및 파싱
    const input = await readStdin();

    // 설정 로드 및 프로바이더 준비
    const config = loadConfig();
    const provider = createProvider(config);
    
    // 봇 정보 초기화
    await provider.getInfo();

    // 알림 메시지 생성 및 전송
    const message = buildNotificationMessage(input);
    await provider.sendMessage(message, 'Markdown');

    // 사용자 응답 대기
    const reply = await provider.waitForReply(config.questionTimeoutMs);

    // 응답이 있으면 exit code 2 + stderr JSON으로 continuation 요청
    // @see https://github.com/anthropics/claude-code/issues/10412
    if (reply) {
      const output: StopHookOutput = {
        continue: true,
        stopReason: '',
        suppressOutput: false,
        decision: 'block',
        reason: reply,
      };
      // stderr로 JSON 출력 (Claude Code가 이를 파싱)
      console.error(JSON.stringify(output));
      // exit code 2 = continuation 요청
      process.exit(2);
    } else {
      // 응답 없음 - 그냥 종료
      process.exit(0);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Stop hook error/timeout: ${errorMessage}`);
    // 에러 시 그냥 종료 (Claude 멈춤)
    process.exit(0);
  }
}

main();
