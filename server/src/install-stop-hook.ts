#!/usr/bin/env bun
/**
 * Stop Hook 설치 스크립트
 * 
 * 플러그인 방식으로 설치된 Stop hook은 continueInstruction이 동작하지 않는
 * Claude Code 버그(#10412)가 있어서, 직접 ~/.claude/settings.json에 설치합니다.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

interface ClaudeSettings {
  hooks?: {
    Stop?: Array<{
      matcher: string;
      hooks: Array<{
        type: string;
        command: string;
        timeout?: number;
        env?: Record<string, string>;
      }>;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function main() {
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  
  // dm-plz 설치 경로 (이 스크립트 위치 기준)
  const scriptDir = import.meta.dir;
  const dmPlzRoot = resolve(scriptDir, '..');
  const stopHookPath = join(scriptDir, 'stop-hook.ts');
  
  // Windows 경로를 Unix 스타일로 변환 (bun에서 사용)
  const normalizedPath = stopHookPath.replace(/\\/g, '/');
  
  console.log('📍 DM-Plz 위치:', dmPlzRoot);
  console.log('📍 Stop Hook 경로:', normalizedPath);
  
  // ~/.claude 디렉토리 확인
  if (!existsSync(claudeDir)) {
    console.log('📁 ~/.claude 디렉토리 생성 중...');
    mkdirSync(claudeDir, { recursive: true });
  }
  
  // 기존 설정 읽기 또는 빈 객체
  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content);
      console.log('✅ 기존 설정 파일 로드 완료');
    } catch (e) {
      console.error('⚠️ 기존 설정 파일 파싱 실패, 새로 생성합니다');
    }
  }
  
  // hooks 섹션 초기화
  if (!settings.hooks) {
    settings.hooks = {};
  }
  
  // Stop hook 설정
  const stopHookConfig = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `bun run "${normalizedPath}"`,
        timeout: 300000,
        env: {
          DMPLZ_PROVIDER: '${DMPLZ_PROVIDER:-telegram}',
          DMPLZ_TELEGRAM_BOT_TOKEN: '${DMPLZ_TELEGRAM_BOT_TOKEN:-}',
          DMPLZ_TELEGRAM_CHAT_ID: '${DMPLZ_TELEGRAM_CHAT_ID:-}',
          DMPLZ_DISCORD_BOT_TOKEN: '${DMPLZ_DISCORD_BOT_TOKEN:-}',
          DMPLZ_DISCORD_CHANNEL_ID: '${DMPLZ_DISCORD_CHANNEL_ID:-}',
          DMPLZ_DISCORD_DM_USER_ID: '${DMPLZ_DISCORD_DM_USER_ID:-}',
          DMPLZ_PERMISSION_CHAT_ID: '${DMPLZ_PERMISSION_CHAT_ID:-}',
          DMPLZ_QUESTION_TIMEOUT_MS: '${DMPLZ_QUESTION_TIMEOUT_MS:-180000}',
        },
      },
    ],
  };
  
  // 기존 DM-Plz Stop hook이 있는지 확인
  const existingStopHooks = settings.hooks.Stop || [];
  const dmPlzHookIndex = existingStopHooks.findIndex(
    (h) => h.hooks?.some((hook) => hook.command?.includes('stop-hook.ts'))
  );
  
  if (dmPlzHookIndex >= 0) {
    // 기존 hook 업데이트
    existingStopHooks[dmPlzHookIndex] = stopHookConfig;
    console.log('🔄 기존 DM-Plz Stop hook 업데이트');
  } else {
    // 새 hook 추가
    existingStopHooks.push(stopHookConfig);
    console.log('➕ DM-Plz Stop hook 추가');
  }
  
  settings.hooks.Stop = existingStopHooks;
  
  // 설정 저장
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('✅ 설정 저장 완료:', settingsPath);
  
  console.log('\n🎉 Stop Hook 설치 완료!');
  console.log('');
  console.log('📝 참고: 환경 변수가 ~/.claude/settings.json의 env 섹션에 설정되어 있어야 합니다:');
  console.log('  - DMPLZ_PROVIDER');
  console.log('  - DMPLZ_TELEGRAM_BOT_TOKEN (Telegram 사용 시)');
  console.log('  - DMPLZ_TELEGRAM_CHAT_ID (Telegram 사용 시)');
  console.log('  - DMPLZ_DISCORD_BOT_TOKEN (Discord 사용 시)');
  console.log('  - DMPLZ_DISCORD_CHANNEL_ID (Discord 사용 시)');
  console.log('');
  console.log('🔄 Claude Code를 재시작하면 Stop hook이 활성화됩니다.');
}

main();
