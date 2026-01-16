#!/usr/bin/env bun
/**
 * Claude Code Permission Request Hook
 *
 * Routes Claude Code permission requests to Telegram/Discord.
 * Receives permission request info via stdin and outputs approval/rejection result as JSON.
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
 * Gets the session ID. Checks multiple sources.
 */
function getSessionId(input: PermissionRequestInput): string {
  // 1. Check session_id from input
  if (input.session_id) {
    return input.session_id;
  }

  // 2. Check environment variable
  if (process.env.CLAUDE_SESSION_ID) {
    return process.env.CLAUDE_SESSION_ID;
  }

  // 3. Generate consistent session ID based on cwd
  // (same cwd = same session, regardless of tool_use_id presence)
  return `session-${input.cwd}`;
}

interface SessionCache {
  sessionId: string;
  allowedTools: string[];
  createdAt: number;
}

/**
 * Defines the cascade blocking time after permission rejection.
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
 * Parses keyword list from environment variable.
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
 * Parses numeric environment variable.
 */
function parseNumberEnv(rawValue: string | undefined, fallback: number): number {
  const parsed = parseInt(rawValue || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Normalizes the rejection reason log path.
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
 * Loads configuration from environment variables.
 */
function loadConfig(): ServerConfig {
  // Validate value and use default in case DMPLZ_PROVIDER is misconfigured.
  const rawProvider = process.env.DMPLZ_PROVIDER;
  const provider: 'telegram' | 'discord' = rawProvider === 'discord' ? 'discord' : 'telegram';
  const questionTimeoutMs = parseNumberEnv(process.env.DMPLZ_QUESTION_TIMEOUT_MS, 180000); // default 3 minutes
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
      throw new Error('Telegram configuration is required: DMPLZ_TELEGRAM_BOT_TOKEN, DMPLZ_TELEGRAM_CHAT_ID');
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
      throw new Error('Discord configuration is required: DMPLZ_DISCORD_BOT_TOKEN, DMPLZ_DISCORD_CHANNEL_ID');
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
 * Creates a messaging provider.
 */
function createProvider(config: ServerConfig): MessagingProvider {
  if (config.provider === 'telegram') {
    return new TelegramProvider(config);
  } else {
    return new DiscordProvider(config);
  }
}

/**
 * Generates a permission request ID.
 */
function getRequestId(input: PermissionRequestInput): string {
  if (input.tool_use_id) {
    return input.tool_use_id;
  }

  const randomSuffix = Math.random().toString(36).slice(2, 10);
  return `request-${Date.now()}-${randomSuffix}`;
}

/**
 * Generates a user lock key.
 */
function createUserLockKey(config: ServerConfig): string {
  const baseId = config.permissionChatId || config.chatId;
  const userSuffix = config.discordDmUserId ? `-${config.discordDmUserId}` : '';
  return `${config.provider}-${baseId}${userSuffix}`;
}

/**
 * Generates a user lock path.
 */
function getUserLockPath(lockKey: string): string {
  const safeKey = lockKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `dmplz-permission-lock-${safeKey}.lock`);
}

/**
 * Acquires a user lock.
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
          // Ignore lock release failure
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
        // Retry on lock status check failure
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error('Timeout waiting for permission lock');
}

/**
 * Generates the cascade rejection state file path.
 */
function getCascadeStatePath(lockKey: string): string {
  const safeKey = lockKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `dmplz-permission-cascade-${safeKey}.json`);
}

/**
 * Reads the cascade rejection state.
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
 * Saves the cascade rejection state.
 */
function writeCascadeState(lockKey: string, state: RejectCascadeState): void {
  const statePath = getCascadeStatePath(lockKey);
  fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf-8' });
}

/**
 * Removes the cascade rejection state.
 */
function clearCascadeState(lockKey: string): void {
  const statePath = getCascadeStatePath(lockKey);

  if (!fs.existsSync(statePath)) {
    return;
  }

  try {
    fs.unlinkSync(statePath);
  } catch {
    // Ignore delete failure
  }
}

/**
 * Normalizes the rejection reason.
 */
function normalizeRejectReason(reason: string, maxChars: number): string {
  const trimmed = reason.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return trimmed.slice(0, maxChars);
}

/**
 * Determines the final rejection reason source.
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
 * Builds the rejection message to pass to Claude Code.
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
 * Builds the systemMessage to pass rejection reason as next instruction.
 */
function buildRejectionSystemMessage(reason: string, reasonSource: RejectReasonSource): string {
  const trimmedReason = reason.trim();

  if (reasonSource === 'user_input' && trimmedReason.length > 0) {
    return [
       'The user rejected the permission request.',
       `Next instruction: ${trimmedReason}`,
       'Treat this as a new user request. Stop the current attempt and re-plan before making further tool calls.',

    ].join('\n');
  }

   return [
     'The user rejected the permission request.',
     'No reason was provided. Stop the current attempt and ask for the next instruction via AskUserQuestion.',
   ].join('\n');

}

/**
 * Prepares the rejection log directory.
 */
function ensureRejectLogDirectory(logPath: string): void {
  const dirPath = path.dirname(logPath);
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Performs rejection log rotation.
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
 * Executes the log file lock.
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
          // Ignore lock release failure
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
 * Masks sensitive information patterns.
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
 * Partially masks token strings.
 */
function maskToken(token: string): string {
  if (token.length <= 8) {
    return '***';
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * Generates a single rejection log line.
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
 * Writes a rejection log entry.
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
 * Returns the session cache file path.
 */
function getSessionCachePath(sessionId: string): string {

  const tmpDir = os.tmpdir();
  return path.join(tmpDir, `dmplz-session-${sessionId}.json`);
}

/**
 * Loads the session cache.
 */
function loadSessionCache(sessionId: string): SessionCache | null {
  try {
    const cachePath = getSessionCachePath(sessionId);
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf-8');
      const cache = JSON.parse(data) as SessionCache;
      // Only cache within 24 hours is valid
      if (Date.now() - cache.createdAt < 24 * 60 * 60 * 1000) {
        return cache;
      }
    }
  } catch {
    // Ignore cache load failure
  }
  return null;
}

/**
 * Saves the session cache.
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
    // Ignore cache save failure
  }
}

/**
 * Checks if the tool is already allowed in the session.
 */
function isToolAllowedInSession(sessionId: string, toolName: string): boolean {
  const cache = loadSessionCache(sessionId);
  return cache?.allowedTools.includes(toolName) ?? false;
}

/**
 * Formats tool input into human-readable form.
 */
function formatToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return `\`\`\`\n${toolInput.command || '(no command)'}\n\`\`\``;

    case 'Write':
      return `File: \`${toolInput.file_path}\`\nContent length: ${String(toolInput.content || '').length} chars`;


    case 'Edit':
      return `File: \`${toolInput.file_path}\`\nChange: "${String(toolInput.old_string || '').slice(0, 50)}..." → "${String(toolInput.new_string || '').slice(0, 50)}..."`;


    case 'Read':
      return `File: \`${toolInput.file_path}\``;


    default:
      return JSON.stringify(toolInput, null, 2).slice(0, 500);
  }
}

/**
 * Extracts tool use reason/description.
 */
function getToolDescription(toolName: string, toolInput: Record<string, unknown>): string {
  // Use description field if present
  if (toolInput.description && typeof toolInput.description === 'string') {
    return toolInput.description;
  }

  // Default description per tool
  switch (toolName) {
    case 'Bash':
      return 'Run a terminal command';

    case 'Write':
      return 'Create/overwrite a file';

    case 'Edit':
      return 'Edit a file';

    case 'Read':
      return 'Read a file';

    case 'Glob':
      return 'Search files';

    case 'Grep':
      return 'Search contents';

    case 'Task':
      return 'Run a subtask';

    case 'WebFetch':
      return 'Fetch a web page';

    case 'WebSearch':
      return 'Search the web';

    default:
      return `Use tool: ${toolName}`;

  }
}

/**
 * Builds the permission request message.
 */
function createPermissionMessage(input: PermissionRequestInput): string {
  const toolDescription = formatToolInput(input.tool_name, input.tool_input);
  const reason = getToolDescription(input.tool_name, input.tool_input);

   return `🔐 *Claude Code Permission Request*

 *Reason:* ${reason}
 *Tool:* \`${input.tool_name}\`
 *Working directory:* \`${input.cwd}\`

 ${toolDescription}

 Approve?`;

}

/**
 * Reads JSON input from stdin.
 */
async function readStdin(): Promise<string> {
  const chunks: string[] = [];

  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
  }

  return chunks.join('');
}

