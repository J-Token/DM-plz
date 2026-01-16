#!/usr/bin/env bun
/**
 * Stop Hook Installation Script
 *
 * Stop hook installed via the plugin has a non-working continueInstruction due to
 * a Claude Code bug (#10412), so this script installs it directly into ~/.claude/settings.json.
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
  
  // dm-plz install path (relative to this script)
  const scriptDir = import.meta.dir;
  const dmPlzRoot = resolve(scriptDir, '..');
  const stopHookPath = join(scriptDir, 'stop-hook.ts');
  
  // Convert Windows path to Unix style (for bun)
  const normalizedPath = stopHookPath.replace(/\\/g, '/');
  
  console.log('📍 DM-Plz location:', dmPlzRoot);
  console.log('📍 Stop Hook path:', normalizedPath);

  
  // Check ~/.claude directory
  if (!existsSync(claudeDir)) {
  console.log('📁 Creating ~/.claude directory...');

    mkdirSync(claudeDir, { recursive: true });
  }
  
  // Read existing settings or start with an empty object
  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content);
      console.log('✅ Loaded existing settings file');

    } catch (e) {
      console.error('⚠️ Failed to parse settings file; creating a new one');

    }
  }
  
  // Initialize hooks section
  if (!settings.hooks) {
    settings.hooks = {};
  }
  
  // Stop hook configuration
  // Note: env section is omitted intentionally - hooks inherit from root-level env in settings.json
  const stopHookConfig = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `bun run "${normalizedPath}"`,
        timeout: 300000,
      },
    ],
  };
  
  // Check whether a DM-Plz Stop hook already exists
  const existingStopHooks = settings.hooks.Stop || [];
  const dmPlzHookIndex = existingStopHooks.findIndex(
    (h) => h.hooks?.some((hook) => hook.command?.includes('stop-hook.ts'))
  );
  
  if (dmPlzHookIndex >= 0) {
    // Update existing hook
    existingStopHooks[dmPlzHookIndex] = stopHookConfig;
    console.log('🔄 Updated existing DM-Plz Stop hook');

  } else {
    // Add new hook
    existingStopHooks.push(stopHookConfig);
    console.log('➕ Added DM-Plz Stop hook');

  }
  
  settings.hooks.Stop = existingStopHooks;
  
  // Save settings
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('✅ Saved settings:', settingsPath);

  
  console.log('\n🎉 Stop Hook installation complete!');

  console.log('');
  console.log('📝 Note: env vars must be set in ~/.claude/settings.json under the env section:');

  console.log('  - DMPLZ_PROVIDER');
  console.log('  - DMPLZ_TELEGRAM_BOT_TOKEN (for Telegram)');
  console.log('  - DMPLZ_TELEGRAM_CHAT_ID (for Telegram)');
  console.log('  - DMPLZ_DISCORD_BOT_TOKEN (for Discord)');
  console.log('  - DMPLZ_DISCORD_CHANNEL_ID (for Discord)');

  console.log('');
  console.log('🔄 Restart Claude Code to activate the Stop hook.');

}

main();
