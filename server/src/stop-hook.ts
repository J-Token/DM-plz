#!/usr/bin/env bun
/**
 * Claude Code Stop Hook
 * 
 * When Claude stops working, sends a summary notification via Telegram/Discord
 * and waits for the user's next instruction to continue working.
 */

import { TelegramProvider } from './providers/telegram.js';
import { DiscordProvider } from './providers/discord.js';
import type { ServerConfig, MessagingProvider } from './types.js';
import { readFileSync, existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

interface StopHookInput {
  session_id: string;
  transcript_path: string;  // JSONL file path
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
 * Stop hook output using exit code 2 + stderr JSON format
 *
 * Claude Code parses the JSON from stderr when it receives exit code 2
 * and treats the reason field as a new user message.
 *
 * ⚠️ Known bug (as of January 2025):
 * Stop hooks installed as plugins don't work properly with exit code 2.
 * - GitHub Issue #10412: https://github.com/anthropics/claude-code/issues/10412
 * - GitHub Issue #10875: https://github.com/anthropics/claude-code/issues/10875
 *
 * Workaround:
 * 1. Install directly in ~/.claude/hooks/
 * 2. Define as inline hook in ~/.claude/settings.json
 *
 * Example (settings.json):
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
 * Reads and parses JSON input from stdin.
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
    // Return null on parse failure
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
 * Parses a single line of rejection log (JSONL).
 */
function parseRejectLogLine(line: string): RejectLogEntry | null {
  try {
    return JSON.parse(line) as RejectLogEntry;
  } catch {
    return null;
  }
}

/**
 * Formats the rejection reason string for display to user.
 */
function formatRejectReason(reason: string | undefined): string {
  const trimmed = (reason || '').trim();
  return trimmed.length > 0 ? trimmed : 'none';
}

/**
 * Returns recent rejection (deny) log entry if exists.
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
        // Traversing in reverse from newest, no need to check older logs.
        break;
      }

      if (options.cwd && entry.cwd && entry.cwd !== options.cwd) {
        continue;
      }

      return entry;
    }
  } catch {
    // Ignore log parsing failures
  }

  return null;
}

/**
 * Reads transcript file and extracts recent work summary.
 */
function extractRecentWork(transcriptPath: string, maxLines: number = 50): string {
  try {
    if (!existsSync(transcriptPath)) {
      return '';
    }

    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    // Get only recent entries
    const recentLines = lines.slice(-maxLines);
    
    const workSummary: string[] = [];
    const toolsUsed: Set<string> = new Set();
    const filesModified: Set<string> = new Set();
    let lastAssistantMessage = '';

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        
        // Extract text from assistant messages
        if (entry.type === 'assistant' && entry.message?.content) {
          for (const block of entry.message.content) {
            if (block.type === 'text' && block.text) {
              lastAssistantMessage = block.text;
            }
            // Tool use information
            if (block.type === 'tool_use' && block.name) {
              toolsUsed.add(block.name);
              // Extract file path for file-related tools
              if (block.input && (block.name === 'Write' || block.name === 'Edit' || block.name === 'Read')) {
                const filePath = block.input.file_path || block.input.filePath;
                if (typeof filePath === 'string') {
                  // Extract only filename from path
                  const fileName = filePath.split(/[/\\]/).pop() || filePath;
                  filesModified.add(fileName);
                }
              }
            }
          }
        }
      } catch {
        // Ignore JSON parse failures
      }
    }

    // Generate summary
    if (toolsUsed.size > 0) {
      workSummary.push(`🔧 Tools used: ${Array.from(toolsUsed).slice(0, 5).join(', ')}`);
    }
    
    if (filesModified.size > 0) {
      workSummary.push(`📁 Files touched: ${Array.from(filesModified).slice(0, 5).join(', ')}`);
    }

    // Last assistant message (limited to 200 chars)
    if (lastAssistantMessage) {
      const truncated = lastAssistantMessage.length > 200 
        ? lastAssistantMessage.substring(0, 200) + '...'
        : lastAssistantMessage;
      workSummary.push(`💬 Last response: ${truncated}`);
    }

    return workSummary.join('\n');
  } catch (e) {
    // Return empty string on file read failure
    return '';
  }
}

