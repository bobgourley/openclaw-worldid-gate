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

// Configuration from environment (with unconfigured defaults for local testing)
const config = {
  // World ID configuration (REQUIRED in production)
  worldIdAppId: (process.env.WORLDID_APP_ID || 'app_unconfigured_testing_only') as `app_${string}`,
  worldIdRpId: (process.env.WORLDID_RP_ID || 'rp_unconfigured_test') as `rp_${string}`,
  worldIdSigningKey: process.env.WORLDID_SIGNING_KEY_HEX || '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  worldIdEnvironment: (process.env.WORLDID_ENVIRONMENT || 'staging') as 'production' | 'staging',
  
  // Telegram configuration (REQUIRED in production)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || 'unconfigured_test_token',
  
  // Service configuration
  action: process.env.WORLDID_ACTION || 'unconfigured-test-action',
  databasePath: process.env.DATABASE_PATH || '/tmp/enrollment.db',
  
  // HTTP configuration
  httpHost: process.env.HTTP_HOST || '127.0.0.1',
  httpPort: parseInt(process.env.HTTP_PORT || '3000', 10),
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
    console.error('  TELEGRAM_BOT_TOKEN, WORLDID_ACTION');
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

  // Create HTTP service
  const httpService = new HttpService({
    enrollmentService,
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
