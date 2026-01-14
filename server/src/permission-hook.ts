#!/usr/bin/env bun
/**
 * Claude Code Permission Request Hook
 *
 * Claude Code의 권한 요청을 텔레그램/디스코드로 라우팅합니다.
 * stdin으로 권한 요청 정보를 받아서 승인/거부 결과를 JSON으로 출력합니다.
 */

import { TelegramProvider } from './providers/telegram.js';
import { DiscordProvider } from './providers/discord.js';
import type { ServerConfig, MessagingProvider, PermissionResponse } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface PermissionRequestInput {
  session_id?: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  cwd: string;
  permission_mode?: string;
}

/**
 * 세션 ID를 가져옵니다. 여러 소스에서 확인합니다.
 */
function getSessionId(input: PermissionRequestInput): string {
  // 1. 입력에서 session_id 확인
  if (input.session_id) {
    return input.session_id;
  }

  // 2. 환경 변수 확인
  if (process.env.CLAUDE_SESSION_ID) {
    return process.env.CLAUDE_SESSION_ID;
  }

  // 3. cwd 기반으로 일관된 세션 ID 생성
  // (tool_use_id 유무와 관계없이 같은 cwd면 같은 세션으로 취급)
  return `session-${input.cwd}`;
}

interface SessionCache {
  sessionId: string;
  allowedTools: string[];
  createdAt: number;
}

interface PermissionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: {
      behavior: 'allow' | 'deny';
      message?: string;
    };
  };
}

/**
 * 환경 변수에서 설정을 로드합니다.
 */
function loadConfig(): ServerConfig {
  const provider = (process.env.DMPLZ_PROVIDER || 'telegram') as 'telegram' | 'discord';
  const questionTimeoutMs = parseInt(process.env.DMPLZ_QUESTION_TIMEOUT_MS || '180000', 10); // 기본 3분

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
 * 세션 캐시 파일 경로를 반환합니다.
 */
function getSessionCachePath(sessionId: string): string {
  const tmpDir = os.tmpdir();
  return path.join(tmpDir, `dmplz-session-${sessionId}.json`);
}

/**
 * 세션 캐시를 로드합니다.
 */
function loadSessionCache(sessionId: string): SessionCache | null {
  try {
    const cachePath = getSessionCachePath(sessionId);
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf-8');
      const cache = JSON.parse(data) as SessionCache;
      // 24시간 이내의 캐시만 유효
      if (Date.now() - cache.createdAt < 24 * 60 * 60 * 1000) {
        return cache;
      }
    }
  } catch {
    // 캐시 로드 실패 시 무시
  }
  return null;
}

/**
 * 세션 캐시를 저장합니다.
 */
function saveSessionCache(sessionId: string, toolName: string): void {
  try {
    const cachePath = getSessionCachePath(sessionId);
    let cache = loadSessionCache(sessionId);

    if (!cache) {
      cache = {
        sessionId,
        allowedTools: [],
        createdAt: Date.now(),
      };
    }

    if (!cache.allowedTools.includes(toolName)) {
      cache.allowedTools.push(toolName);
    }

    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // 캐시 저장 실패 시 무시
  }
}

/**
 * 도구가 세션에서 이미 허용되었는지 확인합니다.
 */
function isToolAllowedInSession(sessionId: string, toolName: string): boolean {
  const cache = loadSessionCache(sessionId);
  return cache?.allowedTools.includes(toolName) ?? false;
}

/**
 * 도구 입력을 사람이 읽기 쉬운 형태로 포맷합니다.
 */
function formatToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return `\`\`\`\n${toolInput.command || '(no command)'}\n\`\`\``;

    case 'Write':
      return `파일: \`${toolInput.file_path}\`\n내용 길이: ${String(toolInput.content || '').length}자`;

    case 'Edit':
      return `파일: \`${toolInput.file_path}\`\n변경: "${String(toolInput.old_string || '').slice(0, 50)}..." → "${String(toolInput.new_string || '').slice(0, 50)}..."`;

    case 'Read':
      return `파일: \`${toolInput.file_path}\``;

    default:
      return JSON.stringify(toolInput, null, 2).slice(0, 500);
  }
}

