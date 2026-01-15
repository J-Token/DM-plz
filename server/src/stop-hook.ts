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
import * as os from 'os';
import * as path from 'path';

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
 * ⚠️ 알려진 버그 (2025년 1월 기준):
 * Plugin으로 설치된 Stop hook은 exit code 2가 제대로 작동하지 않습니다.
 * - GitHub Issue #10412: https://github.com/anthropics/claude-code/issues/10412
 * - GitHub Issue #10875: https://github.com/anthropics/claude-code/issues/10875
 *
 * Workaround:
 * 1. ~/.claude/hooks/에 직접 설치하거나
 * 2. ~/.claude/settings.json에 inline hook으로 정의
 *
 * 예시 (settings.json):
 * {
 *   "hooks": {
 *     "Stop": [{
 *       "matcher": "*",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "bun run /path/to/stop-hook.ts",
 *         "timeout": 300000
 *       }]
 *     }]
 *   }
 * }
 */
interface StopHookOutput {
  continue: boolean;
  stopReason: string;
  suppressOutput: boolean;
  decision: 'block' | 'allow';
  reason: string;
}

/**
 * 키워드 목록 환경 변수를 파싱합니다.
 */
function parseKeywordList(rawValue: string | undefined, fallback: string[]): string[] {
  if (!rawValue) {
    return fallback;
  }

  const keywords = rawValue
    .split(',')
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);

  return keywords.length > 0 ? keywords : fallback;
}

/**
 * 숫자형 환경 변수를 파싱합니다.
 */
