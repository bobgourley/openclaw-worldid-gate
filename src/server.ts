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
import { createDiagnosticLogger } from './diagnostic-logger.js';
import { StatusSocketServer, loadStatusSecret } from './status-socket-server.js';
import { MemberTagManager } from './member-tag-manager.js';
import { TelegramApiClient } from './telegram-api-client.js';
import { openclawIntegrationConfig } from './config.js';

// Configuration from environment (with unconfigured defaults for local testing)
const config = {
  // World ID configuration (REQUIRED in production)
  worldIdAppId: (process.env.WORLDID_APP_ID || 'app_unconfigured_testing_only') as `app_${string}`,
  worldIdRpId: (process.env.WORLDID_RP_ID || 'rp_unconfigured_test') as `rp_${string}`,
  worldIdSigningKey: process.env.WORLDID_SIGNING_KEY_HEX || '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  worldIdEnvironment: (process.env.WORLDID_ENVIRONMENT || 'staging') as 'production' | 'staging',
  
  // Telegram configuration (REQUIRED in production)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || 'unconfigured_test_token',
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || 'unconfigured_test_webhook_secret',
  enrollmentBaseUrl: process.env.ENROLLMENT_BASE_URL || 'http://127.0.0.1:3000',
  
  // Service configuration
  action: process.env.WORLDID_ACTION || 'unconfigured-test-action',
  databasePath: process.env.DATABASE_PATH || '/tmp/enrollment.db',
  enrollmentTtlDays: process.env.WORLDID_ENROLLMENT_TTL_DAYS ? parseInt(process.env.WORLDID_ENROLLMENT_TTL_DAYS, 10) : 5,
  
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
  
  // Diagnostic logging (OPTIONAL)
  // Note: Default path assumes deployment user has dedicated log directory
  // DIAGNOSTIC_LOG_DIR must be set explicitly for production use
  diagnosticLogEnabled: process.env.DIAGNOSTIC_LOG_ENABLED === 'true',
  diagnosticLogDir: process.env.DIAGNOSTIC_LOG_DIR || '',  // No default, must be explicit
};

