/**
 * Integration tests for diagnostic logger with enrollment service.
 * 
 * Proves:
 * - Events emitted at production stages
 * - Secret sentinels absent from logs
 * - Logger errors isolated (don't crash transactions)
 * - Rotation bounded
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { EnrollmentService } from './enrollment-service-production.js';
import { InMemoryWorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { createDiagnosticLogger } from './diagnostic-logger.js';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_LOG_DIR = '/tmp/test-integration-logs';
const TEST_DB_PATH = ':memory:';
const TEST_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const TEST_ACTION = 'test-integration-action';

// Create valid Telegram initData
function createValidInitData(userId: number, botToken: string): string {
  const authDate = Math.floor(Date.now() / 1000);
  const dataCheckString = `auth_date=${authDate}\nuser={"id":${userId},"first_name":"Test"}`;
  
  const crypto = require('node:crypto');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  
  return `auth_date=${authDate}&hash=${hash}&user=%7B%22id%22%3A${userId}%2C%22first_name%22%3A%22Test%22%7D`;
}

// Create mock IDKit result
function createIDKitResult(nonce: string, action: string, signalHash: string) {
  return {
    protocol_version: '4.0' as const,
    nonce,
    action,
    responses: [{
      identifier: 'proof_of_human' as const,
      issuer_schema_id: 1,
      nullifier: '0xtest' + Math.random().toString(16).slice(2),
      expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
      signal_hash: signalHash,
    }],
    environment: 'production' as const,
  };
}

// Mock verification client that always succeeds
class MockVerificationClient {
  async verify(idkitResult: any) {
    return {
      success: true,
      nullifier: idkitResult.responses[0].nullifier,
      issuerSchemaId: 1,
      expiresAtMin: idkitResult.responses[0].expires_at_min,
    };
  }
}

describe('Diagnostic Logger Integration', () => {
  let service: EnrollmentService;
  let logger: ReturnType<typeof createDiagnosticLogger>;

  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }

    // Create logger
    logger = createDiagnosticLogger({
      logDir: TEST_LOG_DIR,
      maxFileSizeBytes: 1024, // 1KB for testing rotation
      maxFiles: 3,
      enabled: true,
    });

    // Create enrollment service with logger
    service = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter: new InMemoryWorldIdChallengeAdapter({
        appId: 'app_test',
        rpId: 'rp_test',
        rpSigningKey: 'a'.repeat(64),
        action: TEST_ACTION,
        environment: 'production',
      }),
      verificationClient: new MockVerificationClient() as any,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
      diagnosticLogger: logger,
    });
  });

  afterEach(() => {
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
  });

  it('emits events at production stages: callback, upstream verify, completion', async () => {
    const userId = 98765;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // Create challenge
    const challenge = await service.createChallenge(initData);

    // Complete enrollment
    const idkitResult = createIDKitResult(
      challenge.signedChallenge.nonce,
      TEST_ACTION,
      challenge.signedChallenge.signalHash
    );
    const result = await service.completeEnrollment({ initData, idkitResult });

    expect(result.success).toBe(true);

    // Read log files
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBeGreaterThan(0);

    const logContent = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const lines = logContent.trim().split('\n').filter(l => l);
    const entries = lines.map(l => JSON.parse(l));

    // Verify callback_received stage
    const callbackEntry = entries.find(e => e.stage === 'callback_received');
    expect(callbackEntry).toBeDefined();
    expect(callbackEntry!.result).toBe('in_progress');
    expect(callbackEntry!.correlationId).toMatch(/^[0-9a-f]{32}$/);

    // Verify upstream_verify_started stage
    const verifyStartEntry = entries.find(e => e.stage === 'upstream_verify_started');
    expect(verifyStartEntry).toBeDefined();

    // Verify upstream_verify_success stage
    const verifySuccessEntry = entries.find(e => e.stage === 'upstream_verify_success');
    expect(verifySuccessEntry).toBeDefined();
    expect(verifySuccessEntry!.result).toBe('success');
    expect(verifySuccessEntry!.durationMs).toBeGreaterThan(0);

    // Verify completion_accepted stage
    const completionEntry = entries.find(e => e.stage === 'completion_accepted');
    expect(completionEntry).toBeDefined();
    expect(completionEntry!.result).toBe('success');

    // All entries should share same correlation ID
    const correlationIds = entries.map(e => e.correlationId);
    const uniqueIds = new Set(correlationIds);
    expect(uniqueIds.size).toBe(1);
  });

  it('proves secret sentinels are absent from logs', async () => {
    const userId = 55555;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // Create challenge
    const challenge = await service.createChallenge(initData);

    // Complete enrollment
    const idkitResult = createIDKitResult(
      challenge.signedChallenge.nonce,
      TEST_ACTION,
      challenge.signedChallenge.signalHash
    );
    await service.completeEnrollment({ initData, idkitResult });

    // Read all log content
    const files = readdirSync(TEST_LOG_DIR);
    const allContent = files.map(f => readFileSync(join(TEST_LOG_DIR, f), 'utf-8')).join('\n');

    // Verify forbidden patterns are absent
    expect(allContent).not.toContain('initData');
    expect(allContent).not.toContain(TEST_BOT_TOKEN);
    expect(allContent).not.toContain('user_id');
    expect(allContent).not.toContain('telegram');
    expect(allContent).not.toContain('signature');
    expect(allContent).not.toContain(challenge.signedChallenge.nonce);
    expect(allContent).not.toContain(challenge.signedChallenge.signature);
    
    // Verify only safe fields present
    expect(allContent).toContain('timestamp');
    expect(allContent).toContain('correlationId');
    expect(allContent).toContain('stage');
    expect(allContent).toContain('result');
  });

  it('logger errors are isolated and do not crash enrollment transaction', async () => {
    // Create logger with invalid directory to trigger errors
    const brokenLogger = createDiagnosticLogger({
      logDir: '/nonexistent/invalid/path',
      enabled: true,
    });

    // Create service with broken logger
    const serviceWithBrokenLogger = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter: new InMemoryWorldIdChallengeAdapter({
        appId: 'app_test',
        rpId: 'rp_test',
        rpSigningKey: 'b'.repeat(64),
        action: TEST_ACTION,
        environment: 'production',
      }),
      verificationClient: new MockVerificationClient() as any,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
      diagnosticLogger: brokenLogger,
    });

    const userId = 11111;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // Create challenge
    const challenge = await serviceWithBrokenLogger.createChallenge(initData);

    // Complete enrollment - should succeed despite logger failure
    const idkitResult = createIDKitResult(
      challenge.signedChallenge.nonce,
      TEST_ACTION,
      challenge.signedChallenge.signalHash
    );
    const result = await serviceWithBrokenLogger.completeEnrollment({ initData, idkitResult });

    // Enrollment must succeed even though logging failed
    expect(result.success).toBe(true);
    expect(result.telegramUserId).toBe(userId);
  });

  it('rotation is bounded by maxFiles limit', async () => {
    // Create many enrollment attempts to trigger rotation
    for (let i = 0; i < 50; i++) {
      const userId = 20000 + i;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      const challenge = await service.createChallenge(initData);
      const idkitResult = createIDKitResult(
        challenge.signedChallenge.nonce,
        TEST_ACTION,
        challenge.signedChallenge.signalHash
      );
      await service.completeEnrollment({ initData, idkitResult });
    }

    // Check that file count is bounded by maxFiles
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBeLessThanOrEqual(3); // maxFiles = 3
  });

  it('logs upstream verification failure with sanitized error', async () => {
    // Create service with failing verifier
    class FailingVerificationClient {
      async verify() {
        throw new Error('Network timeout with secret_token=abc123');
      }
    }

    const failingService = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter: new InMemoryWorldIdChallengeAdapter({
        appId: 'app_test',
        rpId: 'rp_test',
        rpSigningKey: 'c'.repeat(64),
        action: TEST_ACTION,
        environment: 'production',
      }),
      verificationClient: new FailingVerificationClient() as any,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
      diagnosticLogger: logger,
    });

    const userId = 33333;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);
    const challenge = await failingService.createChallenge(initData);
    const idkitResult = createIDKitResult(
      challenge.signedChallenge.nonce,
      TEST_ACTION,
      challenge.signedChallenge.signalHash
    );

    const result = await failingService.completeEnrollment({ initData, idkitResult });
    expect(result.success).toBe(false);

    // Read logs
    const files = readdirSync(TEST_LOG_DIR);
    const logContent = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');

    // Verify upstream_verify_failed is logged
    expect(logContent).toContain('upstream_verify_failed');
    expect(logContent).toContain('failure');

    // Verify secret token is NOT in logs
    expect(logContent).not.toContain('secret_token');
    expect(logContent).not.toContain('abc123');

    // Verify safe error category is present
    expect(logContent).toContain('errorCategory');
    expect(logContent).toMatch(/timeout_error|network_error|unknown_error/);
  });

  it('service works correctly without logger (optional dependency)', async () => {
    // Create service without logger
    const serviceWithoutLogger = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter: new InMemoryWorldIdChallengeAdapter({
        appId: 'app_test',
        rpId: 'rp_test',
        rpSigningKey: 'd'.repeat(64),
        action: TEST_ACTION,
        environment: 'production',
      }),
      verificationClient: new MockVerificationClient() as any,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
      // diagnosticLogger: undefined (omitted)
    });

    const userId = 44444;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);
    const challenge = await serviceWithoutLogger.createChallenge(initData);
    const idkitResult = createIDKitResult(
      challenge.signedChallenge.nonce,
      TEST_ACTION,
      challenge.signedChallenge.signalHash
    );

    // Should succeed without logger
    const result = await serviceWithoutLogger.completeEnrollment({ initData, idkitResult });
    expect(result.success).toBe(true);
  });
});
