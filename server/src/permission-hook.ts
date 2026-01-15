#!/usr/bin/env bun
/**
 * Claude Code Permission Request Hook
 *
 * Claude Code의 권한 요청을 텔레그램/디스코드로 라우팅합니다.
 * stdin으로 권한 요청 정보를 받아서 승인/거부 결과를 JSON으로 출력합니다.
 */

import { TelegramProvider } from './providers/telegram.js';
import { DiscordProvider } from './providers/discord.js';
import type {
  ServerConfig,
  MessagingProvider,
  PermissionResponse,
  RejectReasonSource,
} from './types.js';
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

/**
 * 권한 거부 후 연쇄 차단 시간을 정의합니다.
 */
const REJECT_CASCADE_WINDOW_MS = 5 * 1000;

interface RejectCascadeState {
  createdAt: number;
  reason: string;
  reasonSource: RejectReasonSource;
  requestId: string;
  toolName: string;
}

interface PermissionHookOutput {

  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: {
      behavior: 'allow' | 'deny';
      message?: string;
      interrupt?: boolean;
    };
  };
  systemMessage?: string;
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
  // DMPLZ_PROVIDER가 잘못 설정된 경우를 대비해 값 검증 후 기본값을 사용합니다.
  const rawProvider = process.env.DMPLZ_PROVIDER;
  const provider: 'telegram' | 'discord' = rawProvider === 'discord' ? 'discord' : 'telegram';
  const questionTimeoutMs = parseNumberEnv(process.env.DMPLZ_QUESTION_TIMEOUT_MS, 180000); // 기본 3분
  const rejectReasonTimeoutMs = parseNumberEnv(process.env.DMPLZ_REJECT_REASON_TIMEOUT_MS, 600000);
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
 * 권한 요청 ID를 생성합니다.
 */
function getRequestId(input: PermissionRequestInput): string {
  if (input.tool_use_id) {
    return input.tool_use_id;
  }

  const randomSuffix = Math.random().toString(36).slice(2, 10);
  return `request-${Date.now()}-${randomSuffix}`;
}

/**
 * 사용자 락 키를 생성합니다.
 */
function createUserLockKey(config: ServerConfig): string {
  const baseId = config.permissionChatId || config.chatId;
  const userSuffix = config.discordDmUserId ? `-${config.discordDmUserId}` : '';
  return `${config.provider}-${baseId}${userSuffix}`;
}

/**
 * 사용자 락 경로를 생성합니다.
 */
function getUserLockPath(lockKey: string): string {
  const safeKey = lockKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `dmplz-permission-lock-${safeKey}.lock`);
}

/**
 * 사용자 락을 획득합니다.
 */
async function acquireUserLock(lockKey: string, timeoutMs: number): Promise<() => void> {
  const lockPath = getUserLockPath(lockKey);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ createdAt: Date.now() }), { flag: 'wx' });
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // 락 해제 실패는 무시
        }
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > timeoutMs) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // 락 상태 확인 실패 시 재시도
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error('Timeout waiting for permission lock');
}

/**
 * 연쇄 거부 상태 파일 경로를 생성합니다.
 */
function getCascadeStatePath(lockKey: string): string {
  const safeKey = lockKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `dmplz-permission-cascade-${safeKey}.json`);
}

/**
 * 연쇄 거부 상태를 읽어옵니다.
 */