/**
 * 도구 사용 이유/설명을 추출합니다.
 */
function getToolDescription(toolName: string, toolInput: Record<string, unknown>): string {
  // description 필드가 있으면 사용
  if (toolInput.description && typeof toolInput.description === 'string') {
    return toolInput.description;
  }

  // 도구별 기본 설명
  switch (toolName) {
    case 'Bash':
      return '터미널 명령 실행';
    case 'Write':
      return '파일 생성/덮어쓰기';
    case 'Edit':
      return '파일 수정';
    case 'Read':
      return '파일 읽기';
    case 'Glob':
      return '파일 검색';
    case 'Grep':
      return '내용 검색';
    case 'Task':
      return '하위 작업 실행';
    case 'WebFetch':
      return '웹 페이지 가져오기';
    case 'WebSearch':
      return '웹 검색';
    default:
      return `${toolName} 도구 사용`;
  }
}

/**
 * 권한 요청 메시지를 생성합니다.
 */
function createPermissionMessage(input: PermissionRequestInput): string {
  const toolDescription = formatToolInput(input.tool_name, input.tool_input);
  const reason = getToolDescription(input.tool_name, input.tool_input);

  return `🔐 *Claude Code 권한 요청*

*이유:* ${reason}
*도구:* \`${input.tool_name}\`
*작업 디렉토리:* \`${input.cwd}\`

${toolDescription}

승인하시겠습니까?`;
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

/**
 * 결과를 JSON으로 출력합니다.
 */
function outputResult(approved: boolean, message?: string): void {
  const output: PermissionHookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: approved ? 'allow' : 'deny',
        message: approved ? undefined : message || '사용자가 권한을 거부했습니다',
      },
    },
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
    const input = JSON.parse(inputText) as PermissionRequestInput;

    // AskUserQuestion은 PreToolUse 훅에서 처리하므로 자동 승인
    if (input.tool_name === 'AskUserQuestion') {
      outputResult(true);
      return;
    }

    // 세션 ID 결정
    const sessionId = getSessionId(input);
    console.error(`[dmplz] Session ID: ${sessionId}, Tool: ${input.tool_name}`);

    // 세션 캐시 확인 - 이미 허용된 도구인지
    if (isToolAllowedInSession(sessionId, input.tool_name)) {
      // 이미 세션에서 허용된 도구는 자동 승인
      console.error(`[dmplz] Tool "${input.tool_name}" auto-approved (session cache)`);
      outputResult(true);
      return;
    }

    // 설정 로드 및 프로바이더 생성
    const config = loadConfig();
    const provider = createProvider(config);

    // 봇 정보 조회 (멘션 감지 등을 위해)
    await provider.getInfo();

    // 권한 요청 메시지 생성
    const message = createPermissionMessage(input);

    // 텔레그램/디스코드로 권한 요청
    const response = await provider.requestPermission(message, config.questionTimeoutMs);

    // 응답 처리
    if (response === 'approve') {
      outputResult(true);
    } else if (response === 'approve_session') {
      // 세션 캐시에 저장
      saveSessionCache(sessionId, input.tool_name);
      console.error(`[dmplz] Tool "${input.tool_name}" added to session cache (session: ${sessionId})`);
      outputResult(true);
    } else {
      outputResult(false);
    }

  } catch (error) {
    // 오류 발생 시 거부로 처리
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Permission hook error: ${errorMessage}`);

    // 타임아웃이나 오류 시에도 JSON 출력
    outputResult(false, `권한 요청 처리 중 오류: ${errorMessage}`);
    process.exit(2); // 차단 오류
  }
}

main();