// Validate enrollment TTL (fail-closed: exit on invalid values)
function validateEnrollmentTtl(): void {
  const rawValue = process.env.WORLDID_ENROLLMENT_TTL_DAYS;
  
  // Strict format validation: must be digits only, no empty strings
  if (rawValue !== undefined && (rawValue === '' || !/^\d+$/.test(rawValue))) {
    console.error('FATAL: WORLDID_ENROLLMENT_TTL_DAYS must contain only digits, got:', rawValue);
    process.exit(1);
  }
  
  const ttlDays = config.enrollmentTtlDays;
  
  if (!Number.isFinite(ttlDays) || isNaN(ttlDays)) {
    console.error('FATAL: WORLDID_ENROLLMENT_TTL_DAYS must be a finite number, got:', rawValue);
    process.exit(1);
  }
  
  if (!Number.isSafeInteger(ttlDays)) {
    console.error('FATAL: WORLDID_ENROLLMENT_TTL_DAYS must be a safe integer, got:', ttlDays);
    process.exit(1);
  }
  
  if (ttlDays < 1 || ttlDays > 365) {
    console.error(`FATAL: WORLDID_ENROLLMENT_TTL_DAYS must be between 1 and 365 days, got: ${ttlDays}`);
    process.exit(1);
  }
  
  console.log(`Enrollment TTL: ${ttlDays} days (${ttlDays * 86400} seconds)`);
}

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

  // Validate enrollment TTL (fail-closed)
  validateEnrollmentTtl();

  console.log('Starting enrollment service...');
  console.log(`Database: ${config.databasePath}`);
  console.log(`Action scope: ${config.action}`);
  console.log(`Environment: ${config.worldIdEnvironment}`);
  console.log(`Diagnostic Logging: ${config.diagnosticLogEnabled ? 'enabled' : 'disabled'}`);
  if (config.diagnosticLogEnabled) {
    console.log(`  Log directory: ${config.diagnosticLogDir}`);
  }
  console.log('');

  // Create diagnostic logger with startup validation
  // ENABLED PATH: Server exits if DIAGNOSTIC_LOG_DIR unset or unsafe
  // DISABLED PATH: Logger disables diagnostics, service continues
  if (config.diagnosticLogEnabled) {
    if (!config.diagnosticLogDir) {
      console.error('DIAGNOSTIC_LOG_ENABLED=true requires DIAGNOSTIC_LOG_DIR to be set');
      console.error('Example: DIAGNOSTIC_LOG_DIR=/Users/finn/worldid-gate-runtime/private/diagnostics');
      process.exit(1);
    }
  }
  
  const diagnosticLogger = createDiagnosticLogger({
    logDir: config.diagnosticLogDir,
    maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
    maxFiles: 10,
    enabled: config.diagnosticLogEnabled,
  });
  
  // If logger initialization failed (unsafe path), behavior depends on enabled flag
  // ENABLED PATH: Already validated above, createDiagnosticLogger throws if path unsafe
  // DISABLED PATH: Logger internally disables, service continues (initFailed=true)

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

  // Create member tag managers (one per group if enabled)
  const memberTagManagers: MemberTagManager[] = [];
  let telegramApiClient: TelegramApiClient | undefined;
  if (openclawIntegrationConfig.memberTags.enabled) {
    if (!config.openclawAllowedGroupId) {
      console.error('FATAL: OPENCLAW_ALLOWED_GROUP required when member tags enabled');
      process.exit(1);
    }
    
    telegramApiClient = new TelegramApiClient({
      botToken: config.telegramBotToken,
    });
    
    console.log('Member tags enabled:');
    console.log(`  Tag text: ${openclawIntegrationConfig.memberTags.tagText}`);
    console.log(`  Target groups: ${openclawIntegrationConfig.memberTags.targetChatIds.length}`);
    console.log(`  Sweep interval: ${openclawIntegrationConfig.memberTags.sweepIntervalHours}h`);
  }

  // Create enrollment service
  const enrollmentTtlSeconds = config.enrollmentTtlDays * 86400;
  const enrollmentService = new EnrollmentService({
    dbPath: config.databasePath,
    challengeAdapter,
    verificationClient: verifier,
    telegramBotToken: config.telegramBotToken,
    action: config.action,
    challengeTtlSeconds: 300,
    enrollmentTtlSeconds: enrollmentTtlSeconds,
    diagnosticLogger,
  });

  // Wire member tag managers after enrollment service is created
  if (openclawIntegrationConfig.memberTags.enabled && telegramApiClient) {
    for (const targetChatId of openclawIntegrationConfig.memberTags.targetChatIds) {
      const manager = new MemberTagManager({
        telegramClient: telegramApiClient,
        enrollmentService,
        db: (enrollmentService as any).db, // Access private db field
        targetChatId: targetChatId,
        tagText: openclawIntegrationConfig.memberTags.tagText,
        action: config.action,
        enabled: true, // Initially enabled, will be disabled by sweeper if permission check fails
        sweepIntervalHours: openclawIntegrationConfig.memberTags.sweepIntervalHours,
      });
      
      memberTagManagers.push(manager);
      
      // Always start sweeper (it will re-check permissions and enable itself when granted)
      console.log(`[MemberTag] Starting sweeper for group (interval: ${openclawIntegrationConfig.memberTags.sweepIntervalHours}h)`);
      manager.startSweeper();
    }
    
    // Attach managers to enrollment service
    (enrollmentService as any).memberTagManagers = memberTagManagers;
  }

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
    console.log(`  Allowed group: <configured>`);
    console.log(`  Profile: ${config.openclawProfile}`);
  }
  
  // Build known group IDs (all tag groups + allowed group)
  const knownGroupIds: number[] = [];
  if (openclawIntegrationConfig.memberTags.enabled) {
    for (const chatIdStr of openclawIntegrationConfig.memberTags.targetChatIds) {
      const chatId = parseInt(chatIdStr, 10);
      if (!isNaN(chatId)) {
        knownGroupIds.push(chatId);
      }
    }
  }
  
  const telegramBotHandler = new TelegramBotHandler({
    botToken: config.telegramBotToken,
    botUsername: config.telegramBotUsername,
    enrollmentService,
    transport: telegramTransport,
    enrollmentBaseUrl: config.enrollmentBaseUrl,
    webhookSecret: config.telegramWebhookSecret,
    openclawConfig,
    allowedGroupId: config.openclawAllowedGroupId,
    knownGroupIds,
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

  // Create and start status socket server (if enabled)
  let statusSocketServer: StatusSocketServer | undefined;
  if (openclawIntegrationConfig.statusSocket.enabled) {
    try {
      const secret = await loadStatusSecret(openclawIntegrationConfig.statusSocket.secretFile);
      
      statusSocketServer = new StatusSocketServer({
        socketPath: openclawIntegrationConfig.statusSocket.socketPath,
        secret,
        enrollmentService,
      });
      
      await statusSocketServer.start();
    } catch (error: any) {
      console.error('FATAL: Failed to start status socket server:', error.message);
      process.exit(1);
    }
  }

  // Start HTTP server
  await httpService.start();

  // Register command menu (private chats only, invisible in groups)
  try {
    await telegramBotHandler.registerCommandMenu();
  } catch (error) {
    console.error('[CommandMenu] Failed to register command menu (non-fatal)');
  }

  // Mark service as ready after successful startup
  serviceReady = true;
  console.log('Service ready: All configuration validated, accepting requests');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('');
    console.log('Shutting down...');
    serviceReady = false;
    
    // Stop member tag sweepers
    for (const manager of memberTagManagers) {
      manager.stopSweeper();
    }
    
    // Stop status socket server
    if (statusSocketServer) {
      await statusSocketServer.stop();
    }
    
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
