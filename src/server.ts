#!/usr/bin/env node
/**
 * Production enrollment service entrypoint.
 *
 * Runnable composition with localhost binding, ephemeral DB, throwaway keys.
 * No live World/Telegram calls without proper configuration.
 */

import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import { HttpService } from './http-service.js';
import { TelegramBotHandler, TelegramHttpTransport } from './telegram-bot-handler.js';

// Configuration from environment (with unconfigured defaults for local testing)
const config = {
  // World ID configuration (REQUIRED in production)
  worldIdAppId: (process.env.WORLDID_APP_ID || 'app_unconfigured_testing_only') as `app_${string}`,
  worldIdRpId: (process.env.WORLDID_RP_ID || 'rp_unconfigured_test') as `rp_${string}`,
  worldIdSigningKey: process.env.WORLDID_SIGNING_KEY_HEX || '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  worldIdEnvironment: (process.env.WORLDID_ENVIRONMENT || 'staging') as 'production' | 'staging',
  
  // Telegram configuration (REQUIRED in production)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || 'unconfigured_test_token',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || 'unconfigured_test_webhook_secret',
  enrollmentBaseUrl: process.env.ENROLLMENT_BASE_URL || 'http://127.0.0.1:3000',
  
  // Service configuration
  action: process.env.WORLDID_ACTION || 'unconfigured-test-action',
  databasePath: process.env.DATABASE_PATH || '/tmp/enrollment.db',
  
  // HTTP configuration
  httpHost: process.env.HTTP_HOST || '127.0.0.1',
  httpPort: parseInt(process.env.HTTP_PORT || '3000', 10),
  
  // OpenClaw integration (OPTIONAL)
  openclawEnabled: process.env.OPENCLAW_ENABLED === 'true',
  openclawBin: process.env.OPENCLAW_BIN || '/usr/local/bin/openclaw',
  openclawAgent: process.env.OPENCLAW_AGENT || '',
  openclawProfile: process.env.OPENCLAW_PROFILE,
  openclawTimeout: parseInt(process.env.OPENCLAW_TIMEOUT || '30', 10),
  openclawAllowedGroupId: process.env.OPENCLAW_ALLOWED_GROUP ? parseInt(process.env.OPENCLAW_ALLOWED_GROUP, 10) : undefined,
  openclawAccountId: process.env.OPENCLAW_ACCOUNT_ID || 'default',
};

// Production readiness check (fail-closed)
function checkProductionReadiness(): { ready: boolean; issues: string[] } {
  const issues: string[] = [];

  if (config.worldIdAppId === 'app_unconfigured_testing_only') {
    issues.push('WORLDID_APP_ID not configured');
  }

  if (config.worldIdRpId === 'rp_unconfigured_test') {
    issues.push('WORLDID_RP_ID not configured');
  }

  if (config.worldIdSigningKey === '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef') {
    issues.push('WORLDID_SIGNING_KEY_HEX not configured (throwaway test key)');
  }

  if (config.telegramBotToken === 'unconfigured_test_token') {
    issues.push('TELEGRAM_BOT_TOKEN not configured');
  }

  if (config.telegramWebhookSecret === 'unconfigured_test_webhook_secret') {
    issues.push('TELEGRAM_WEBHOOK_SECRET not configured (REQUIRED for webhook security)');
  }

  if (config.action === 'unconfigured-test-action') {
    issues.push('WORLDID_ACTION not configured');
  }

  const ready = issues.length === 0;

  return { ready, issues };
}

let serviceReady = false;

function getServiceStatus(): { status: 'healthy' | 'starting' | 'not_ready'; ready: boolean; issues?: string[] } {
  if (serviceReady) {
    return { status: 'healthy', ready: true };
  }

  const { ready, issues } = checkProductionReadiness();
  
  if (!ready) {
    return { status: 'not_ready', ready: false, issues };
  }

  return { status: 'starting', ready: false };
}

