/**
 * Production enrollment service tests with real composition.
 *
 * Tests actual production service with SDK adapter, validators, and SQLite.
 * No live World/Telegram calls - only external API transport mocked.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  EnrollmentService,
  SystemClock,
  type Clock,
  type BackendVerificationClient,
} from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import type {
  IDKitResult,
  BackendVerificationResult,
  ExpectedVerificationContext,
} from './worldid-types.js';

// Throwaway test keys
const TEST_SIGNING_KEY = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_APP_ID = 'app_test1234567890abcdef1234567890';
const TEST_RP_ID = 'rp_test1234567890ab';
const TEST_BOT_TOKEN = 'test_bot_12345';
const TEST_ACTION = 'test-verification';

// Fake clock for deterministic testing
class FakeClock implements Clock {
  private currentSeconds: number;

  constructor(initialSeconds: number = Math.floor(Date.now() / 1000)) {
    this.currentSeconds = initialSeconds;
  }

  nowSeconds(): number {
    return this.currentSeconds;
  }

  nowISO(): string {
    return new Date(this.currentSeconds * 1000).toISOString();
  }

  advance(seconds: number): void {
    this.currentSeconds += seconds;
  }
}

// Mock verification client
class MockVerificationClient implements BackendVerificationClient {
  private responses: Map<string, BackendVerificationResult> = new Map();
  public lastRequest: { idkitResult?: IDKitResult; expectedContext?: ExpectedVerificationContext } = {};

  setResponse(nonce: string, result: BackendVerificationResult): void {
    this.responses.set(nonce, result);
  }

  async verify(
    idkitResult: IDKitResult,
    expectedContext: ExpectedVerificationContext
  ): Promise<BackendVerificationResult> {
    this.lastRequest = { idkitResult, expectedContext };

    const response = this.responses.get(idkitResult.nonce);
    if (response) {
      return response;
    }

    // Default success
    return {
      success: true,
      nullifier: '12345678901234567890',
      issuerSchemaId: 1,
      expiresAtMin: Math.floor(Date.now() / 1000) + 86400,
    };
  }
}

// Generate valid Telegram initData with HMAC
function createValidInitData(userId: number, botToken: string): string {
  const user = JSON.stringify({ id: userId, first_name: 'Test', username: 'testuser' });
  const authDate = Math.floor(Date.now() / 1000);

  const params: Record<string, string> = {
    user: user,
    auth_date: String(authDate),
  };

  const dataCheckString = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return `user=${encodeURIComponent(user)}&auth_date=${authDate}&hash=${hash}`;
}

// Create IDKitResult (real SDK structure)
function createIDKitResult(nonce: string, action: string, signalHash: string): IDKitResult {
  return {
    protocol_version: '4.0',
    nonce,
    action,
    responses: [
      {
        identifier: 'proof_of_human',
        signal_hash: signalHash,
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '12345678901234567890',
        issuer_schema_id: 1,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      },
    ],
    environment: 'staging',
  };
}

describe('EnrollmentService Production', () => {
  let service: EnrollmentService;
  let adapter: WorldIdChallengeAdapter;
  let mockClient: MockVerificationClient;
  let fakeClock: FakeClock;
  const testDbPath = '/tmp/test-enrollment-prod.db';

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      challengeTtlSeconds: 300,
      environment: 'staging',
    });

    mockClient = new MockVerificationClient();
    fakeClock = new FakeClock();

    service = new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter: adapter,
      verificationClient: mockClient,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
      challengeTtlSeconds: 300,
      enrollmentTtlSeconds: 2592000,
      clock: fakeClock,
    });
  });

  afterEach(() => {
    service.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('constructor validation', () => {
    it('validates TTL bounds - challenge too low', () => {
      assert.throws(
        () => {
          new EnrollmentService({
            dbPath: testDbPath + '.bounds',
            challengeAdapter: adapter,
            verificationClient: mockClient,
            telegramBotToken: TEST_BOT_TOKEN,
            action: TEST_ACTION,
            challengeTtlSeconds: 59, // Below 60
          });
        },
        /invalid challengeTtlSeconds/i
      );
    });

    it('validates TTL bounds - challenge too high', () => {
      assert.throws(
        () => {
          new EnrollmentService({
            dbPath: testDbPath + '.bounds',
            challengeAdapter: adapter,
            verificationClient: mockClient,
            telegramBotToken: TEST_BOT_TOKEN,
            action: TEST_ACTION,
            challengeTtlSeconds: 3601, // Above 3600
          });
        },
        /invalid challengeTtlSeconds/i
      );
    });

    it('validates TTL bounds - enrollment too low', () => {
      assert.throws(
        () => {
          new EnrollmentService({
            dbPath: testDbPath + '.bounds',
            challengeAdapter: adapter,
            verificationClient: mockClient,
            telegramBotToken: TEST_BOT_TOKEN,
            action: TEST_ACTION,
            enrollmentTtlSeconds: 86399, // Below 86400
          });
        },
        /invalid enrollmentTtlSeconds/i
      );
    });

    it('rejects per-user action scope', () => {
      assert.throws(
        () => {
          new EnrollmentService({
            dbPath: testDbPath + '.scope',
            challengeAdapter: adapter,
            verificationClient: mockClient,
            telegramBotToken: TEST_BOT_TOKEN,
            action: 'enroll-user-{userId}',
          });
        },
        /stable service scope/i
      );
    });
  });

  describe('createChallenge with initData authentication', () => {
    it('creates challenge after authenticating initData', async () => {
      const userId = 12345;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      const result = await service.createChallenge(initData);

      assert.ok(result.signedChallenge);
      assert.equal(result.signedChallenge.action, TEST_ACTION);
      assert.match(result.signedChallenge.nonce, /^0x[0-9a-f]{64}$/);
      assert.match(result.signedChallenge.signalHash, /^0x[0-9a-f]{64}$/);
    });

    it('rejects invalid initData HMAC', async () => {
      const initData = 'user=%7B%22id%22%3A12345%7D&auth_date=1234567890&hash=invalid';

      await assert.rejects(
        async () => {
          await service.createChallenge(initData);
        },
        /initData validation failed/i
      );
    });

    it('denies duplicate active enrollment per account', async () => {
      const userId = 12345;
      const nullifier = '12345678901234567890';
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      // First enrollment
      const challenge1 = await service.createChallenge(initData);
      mockClient.setResponse(challenge1.signedChallenge.nonce, {
        success: true,
        nullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });
      await service.completeEnrollment({
        initData,
        idkitResult: createIDKitResult(challenge1.signedChallenge.nonce, TEST_ACTION, challenge1.signedChallenge.signalHash),
      });

      // Second attempt while still enrolled
      await assert.rejects(
        async () => {
          await service.createChallenge(initData);
        },
        /already enrolled/i
      );
    });
  });

  describe('completeEnrollment with real validators', () => {
    it('completes enrollment with valid proof', async () => {
      const userId = 12345;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      const challenge = await service.createChallenge(initData);
      const idkitResult = createIDKitResult(
        challenge.signedChallenge.nonce,
        TEST_ACTION,
        challenge.signedChallenge.signalHash
      );

      const result = await service.completeEnrollment({ initData, idkitResult });

      assert.equal(result.success, true);
      assert.equal(result.telegramUserId, userId);
      assert.ok(result.nullifier);
      assert.ok(result.expiresAt);
    });

    it('rejects malformed request object', async () => {
      const result = await service.completeEnrollment(null as any);

      assert.equal(result.success, false);
      assert.match(result.error!, /invalid request/i);
    });

    it('rejects missing initData', async () => {
      const result = await service.completeEnrollment({ idkitResult: {} } as any);

      assert.equal(result.success, false);
      assert.match(result.error!, /initData required/i);
    });

    it('rejects missing idkitResult', async () => {
      const initData = createValidInitData(12345, TEST_BOT_TOKEN);
      const result = await service.completeEnrollment({ initData } as any);

      assert.equal(result.success, false);
      assert.match(result.error!, /idkitResult required/i);
    });

    it('rejects account mismatch', async () => {
      const user1 = 12345;
      const user2 = 67890;

      const initData1 = createValidInitData(user1, TEST_BOT_TOKEN);
      const challenge = await service.createChallenge(initData1);

      const initData2 = createValidInitData(user2, TEST_BOT_TOKEN);
      const idkitResult = createIDKitResult(
        challenge.signedChallenge.nonce,
        TEST_ACTION,
        challenge.signedChallenge.signalHash
      );

      const result = await service.completeEnrollment({ initData: initData2, idkitResult });

      assert.equal(result.success, false);
      assert.match(result.error!, /account mismatch/i);
    });

    it('handles verification service unavailable', async () => {
      const userId = 12345;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      const challenge = await service.createChallenge(initData);

      // Mock network error
      mockClient.verify = async () => {
        throw new Error('Network error');
      };

      const idkitResult = createIDKitResult(
        challenge.signedChallenge.nonce,
        TEST_ACTION,
        challenge.signedChallenge.signalHash
      );

      const result = await service.completeEnrollment({ initData, idkitResult });

      assert.equal(result.success, false);
      assert.match(result.error!, /verification service unavailable/i);
    });
  });

  describe('expiry during async verification with fake clock', () => {
    it('detects expiry during verification', async () => {
      const userId = 12345;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      const challenge = await service.createChallenge(initData);
      const idkitResult = createIDKitResult(
        challenge.signedChallenge.nonce,
        TEST_ACTION,
        challenge.signedChallenge.signalHash
      );

      // Advance clock past expiry (300s + 1)
      fakeClock.advance(301);

      const result = await service.completeEnrollment({ initData, idkitResult });

      assert.equal(result.success, false);
      assert.match(result.error!, /expired/i);
    });

    it('detects expiry inside transaction', async () => {
      const userId = 12345;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      const challenge = await service.createChallenge(initData);
      const idkitResult = createIDKitResult(
        challenge.signedChallenge.nonce,
        TEST_ACTION,
        challenge.signedChallenge.signalHash
      );

      // Mock slow verification
      const originalVerify = mockClient.verify.bind(mockClient);
      mockClient.verify = async (ir, ec) => {
        fakeClock.advance(301); // Expire during verification
        return originalVerify(ir, ec);
      };

      const result = await service.completeEnrollment({ initData, idkitResult });

      assert.equal(result.success, false);
      assert.match(result.error!, /expired during/i);
    });
  });

  describe('revocation lifecycle', () => {
    it('blocks pre-revocation challenge from completing', async () => {
      const userId = 12345;
      const nullifier = '99999999999999999999';

      // Create challenge BEFORE revocation
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      const oldChallenge = await service.createChallenge(initData);

      // Enroll with a different challenge first
      const challenge1 = await service.createChallenge(initData);
      mockClient.setResponse(challenge1.signedChallenge.nonce, {
        success: true,
        nullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });
      await service.completeEnrollment({
        initData,
        idkitResult: createIDKitResult(challenge1.signedChallenge.nonce, TEST_ACTION, challenge1.signedChallenge.signalHash),
      });

      // Revoke account
      const revoked = await service.revokeEnrollment(userId);
      assert.equal(revoked, true);

      // Try to complete with old pre-revocation challenge
      mockClient.setResponse(oldChallenge.signedChallenge.nonce, {
        success: true,
        nullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      const result = await service.completeEnrollment({
        initData,
        idkitResult: createIDKitResult(oldChallenge.signedChallenge.nonce, TEST_ACTION, oldChallenge.signedChallenge.signalHash),
      });

      assert.equal(result.success, false);
      assert.match(result.error!, /predates revocation|Challenge session not found/i);
    });

    it('allows post-revocation fresh challenge to restore account', async () => {
      const userId = 12345;
      const nullifier = '88888888888888888888';

      // Initial enrollment
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      const challenge1 = await service.createChallenge(initData);
      mockClient.setResponse(challenge1.signedChallenge.nonce, {
        success: true,
        nullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });
      await service.completeEnrollment({
        initData,
        idkitResult: createIDKitResult(challenge1.signedChallenge.nonce, TEST_ACTION, challenge1.signedChallenge.signalHash),
      });

      // Revoke account
      const revoked = await service.revokeEnrollment(userId);
      assert.equal(revoked, true);

      // Advance time to ensure post-revocation challenge
      fakeClock.advance(10);

      // Create fresh post-revocation challenge
      const challenge2 = await service.createChallenge(initData);
      mockClient.setResponse(challenge2.signedChallenge.nonce, {
        success: true,
        nullifier, // Same nullifier
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      // Should succeed: post-revocation fresh verification restores access
      const result = await service.completeEnrollment({
        initData,
        idkitResult: createIDKitResult(challenge2.signedChallenge.nonce, TEST_ACTION, challenge2.signedChallenge.signalHash),
      });

      assert.equal(result.success, true);
      assert.equal(result.telegramUserId, userId);

      // Verify enrollment is active (not revoked)
      const enrollment = await service.findEnrollment(userId);
      assert.ok(enrollment);
      assert.equal(enrollment.revoked, false);
    });

    it('prevents cross-account nullifier theft (ownership protection)', async () => {
      const userId1 = 12345;
      const userId2 = 67890;
      const sharedNullifier = '77777777777777777777';

      // First account enrolls
      const initData1 = createValidInitData(userId1, TEST_BOT_TOKEN);
      const challenge1 = await service.createChallenge(initData1);
      mockClient.setResponse(challenge1.signedChallenge.nonce, {
        success: true,
        nullifier: sharedNullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });
      const result1 = await service.completeEnrollment({
        initData: initData1,
        idkitResult: createIDKitResult(challenge1.signedChallenge.nonce, TEST_ACTION, challenge1.signedChallenge.signalHash),
      });
      assert.equal(result1.success, true);

      // Second account attempts to enroll with SAME nullifier (should fail)
      const initData2 = createValidInitData(userId2, TEST_BOT_TOKEN);
      const challenge2 = await service.createChallenge(initData2);
      mockClient.setResponse(challenge2.signedChallenge.nonce, {
        success: true,
        nullifier: sharedNullifier, // Same nullifier
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });
      const result2 = await service.completeEnrollment({
        initData: initData2,
        idkitResult: createIDKitResult(challenge2.signedChallenge.nonce, TEST_ACTION, challenge2.signedChallenge.signalHash),
      });
      assert.equal(result2.success, false, 'Cross-account nullifier theft must be prevented');
      assert.match(result2.error || '', /different account|ownership/i, 'Error must mention ownership conflict');

      // First account should still be enrolled
      const enrollment1 = await service.findEnrollment(userId1);
      assert.ok(enrollment1);
      assert.equal(enrollment1.nullifier, sharedNullifier);

      // Second account should have no enrollment
      const enrollment2 = await service.findEnrollment(userId2);
      assert.equal(enrollment2, null, 'Second account must not be enrolled');
    });

    it('prevents nullifier reuse after revocation (immutable ownership)', async () => {
      const userId1 = 12345;
      const userId2 = 67890;
      const sharedNullifier = '66666666666666666666';

      // First account enrolls
      const initData1 = createValidInitData(userId1, TEST_BOT_TOKEN);
      const challenge1 = await service.createChallenge(initData1);
      mockClient.setResponse(challenge1.signedChallenge.nonce, {
        success: true,
        nullifier: sharedNullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });
      await service.completeEnrollment({
        initData: initData1,
        idkitResult: createIDKitResult(challenge1.signedChallenge.nonce, TEST_ACTION, challenge1.signedChallenge.signalHash),
      });

      // Revoke first account (nullifier remains permanently bound)
      const revoked = await service.revokeEnrollment(userId1);
      assert.equal(revoked, true);

      // Second account CANNOT enroll with same nullifier (immutable ownership)
      const initData2 = createValidInitData(userId2, TEST_BOT_TOKEN);
      const challenge2 = await service.createChallenge(initData2);
      mockClient.setResponse(challenge2.signedChallenge.nonce, {
        success: true,
        nullifier: sharedNullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });
      const result2 = await service.completeEnrollment({
        initData: initData2,
        idkitResult: createIDKitResult(challenge2.signedChallenge.nonce, TEST_ACTION, challenge2.signedChallenge.signalHash),
      });
      assert.equal(result2.success, false, 'Must prevent nullifier theft after revocation');
      assert.match(result2.error || '', /different account|immutable/i, 'Error must mention immutable binding');

      // First account should still be revoked
      const enrollment1 = await service.findEnrollment(userId1);
      assert.ok(enrollment1);
      assert.equal(enrollment1.revoked, true);

      // Second account should have no enrollment
      const enrollment2 = await service.findEnrollment(userId2);
      assert.equal(enrollment2, null, 'Second account must not be enrolled');

      // First account CAN re-enroll with SAME nullifier (owns it)
      fakeClock.advance(10);
      const challenge3 = await service.createChallenge(initData1);
      mockClient.setResponse(challenge3.signedChallenge.nonce, {
        success: true,
        nullifier: sharedNullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });
      const result3 = await service.completeEnrollment({
        initData: initData1,
        idkitResult: createIDKitResult(challenge3.signedChallenge.nonce, TEST_ACTION, challenge3.signedChallenge.signalHash),
      });
      assert.equal(result3.success, true, 'Original owner can re-enroll with same nullifier');
    });

    it('returns false when revoking non-existent enrollment', async () => {
      const revoked = await service.revokeEnrollment(99999);
      assert.equal(revoked, false);
    });
  });

  describe('cross-connection one-winner transaction', () => {
    it('one connection wins, other fails', async () => {
      const userId = 12345;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      const challenge = await service.createChallenge(initData);
      const idkitResult = createIDKitResult(
        challenge.signedChallenge.nonce,
        TEST_ACTION,
        challenge.signedChallenge.signalHash
      );

      // Create second service with separate connection
      const service2 = new EnrollmentService({
        dbPath: testDbPath, // Same DB
        challengeAdapter: adapter,
        verificationClient: mockClient,
        telegramBotToken: TEST_BOT_TOKEN,
        action: TEST_ACTION,
        clock: fakeClock,
      });

      try {
        // Race both connections
        const [result1, result2] = await Promise.all([
          service.completeEnrollment({ initData, idkitResult }),
          service2.completeEnrollment({ initData, idkitResult }),
        ]);

        const succeeded = [result1, result2].filter(r => r.success);
        const failed = [result1, result2].filter(r => !r.success);

        assert.equal(succeeded.length, 1, 'Exactly one should succeed');
        assert.equal(failed.length, 1, 'Exactly one should fail');
        assert.match(failed[0].error!, /consumed by another request|already enrolled/i);
      } finally {
        service2.close();
      }
    });
  });

  describe('schema migrations', () => {
    it('handles existing database without conflict', () => {
      service.close();

      // Create second service on same database
      const service2 = new EnrollmentService({
        dbPath: testDbPath,
        challengeAdapter: adapter,
        verificationClient: mockClient,
        telegramBotToken: TEST_BOT_TOKEN,
        action: TEST_ACTION,
        clock: fakeClock,
      });

      // Should not throw (no CREATE TABLE conflict)
      service2.close();
    });

    it('detects legacy database with incompatible schema (PRIMARY KEY (nullifier, action)) on enrollment attempt', async () => {
      service.close();

      const legacyDbPath = testDbPath + '.legacy';
      
      // Clean up any existing legacy database
      if (fs.existsSync(legacyDbPath)) {
        fs.unlinkSync(legacyDbPath);
      }
      
      // Create legacy schema database
      const legacyDb = new Database(legacyDbPath);
      
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS enrollments (
          telegram_user_id INTEGER NOT NULL,
          nullifier TEXT NOT NULL,
          action TEXT NOT NULL,
          issuer_schema_id INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          enrolled_at INTEGER NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          revoked_at INTEGER,
          revoked_generation INTEGER,
          PRIMARY KEY (nullifier, action)
        ) STRICT;
      `);
      
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS challenge_sessions (
          challenge_nonce TEXT PRIMARY KEY,
          signal_hash TEXT NOT NULL,
          telegram_user_id INTEGER NOT NULL,
          telegram_signature_timestamp INTEGER NOT NULL,
          telegram_signature_original_data TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL
        ) STRICT;
      `);
      
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS generation_counter (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          next_generation INTEGER NOT NULL
        ) STRICT;
      `);
      
      legacyDb.exec(`INSERT OR REPLACE INTO generation_counter (id, next_generation) VALUES (1, 1);`);
      
      legacyDb.close();

      // Attempting to open service with legacy schema should fail with migration error
      assert.throws(
        () => {
          new EnrollmentService({
            dbPath: legacyDbPath,
            challengeAdapter: adapter,
            verificationClient: mockClient,
            telegramBotToken: TEST_BOT_TOKEN,
            action: TEST_ACTION,
            clock: fakeClock,
          });
        },
        (err: Error) => {
          const message = err.message;
          return message.includes('SCHEMA MIGRATION REQUIRED') &&
                 message.includes('PRIMARY KEY (nullifier, action)') &&
                 message.includes('PRIMARY KEY (telegram_user_id, action)') &&
                 message.includes('OPERATOR ACTIONS REQUIRED');
        },
        'Service constructor should detect legacy schema and throw migration error'
      );

      // Clean up
      fs.unlinkSync(legacyDbPath);
    });
  });

  describe('revocation and renewal lifecycle', () => {
    it('allows fresh enrollment after revocation with monotonic generation check', async () => {
      const userId = 11111;
      const nullifier = '0x000000000000000000000000000000000000000000000000000000000001face';
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      // Initial enrollment
      const challenge1 = await service.createChallenge(initData);
      mockClient.setResponse(challenge1.signedChallenge.nonce, {
        success: true,
        nullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash
      );
      const result1 = await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
      assert.equal(result1.success, true);

      // Revoke the enrollment
      const revokeResult = await service.revokeEnrollment(userId);
      assert.equal(revokeResult, true);

      // Advance time by 1 second (same-second test)
      fakeClock.advance(1);

      // Create new challenge AFTER revocation (higher generation)
      const initData2 = createValidInitData(userId, TEST_BOT_TOKEN);
      const challenge2 = await service.createChallenge(initData2);

      // Complete enrollment with post-revoke challenge
      mockClient.setResponse(challenge2.signedChallenge.nonce, {
        success: true,
        nullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      const idkitResult2 = createIDKitResult(
        challenge2.signedChallenge.nonce,
        TEST_ACTION,
        challenge2.signedChallenge.signalHash
      );
      const result2 = await service.completeEnrollment({ initData: initData2, idkitResult: idkitResult2 });
      
      assert.equal(result2.success, true, 'Post-revoke enrollment should succeed');
    });

    it('rejects challenge created before revocation (monotonic generation)', async () => {
      const userId = 22222;
      const nullifier = '0x000000000000000000000000000000000000000000000000000000000002face';
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      
      // Create challenge BEFORE revocation
      const oldChallenge = await service.createChallenge(initData);

      // Create initial enrollment (different nullifier to avoid duplicate detection)
      const initialNullifier = '0xinitial_enrollment';
      const challenge1 = await service.createChallenge(initData);
      mockClient.setResponse(challenge1.signedChallenge.nonce, {
        success: true,
        nullifier: initialNullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash
      );
      await service.completeEnrollment({ initData, idkitResult: idkitResult1 });

      // Revoke the enrollment
      await service.revokeEnrollment(userId);

      // Attempt to use pre-revoke challenge (should fail)
      mockClient.setResponse(oldChallenge.signedChallenge.nonce, {
        success: true,
        nullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      const idkitResult = createIDKitResult(
        oldChallenge.signedChallenge.nonce,
        TEST_ACTION,
        oldChallenge.signedChallenge.signalHash
      );
      const result = await service.completeEnrollment({ initData, idkitResult });
      
      assert.equal(result.success, false);
      assert.match(result.error!, /predates revocation|revoked|stale challenge|Challenge session not found/i);
    });

    it('allows renewal of expired enrollment (exact expiry boundary test)', async () => {
      // Create service with minimum enrollment TTL (86400 seconds = 1 day) for testing expiry
      const shortTtlDbPath = testDbPath + '.shortttl';
      const shortTtlService = new EnrollmentService({
        dbPath: shortTtlDbPath,
        challengeAdapter: adapter,
        verificationClient: mockClient,
        telegramBotToken: TEST_BOT_TOKEN,
        action: TEST_ACTION,
        challengeTtlSeconds: 300,
        enrollmentTtlSeconds: 86400, // Minimum TTL (1 day)
        clock: fakeClock,
      });

      try {
        const userId = 33333;
        const nullifier = '0xexpired_renewal';
        const initData = createValidInitData(userId, TEST_BOT_TOKEN);

        // Initial enrollment with 1 day TTL
        const challenge1 = await shortTtlService.createChallenge(initData);
        mockClient.setResponse(challenge1.signedChallenge.nonce, {
          success: true,
          nullifier,
          issuerSchemaId: 1,
          expiresAtMin: fakeClock.nowSeconds() + 86400,
        });

        const idkitResult1 = createIDKitResult(
          challenge1.signedChallenge.nonce,
          TEST_ACTION,
          challenge1.signedChallenge.signalHash
        );
        const result1 = await shortTtlService.completeEnrollment({ initData, idkitResult: idkitResult1 });
        assert.equal(result1.success, true);

        // Advance time past enrollment TTL (1 day + 1 second)
        fakeClock.advance(86401);

        // Create new challenge for renewal (should succeed for expired enrollment)
        const initData2 = createValidInitData(userId, TEST_BOT_TOKEN);
        const challenge2 = await shortTtlService.createChallenge(initData2);

        // Complete renewal
        mockClient.setResponse(challenge2.signedChallenge.nonce, {
          success: true,
          nullifier,
          issuerSchemaId: 1,
          expiresAtMin: fakeClock.nowSeconds() + 86400,
        });

        const idkitResult2 = createIDKitResult(
          challenge2.signedChallenge.nonce,
          TEST_ACTION,
          challenge2.signedChallenge.signalHash
        );
        const renewResult = await shortTtlService.completeEnrollment({ 
          initData: initData2, 
          idkitResult: idkitResult2 
        });
        
        assert.equal(renewResult.success, true, 'Expired enrollment renewal should succeed');
      } finally {
        shortTtlService.close();
        if (fs.existsSync(shortTtlDbPath)) {
          fs.unlinkSync(shortTtlDbPath);
        }
      }
    });
  });
});