function readCascadeState(lockKey: string, windowMs: number): RejectCascadeState | null {
  const statePath = getCascadeStatePath(lockKey);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw) as RejectCascadeState;

    if (!Number.isFinite(state.createdAt)) {
      fs.unlinkSync(statePath);
      return null;
    }

    if (Date.now() - state.createdAt > windowMs) {
      fs.unlinkSync(statePath);
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * 연쇄 거부 상태를 저장합니다.
 */
function writeCascadeState(lockKey: string, state: RejectCascadeState): void {
  const statePath = getCascadeStatePath(lockKey);
  fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf-8' });
}

/**
 * 연쇄 거부 상태를 제거합니다.
 */
function clearCascadeState(lockKey: string): void {
  const statePath = getCascadeStatePath(lockKey);

  if (!fs.existsSync(statePath)) {
    return;
  }

  try {
    fs.unlinkSync(statePath);
  } catch {
    // 삭제 실패는 무시
  }
}

/**
 * 거부 사유를 정규화합니다.
 */
function normalizeRejectReason(reason: string, maxChars: number): string {
  const trimmed = reason.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return trimmed.slice(0, maxChars);
}

/**
 * 최종 거부 사유 출처를 결정합니다.
 */
function resolveReasonSource(reason: string, reasonSource: RejectReasonSource): RejectReasonSource {
  if (reasonSource === 'timeout') {
    return 'timeout';
  }

  if (reasonSource === 'user_input' && reason.length === 0) {
    return 'explicit_skip';
  }

  return reasonSource;
}

/**
 * Claude Code에 전달할 거부 메시지를 생성합니다.
 */
function buildDenyMessage(reason: string, reasonSource: RejectReasonSource): string {
  if (reasonSource === 'timeout') {
    return 'User rejected the request. (No reason provided: timeout)';
  }

  if (reasonSource === 'explicit_skip' || reason.length === 0) {
    return 'User rejected the request. (No reason provided)';
  }

  return `User rejected the request. Reason: ${reason}`;
}

/**
 * 거부 사유를 다음 지시로 전달하기 위한 systemMessage를 생성합니다.
 */
function buildRejectionSystemMessage(reason: string, reasonSource: RejectReasonSource): string {
  const trimmedReason = reason.trim();

  if (reasonSource === 'user_input' && trimmedReason.length > 0) {
    return [
      '사용자가 권한 요청을 거부했습니다.',
      `새 지시: ${trimmedReason}`,
      '이 지시를 새로운 사용자 요청으로 간주하고, 현재 시도하던 작업과 툴 호출을 중단한 뒤 다시 계획하세요.',
    ].join('\n');
  }

  return [
    '사용자가 권한 요청을 거부했습니다.',
    '사유가 없으므로 현재 작업을 중단하고 다음 지시를 AskUserQuestion으로 요청하세요.',
  ].join('\n');
}

/**
 * 거부 로그 디렉토리를 준비합니다.
 */
function ensureRejectLogDirectory(logPath: string): void {
  const dirPath = path.dirname(logPath);
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * 거부 로그 로테이션을 수행합니다.
 */
function rotateRejectLogIfNeeded(logPath: string, rotateBytes: number, maxFiles: number): void {
  if (!fs.existsSync(logPath)) {
    return;
  }

  const fileSize = fs.statSync(logPath).size;
  if (fileSize <= rotateBytes) {
    return;
  }

  if (maxFiles <= 0) {
    fs.truncateSync(logPath, 0);
    return;
  }

  const oldestPath = `${logPath}.${maxFiles}`;
  if (fs.existsSync(oldestPath)) {
    fs.unlinkSync(oldestPath);
  }

  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const sourcePath = `${logPath}.${index}`;
    const targetPath = `${logPath}.${index + 1}`;
    if (fs.existsSync(sourcePath)) {
      fs.renameSync(sourcePath, targetPath);
    }
  }

  fs.renameSync(logPath, `${logPath}.1`);
}

/**
 * 로그 파일 락을 실행합니다.
 */
async function withLogLock(logPath: string, action: () => void): Promise<void> {
  const lockPath = `${logPath}.lock`;
  const startTime = Date.now();
  const timeoutMs = 2000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' });
      try {
        action();
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // 락 해제 실패는 무시
        }
      }
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error('Reject log lock timeout');
}

/**
 * 민감 정보 패턴을 마스킹합니다.
 */
function maskSensitiveText(reason: string): string {
  const keyValuePattern = /(api[_-]?key|token|password|secret|access[_-]?key|authorization)\s*[:=]\s*([^\s,]+)/gi;
  let masked = reason.replace(keyValuePattern, (match, key, value) => {
    return `${key}=${maskToken(String(value))}`;
  });

  const longTokenPattern = /([A-Fa-f0-9]{32,}|[A-Za-z0-9+/=]{32,})/g;
  masked = masked.replace(longTokenPattern, (token) => maskToken(String(token)));

  return masked;
}

/**
 * 토큰 문자열을 부분 마스킹합니다.
 */