function parseNumberEnv(rawValue: string | undefined, fallback: number): number {
  const parsed = parseInt(rawValue || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 거부 사유 로그 경로를 정규화합니다.
 */
function resolveRejectLogPath(rawPath: string | undefined): string {
  const defaultPath = path.join(os.homedir(), '.claude', 'dm-plz', 'rejections.jsonl');
  const resolvedPath = rawPath && rawPath.length > 0 ? rawPath : defaultPath;

  if (resolvedPath.startsWith('~')) {
    const trimmedPath = resolvedPath.slice(1).replace(/^[/\\]/, '');
    return path.join(os.homedir(), trimmedPath);
  }

  return resolvedPath;
}

/**
 * 환경 변수에서 설정을 로드합니다.
 */
function loadConfig(): ServerConfig {
  const rawProvider = process.env.DMPLZ_PROVIDER;
  const provider: 'telegram' | 'discord' = rawProvider === 'discord' ? 'discord' : 'telegram';
  const questionTimeoutMs = parseNumberEnv(process.env.DMPLZ_QUESTION_TIMEOUT_MS, 180000);
  const rejectReasonTimeoutMs = parseNumberEnv(process.env.DMPLZ_REJECT_REASON_TIMEOUT_MS, 60000);
  const rejectReasonMaxChars = parseNumberEnv(process.env.DMPLZ_REJECT_REASON_MAX_CHARS, 300);
  const rejectReasonLogPath = resolveRejectLogPath(process.env.DMPLZ_REJECT_REASON_LOG_PATH);
  const rejectReasonLogRotateBytes = parseNumberEnv(
    process.env.DMPLZ_REJECT_REASON_LOG_ROTATE_BYTES,
    10485760
  );
  const rejectReasonLogMaxFiles = parseNumberEnv(process.env.DMPLZ_REJECT_REASON_LOG_MAX_FILES, 10);
  const rejectReasonNoReasonKeywords = parseKeywordList(
    process.env.DMPLZ_REJECT_REASON_NO_REASON_KEYWORDS,
    ['no_reason']
  );

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
      rejectReasonTimeoutMs,
      rejectReasonMaxChars,
      rejectReasonLogPath,
      rejectReasonLogRotateBytes,
      rejectReasonLogMaxFiles,
      rejectReasonNoReasonKeywords,
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
      rejectReasonTimeoutMs,
      rejectReasonMaxChars,
      rejectReasonLogPath,
      rejectReasonLogRotateBytes,
      rejectReasonLogMaxFiles,
      rejectReasonNoReasonKeywords,
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

interface RejectLogEntry {
  timestamp: string;
  decision: 'deny' | string;
  tool_name?: string;
  cwd?: string;
  reason?: string;
}

/**
 * 거부 로그(JSONL) 한 줄을 파싱합니다.
 */
function parseRejectLogLine(line: string): RejectLogEntry | null {
  try {
    return JSON.parse(line) as RejectLogEntry;
  } catch {
    return null;
  }
}

/**
 * 사용자에게 표시할 거부 사유 문자열을 정리합니다.
 */
function formatRejectReason(reason: string | undefined): string {
  const trimmed = (reason || '').trim();
  return trimmed.length > 0 ? trimmed : '이유없음';
}

/**
 * 최근에 발생한 거부(deny) 로그가 있으면 반환합니다.
 */
function findRecentRejection(options: {
  logPath: string;
  cwd?: string;
  withinMs: number;
}): RejectLogEntry | null {
  try {
    if (!existsSync(options.logPath)) {
      return null;
    }

    const content = readFileSync(options.logPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    const now = Date.now();
    const cutoff = now - options.withinMs;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parseRejectLogLine(lines[index]);
      if (!entry) {
        continue;
      }

      if (entry.decision !== 'deny') {
        continue;
      }

      const timestampMs = Date.parse(entry.timestamp);
      if (!Number.isFinite(timestampMs)) {
        continue;
      }

      if (timestampMs < cutoff) {
        // 최신부터 역순 탐색 중이므로, 이보다 더 오래된 로그는 볼 필요가 없습니다.
        break;
      }

      if (options.cwd && entry.cwd && entry.cwd !== options.cwd) {
        continue;
      }

      return entry;
    }
  } catch {
    // 로그 파싱 실패 시 무시
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
function buildNotificationMessage(input: StopHookInput | null, recentRejection: RejectLogEntry | null): string {
  let message = recentRejection
    ? '⛔ *권한 거부로 작업이 중단되었습니다.*\n\n'
    : '🏁 *작업이 완료되었습니다.*\n\n';

  if (recentRejection) {
    const toolName = recentRejection.tool_name || 'unknown';
    const reason = formatRejectReason(recentRejection.reason);
    message += `*도구:* \`${toolName}\`\n*사유:* ${reason}\n\n`;
  }

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

/**
 * 거부 사유를 포함해 continuation 메시지를 구성합니다.
 */
function buildContinuationReason(reply: string, recentRejection: RejectLogEntry | null): string {
  const trimmedReply = reply.trim();

  if (!recentRejection) {
    return trimmedReply.length > 0 ? trimmedReply : reply;
  }

  const toolName = recentRejection.tool_name || 'unknown';
  const reason = formatRejectReason(recentRejection.reason);

  if (trimmedReply.length === 0) {
    return `권한 거부로 중단됨. 도구=${toolName}, 요청=${reason}`;
  }

  return `권한 거부로 중단됨. 도구=${toolName}, 요청=${reason}\n추가 지시: ${trimmedReply}`;
}

/**
 * Stop 훅 처리 흐름을 실행합니다.
 */
async function main() {
  try {
    // stdin 입력 읽기 및 파싱
    const input = await readStdin();

    // 설정 로드 및 프로바이더 준비
    const config = loadConfig();
    const provider = createProvider(config);

    const recentRejection = findRecentRejection({
      logPath: config.rejectReasonLogPath,
      cwd: input?.cwd,
      withinMs: 2 * 60 * 1000,
    });
    
    // 봇 정보 초기화
    await provider.getInfo();

    // 알림 메시지 생성 및 전송
    const message = buildNotificationMessage(input, recentRejection);
    await provider.sendMessage(message, 'Markdown');

    // 사용자 응답 대기
    const reply = await provider.waitForReply(config.questionTimeoutMs);

    // 응답이 있으면 exit code 2 + stderr JSON으로 continuation 요청
    if (reply) {
      const continuationReason = buildContinuationReason(reply, recentRejection);
      const output: StopHookOutput = {
        continue: true,
        stopReason: '',
        suppressOutput: false,
        decision: 'block',
        reason: continuationReason,
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