/**
 * Quick reply button text list
 */
const QUICK_REPLY_BUTTONS = [
  '👍 Continue',
  '✅ LGTM (Stop)',
  '🔄 Retry',
];

/**
 * Checks if the reply is the LGTM button (interrupt trigger).
 */
function isLgtmButton(reply: string): boolean {
  const normalized = reply.trim().toLowerCase();
  return normalized.includes('lgtm') && normalized.includes('stop');
}

/**
 * Builds the notification message.
 */
function buildNotificationMessage(input: StopHookInput | null, recentRejection: RejectLogEntry | null): string {
  let message = recentRejection
    ? '⛔ *Work stopped due to a permission rejection.*\n\n'
    : '🏁 *Work is complete.*\n\n';

  if (recentRejection) {
    const toolName = recentRejection.tool_name || 'unknown';
    const reason = formatRejectReason(recentRejection.reason);
    message += `*Tool:* \`${toolName}\`\n*Reason:* ${reason}\n\n`;
  }

  // Extract work summary from transcript
  if (input?.transcript_path) {
    const workSummary = extractRecentWork(input.transcript_path);
    if (workSummary) {
      message += `📋 *Summary:*\n${workSummary}\n\n`;
    }
  }

  message += '💬 Tap a button or type your next instruction:';

  return message;
}

/**
 * Builds the continuation message including rejection reason.
 */
function buildContinuationReason(reply: string, recentRejection: RejectLogEntry | null): string {
  const trimmedReply = reply.trim();

  if (!recentRejection) {
    return trimmedReply.length > 0 ? trimmedReply : reply;
  }

  const toolName = recentRejection.tool_name || 'unknown';
  const reason = formatRejectReason(recentRejection.reason);

  if (trimmedReply.length === 0) {
    return `Stopped due to permission rejection. tool=${toolName}, reason=${reason}`;
  }

  return `Stopped due to permission rejection. tool=${toolName}, reason=${reason}\nNext instruction: ${trimmedReply}`;
}

/**
 * Executes the Stop hook processing flow.
 */
async function main() {
  try {
    // Read and parse stdin input
    const input = await readStdin();

    // Load config and prepare provider
    const config = loadConfig();
    const provider = createProvider(config);

    const recentRejection = findRecentRejection({
      logPath: config.rejectReasonLogPath,
      cwd: input?.cwd,
      withinMs: 2 * 60 * 1000,
    });
    
    // Initialize bot info
    await provider.getInfo();

    // Build notification message and send with keyboard buttons
    const message = buildNotificationMessage(input, recentRejection);
    await provider.sendMessageWithKeyboard(message, QUICK_REPLY_BUTTONS, 'Markdown');

    // Wait for user response (button tap or direct input)
    const reply = await provider.waitForReply(config.questionTimeoutMs);

    // Process response if received
    if (reply) {
      // Check LGTM (Stop) button - interrupt handling
      if (isLgtmButton(reply)) {
        // Send interrupt warning message
        await provider.sendMessage('⚠️ *Stopping work.* Claude will not continue.\n\n✅ Work has been reviewed and approved.', 'Markdown');
        // exit code 0 = Claude stops (interrupt)
        process.exit(0);
      }

      // Other responses request continuation
      const continuationReason = buildContinuationReason(reply, recentRejection);
      const output: StopHookOutput = {
        continue: true,
        stopReason: '',
        suppressOutput: false,
        decision: 'block',
        reason: continuationReason,
      };
      // Output JSON to stderr (Claude Code parses this)
      console.error(JSON.stringify(output));
      // exit code 2 = continuation request
      process.exit(2);
    } else {
      // No response - just exit
      process.exit(0);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Stop hook error/timeout: ${errorMessage}`);
    // On error, just exit (Claude stops)
    process.exit(0);
  }
}

main();