function maskToken(token: string): string {
  if (token.length <= 8) {
    return '***';
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * 거부 로그 한 줄을 생성합니다.
 */
function buildRejectLogLine(options: {
  provider: ServerConfig['provider'];
  requestId: string;
  toolName: string;
  cwd: string;
  reason: string;
  reasonSource: RejectReasonSource;
}): string {
  const maskedReason = maskSensitiveText(options.reason);
  const entry = {
    timestamp: new Date().toISOString(),
    provider: options.provider,
    decision: 'deny',
    request_id: options.requestId,
    tool_name: options.toolName,
    cwd: options.cwd,
    reason: maskedReason,
    reason_source: options.reasonSource,
  };

  return JSON.stringify(entry);
}

/**
 * 거부 로그를 기록합니다.
 */
async function appendRejectLog(
  config: ServerConfig,
  requestId: string,
  toolName: string,
  cwd: string,
  reason: string,
  reasonSource: RejectReasonSource
): Promise<void> {
  const logPath = config.rejectReasonLogPath;

  await withLogLock(logPath, () => {
    ensureRejectLogDirectory(logPath);
    rotateRejectLogIfNeeded(logPath, config.rejectReasonLogRotateBytes, config.rejectReasonLogMaxFiles);

    const line = buildRejectLogLine({
      provider: config.provider,
      requestId,
      toolName,
      cwd,
      reason,
      reasonSource,
    });

    fs.appendFileSync(logPath, `${line}\n`, { encoding: 'utf-8' });
  });
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
function outputResult(
  approved: boolean,
  message?: string,
  interrupt?: boolean,
  systemMessage?: string
): void {
  const output: PermissionHookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: approved ? 'allow' : 'deny',
        message: approved ? undefined : message || 'User rejected the request.',
        interrupt: approved ? undefined : interrupt,
      },
    },
  };

  if (systemMessage) {
    output.systemMessage = systemMessage;
  }

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

    // 권한 요청 ID 생성
    const requestId = getRequestId(input);

    // 설정 로드 및 프로바이더 생성
    const config = loadConfig();
    const provider = createProvider(config);

    // 봇 정보 조회 (멘션 감지 등을 위해)
    await provider.getInfo();

    // 권한 요청 메시지 생성
    const message = createPermissionMessage(input);

    // 사용자 락 획득 후 권한 요청 처리
    const lockKey = createUserLockKey(config);
    const lockStartTime = Date.now();
    const releaseLock = await acquireUserLock(lockKey, config.questionTimeoutMs);

    let response: PermissionResponse;
    try {
      const cascadeState = readCascadeState(lockKey, REJECT_CASCADE_WINDOW_MS);
      if (cascadeState) {
        const denyMessage = buildDenyMessage(cascadeState.reason, cascadeState.reasonSource);
        console.error(
          `[dmplz] Cascade reject for tool "${input.tool_name}" (source: ${cascadeState.reasonSource})`
        );
        outputResult(false, denyMessage);
        return;
      }

      const elapsedMs = Date.now() - lockStartTime;
      const remainingMs = Math.max(config.questionTimeoutMs - elapsedMs, 0);
      const effectiveTimeoutMs = Math.max(remainingMs, 1);
      response = await provider.requestPermission(message, effectiveTimeoutMs, { requestId });
    } finally {
      releaseLock();
    }


    // 응답 처리
    if (response === 'approve') {
      clearCascadeState(lockKey);
      outputResult(true);
    } else if (response === 'approve_session') {
      // 세션 캐시에 저장
      saveSessionCache(sessionId, input.tool_name);
      console.error(`[dmplz] Tool "${input.tool_name}" added to session cache (session: ${sessionId})`);
      clearCascadeState(lockKey);
      outputResult(true);
    } else if (typeof response === 'object' && response.type === 'reject') {
      const normalizedReason = normalizeRejectReason(response.reason || '', config.rejectReasonMaxChars);
      const finalReasonSource = resolveReasonSource(normalizedReason, response.reasonSource);
      const denyMessage = buildDenyMessage(normalizedReason, finalReasonSource);
      const systemMessage = buildRejectionSystemMessage(normalizedReason, finalReasonSource);

      console.error(
        `[dmplz] Tool "${input.tool_name}" rejected (source: ${finalReasonSource}) with reason: ${normalizedReason}`
      );

      try {
        // Stop 훅에서 사유를 읽을 수 있도록 로그를 먼저 기록합니다.
        await appendRejectLog(
          config,
          requestId,
          input.tool_name,
          input.cwd,
          normalizedReason,
          finalReasonSource
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[dmplz] Reject log append failed: ${errorMessage}`);
      }

      // 동일 사용자의 이후 권한 요청은 일정 시간 자동 거부로 처리합니다.
      writeCascadeState(lockKey, {
        createdAt: Date.now(),
        reason: normalizedReason,
        reasonSource: finalReasonSource,
        requestId,
        toolName: input.tool_name,
      });

      // 거부 사유를 새로운 지시로 전달하도록 systemMessage를 포함합니다.
      outputResult(false, denyMessage, undefined, systemMessage);
    } else {
      outputResult(false);
    }


  } catch (error) {
    // 오류 발생 시에는 Claude 사용 흐름을 막지 않도록 기본 허용합니다.
    // (설정 누락/네트워크 오류 등으로 전체 워크플로가 멈추는 것을 방지)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Permission hook error (fail-open): ${errorMessage}`);

    // 오류가 나더라도 도구 실행은 허용
    outputResult(true);
    process.exit(0);
  }
}

main();