async function main(): Promise<void> {
  const { ready, issues } = checkProductionReadiness();

  if (!ready) {
    console.error('FATAL: Service cannot start with unconfigured secrets');
    console.error('');
    console.error('Missing required configuration:');
    issues.forEach(issue => console.error(`  - ${issue}`));
    console.error('');
    console.error('Set environment variables:');
    console.error('  WORLDID_APP_ID, WORLDID_RP_ID, WORLDID_SIGNING_KEY_HEX,');
    console.error('  TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,');
    console.error('  WORLDID_ACTION, ENROLLMENT_BASE_URL');
    console.error('');
    console.error('This service CANNOT grant enrollment without proper World ID configuration.');
    console.error('Refusing to start in unsafe configuration.');
    process.exit(1);
  }

  console.log('Starting enrollment service...');
  console.log(`Database: ${config.databasePath}`);
  console.log(`Action scope: ${config.action}`);
  console.log(`Environment: ${config.worldIdEnvironment}`);
  console.log('');

  // Create challenge adapter
  const challengeAdapter = new WorldIdChallengeAdapter({
    appId: config.worldIdAppId,
    rpId: config.worldIdRpId,
    signingKeyHex: config.worldIdSigningKey,
    challengeTtlSeconds: 300,
    environment: config.worldIdEnvironment,
  });

  // Create HTTP verifier
  const verifier = new WorldIdHttpVerifier({
    appId: config.worldIdAppId,
    rpId: config.worldIdRpId,
    environment: config.worldIdEnvironment,
    timeoutMs: 10000,
  });

  // Create enrollment service
  const enrollmentService = new EnrollmentService({
    dbPath: config.databasePath,
    challengeAdapter,
    verificationClient: verifier,
    telegramBotToken: config.telegramBotToken,
    action: config.action,
    challengeTtlSeconds: 300,
    enrollmentTtlSeconds: 2592000, // 30 days
  });

  // Create Telegram bot handler
  const telegramTransport = new TelegramHttpTransport(config.telegramBotToken);
  
  // Build OpenClaw config if enabled
  let openclawConfig;
  if (config.openclawEnabled) {
    if (!config.openclawAgent) {
      console.error('FATAL: OPENCLAW_AGENT required when OPENCLAW_ENABLED=true');
      process.exit(1);
    }
    if (!config.openclawAllowedGroupId) {
      console.error('FATAL: OPENCLAW_ALLOWED_GROUP required when OPENCLAW_ENABLED=true');
      process.exit(1);
    }
    if (!config.openclawProfile) {
      console.error('FATAL: OPENCLAW_PROFILE required when OPENCLAW_ENABLED=true (dedicated isolated profile)');
      process.exit(1);
    }
    if (config.openclawTimeout < 1 || config.openclawTimeout > 600) {
      console.error('FATAL: OPENCLAW_TIMEOUT must be between 1 and 600 seconds');
      process.exit(1);
    }
    
    openclawConfig = {
      openclawBin: config.openclawBin,
      agentId: config.openclawAgent,
      telegramAccountId: config.openclawAccountId,
      timeoutSeconds: config.openclawTimeout,
      maxOutputBytes: 1024 * 1024, // 1MB
      profile: config.openclawProfile,
    };
    
    console.log('OpenClaw integration enabled:');
    console.log(`  Agent: ${config.openclawAgent}`);
    console.log(`  Allowed group: ${config.openclawAllowedGroupId}`);
    console.log(`  Profile: ${config.openclawProfile}`);
  }
  
  const telegramBotHandler = new TelegramBotHandler({
    botToken: config.telegramBotToken,
    enrollmentService,
    transport: telegramTransport,
    enrollmentBaseUrl: config.enrollmentBaseUrl,
    webhookSecret: config.telegramWebhookSecret,
    openclawConfig,
    allowedGroupId: config.openclawAllowedGroupId,
  });

  // Create HTTP service with bot handler
  const httpService = new HttpService({
    enrollmentService,
    telegramBotHandler,
    port: config.httpPort,
    host: config.httpHost,
    bodyLimit: '1mb',
    requestTimeoutMs: 30000,
  });

  // Start server
  await httpService.start();

  // Mark service as ready after successful startup
  serviceReady = true;
  console.log('Service ready: All configuration validated, accepting requests');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('');
    console.log('Shutting down...');
    serviceReady = false;
    await httpService.stop();
    enrollmentService.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main };