/**
 * Outputs result as JSON.
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
 * Main function
 */
async function main(): Promise<void> {
  try {
    // Read input from stdin
    const inputText = await readStdin();
    const input = JSON.parse(inputText) as PermissionRequestInput;

    // Auto-approve AskUserQuestion as it's handled by PreToolUse hook
    if (input.tool_name === 'AskUserQuestion') {
      outputResult(true);
      return;
    }

    // Determine session ID
    const sessionId = getSessionId(input);
    console.error(`[dmplz] Session ID: ${sessionId}, Tool: ${input.tool_name}`);

    // Check session cache - if tool is already allowed
    if (isToolAllowedInSession(sessionId, input.tool_name)) {
      // Auto-approve tools already allowed in session
      console.error(`[dmplz] Tool "${input.tool_name}" auto-approved (session cache)`);
      outputResult(true);
      return;
    }

    // Generate permission request ID
    const requestId = getRequestId(input);

    // Load config and create provider
    const config = loadConfig();
    const provider = createProvider(config);

    // Get bot info (for mention detection, etc.)
    await provider.getInfo();

    // Build permission request message
    const message = createPermissionMessage(input);

    // Process permission request after acquiring user lock
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


    // Process response
    if (response === 'approve') {
      clearCascadeState(lockKey);
      outputResult(true);
    } else if (response === 'approve_session') {
      // Save to session cache
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
        // Write log first so Stop hook can read the reason.
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

      // Auto-reject subsequent permission requests from the same user for a period of time.
      writeCascadeState(lockKey, {
        createdAt: Date.now(),
        reason: normalizedReason,
        reasonSource: finalReasonSource,
        requestId,
        toolName: input.tool_name,
      });

      // Include systemMessage to pass rejection reason as new instruction.
      outputResult(false, denyMessage, undefined, systemMessage);
    } else {
      outputResult(false);
    }


  } catch (error) {
    // On error, default to allow to avoid blocking Claude workflow.
    // (Prevent entire workflow from stopping due to config issues/network errors)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Permission hook error (fail-open): ${errorMessage}`);

    // Allow tool execution even on error
    outputResult(true);
    process.exit(0);
  }
}

main();
