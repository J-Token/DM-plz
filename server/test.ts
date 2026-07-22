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
 * Test entrypoint.
 */
async function main() {
  console.log('🧪 DM-Plz Configuration Test\n');

  // Load configuration
  const telegramConfigured = !!(
    process.env.DMPLZ_TELEGRAM_BOT_TOKEN && process.env.DMPLZ_TELEGRAM_CHAT_ID
  );
  const discordConfigured = !!(
    process.env.DMPLZ_DISCORD_BOT_TOKEN && process.env.DMPLZ_DISCORD_CHANNEL_ID
  );

  const defaultProvider = telegramConfigured ? 'telegram' : discordConfigured ? 'discord' : 'telegram';
  const provider = (process.env.DMPLZ_PROVIDER || defaultProvider) as 'telegram' | 'discord';
  console.log(`Provider: ${provider}`);

  // Skip rather than fail when nothing is configured, so the test is safe to
  // run in a fresh checkout.
  if (
    (provider === 'telegram' && !telegramConfigured) ||
    (provider === 'discord' && !discordConfigured)
  ) {
    console.log('⏭️ Skipped: provider credentials are not set.');
    return;
  }

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
    botToken: botToken!,
    chatId: chatId!,
    questionTimeoutMs: 10800000,
    rejectReasonTimeoutMs: 600000,
    rejectReasonMaxChars: 300,
    rejectReasonLogPath: '',
    rejectReasonLogRotateBytes: 10485760,
    rejectReasonLogMaxFiles: 10,
    rejectReasonNoReasonKeywords: ['no_reason'],
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

  // Send test attachment.
  // Point DMPLZ_TEST_MEDIA_PATH at a real .mp4 to exercise duration-based
  // routing and inline playback; without it only the document path is covered.
  const mediaPath = process.env.DMPLZ_TEST_MEDIA_PATH || import.meta.path;
  const isRealMedia = mediaPath !== import.meta.path;

  console.log('Sending test attachment...');
  console.log(`   File: ${mediaPath}`);
  if (!isRealMedia) {
    console.log('   ⚠️ Falling back to this script. Video routing stays untested.');
    console.log('   Set DMPLZ_TEST_MEDIA_PATH to an .mp4 to cover it.');
  }

  const mediaResult = await createProvider(config).sendMedia(mediaPath, {
    caption: '🧪 DM-Plz media attachment test',
  });

  if ('error' in mediaResult) {
    console.error('❌ Failed to send attachment:', JSON.stringify(mediaResult.error));
    process.exit(1);
  }
  console.log(`✅ Attachment sent successfully (message ${mediaResult.messageId})!\n`);

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
