#!/usr/bin/env bun

/**
 * Test script for DM-Plz
 *
 * Run this script to test your configuration before using the plugin with Claude Code.
 *
 * Usage:
 *   bun run test.ts
 */

import { createProvider } from './src/providers/index.js';
import type { ServerConfig } from './src/types.js';

/**
 * 테스트 실행 엔트리 포인트입니다.
 */
async function main() {
  console.log('🧪 DM-Plz Configuration Test\n');

  // Load configuration
  const provider = (process.env.DMPLZ_PROVIDER || 'telegram') as 'telegram' | 'discord';
  console.log(`Provider: ${provider}`);

  let botToken: string | undefined;
  let chatId: string | undefined;

  if (provider === 'telegram') {
    botToken = process.env.DMPLZ_TELEGRAM_BOT_TOKEN;
    chatId = process.env.DMPLZ_TELEGRAM_CHAT_ID;

    if (!botToken) {
      console.error('❌ Error: DMPLZ_TELEGRAM_BOT_TOKEN is not set');
      console.log('\nSet it with:');
      console.log('  export DMPLZ_TELEGRAM_BOT_TOKEN="your_token"');
      process.exit(1);
    }

    if (!chatId) {
      console.error('❌ Error: DMPLZ_TELEGRAM_CHAT_ID is not set');
      console.log('\nSet it with:');
      console.log('  export DMPLZ_TELEGRAM_CHAT_ID="your_chat_id"');
      process.exit(1);
    }
  } else if (provider === 'discord') {
    botToken = process.env.DMPLZ_DISCORD_BOT_TOKEN;
    chatId = process.env.DMPLZ_DISCORD_CHANNEL_ID;

    if (!botToken) {
      console.error('❌ Error: DMPLZ_DISCORD_BOT_TOKEN is not set');
      console.log('\nSet it with:');
      console.log('  export DMPLZ_DISCORD_BOT_TOKEN="your_token"');
      process.exit(1);
    }

    if (!chatId) {
      console.error('❌ Error: DMPLZ_DISCORD_CHANNEL_ID is not set');
      console.log('\nSet it with:');
      console.log('  export DMPLZ_DISCORD_CHANNEL_ID="your_channel_id"');
      process.exit(1);
    }
  }

  const config: ServerConfig = {
    provider,
    botToken,
    chatId,
    questionTimeoutMs: 10800000,
  };

  console.log(`Chat/Channel ID: ${chatId}\n`);

  // Test connection
  console.log('Testing connection...');
  try {
    const messagingProvider = createProvider(config);
    const info = await messagingProvider.getInfo();
    console.log(`✅ Connected: ${info.name}`);
    console.log(`   Identifier: ${info.identifier}\n`);
  } catch (error) {
    console.error('❌ Connection failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Send test message
  console.log('Sending test message...');
  try {
    const messagingProvider = createProvider(config);
    await messagingProvider.sendMessage(
      '🧪 **DM-Plz Test Message**\n\nIf you can see this, your configuration is working correctly!',
      'Markdown'
    );
    console.log('✅ Test message sent successfully!\n');
  } catch (error) {
    console.error('❌ Failed to send message:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  console.log('✨ All tests passed! Your configuration is ready to use.');
  console.log('\nNext steps:');
  console.log('1. Add the same environment variables to ~/.claude/settings.json');
  console.log('2. Install the plugin in Claude Code');
  console.log('3. Start using DM-Plz with Claude!\n');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
