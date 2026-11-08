/**
 * Schema v2 migration and blocker regression tests
 * 
 * Tests:
 * 1. V1 to V2 migration with existing data
 * 2. Immutable nullifier ownership (never released)
 * 3. Revoked-owner takeover prevention
 * 4. Old-binding replacement prevention
 * 5. No-enrollment revoke with durable fence
 * 6. directEnroll production restriction
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { EnrollmentService, type Clock } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';

const TEST_SIGNING_KEY = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_APP_ID = 'app_test_migration';
const TEST_RP_ID = 'rp_test_migration';
const TEST_BOT_TOKEN = 'test_bot_migration';
const TEST_ACTION = 'test-migration';

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

  setTime(seconds: number): void {
    this.currentSeconds = seconds;
  }
}

class MockWorldIdClient {
  private responses = new Map<string, any>();

  setResponse(nonce: string, result: any) {
    this.responses.set(nonce, result);
  }

  async verify(idkitResult: any, expectedContext: any): Promise<any> {
    const mockResult = this.responses.get(idkitResult.nonce);
    if (!mockResult) {
      return { success: false, error: 'Mock: No response configured' };
    }
    return mockResult;
  }
}

function createValidInitData(userId: number, botToken: string): string {
  const authDate = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: userId, first_name: 'Test', username: `user${userId}` });
  
  const params: Record<string, string> = {
    user,
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

function createIDKitResult(nonce: string, action: string, signalHash: string) {
  return {
    nonce,
    action,
    signal_hash: signalHash,
    proof: 'mock_proof',
    merkle_root: 'mock_root',
  };
}

describe('Schema V2 Migration and Blockers', () => {
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = `/tmp/test-migration-v2-${Date.now()}.db`;
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('V1 to V2 Migration', () => {
    test('migrates existing v1 database with enrollments', () => {
      // Create v1 schema manually
      const db = new Database(testDbPath);
      
      db.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_version VALUES (1, '2026-11-01T12:00:00Z');
      `);

      db.exec(`
        CREATE TABLE enrollments (
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          nullifier TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          revoked_at TEXT,
          revoked_at_seconds INTEGER,
          revoked_generation INTEGER,
          PRIMARY KEY (telegram_user_id, action)
        );
      `);

      db.exec(`
        CREATE TABLE challenge_sessions (
          nonce TEXT PRIMARY KEY,
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          signal_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          created_at_seconds INTEGER NOT NULL,
          generation INTEGER NOT NULL
        );
      `);

      db.exec(`
        CREATE TABLE generation_counter (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          next_generation INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO generation_counter VALUES (1, 1);
      `);

      // Insert test enrollment
      db.exec(`
        INSERT INTO enrollments (telegram_user_id, action, nullifier, expires_at, created_at, revoked)
        VALUES (12345, 'test-migration', '0xtest_nullifier_v1', ${Math.floor(Date.now() / 1000) + 86400}, '2026-11-01T12:00:00Z', 0);
      `);

      db.close();

      // Open with v2 service (triggers migration)
      const fakeClock = new FakeClock();
      const adapter = new WorldIdChallengeAdapter({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        signingKeyHex: TEST_SIGNING_KEY,
        environment: 'staging',
      });
      const mockClient = new MockWorldIdClient();

      const service = new EnrollmentService({
        dbPath: testDbPath,
        challengeAdapter: adapter,
        verificationClient: mockClient as any,
        telegramBotToken: TEST_BOT_TOKEN,
        action: TEST_ACTION,
        clock: fakeClock,
      });

      // Verify v2 tables exist
      const dbCheck = new Database(testDbPath);
      
      const nullifierClaimsExists = dbCheck.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='nullifier_claims'
      `).get();
      assert.ok(nullifierClaimsExists, 'nullifier_claims table must exist after migration');

      const fencesExists = dbCheck.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='generation_fences'
      `).get();
      assert.ok(fencesExists, 'generation_fences table must exist after migration');

      // Verify backfill
      const claim = dbCheck.prepare(`
        SELECT * FROM nullifier_claims WHERE action = 'test-migration'
      `).get() as any;
      assert.ok(claim, 'Existing enrollment must be backfilled to nullifier_claims');
      assert.equal(claim.telegram_user_id, 12345, 'Backfilled claim must have correct user');
      assert.equal(claim.nullifier, '0xtest_nullifier_v1', 'Backfilled claim must have correct nullifier');

      // Verify version updated (v2 + v3 migrations both run)
      const version = dbCheck.prepare(`SELECT MAX(version) as v FROM schema_version`).get() as any;
      assert.equal(version.v, 3, 'Schema version must be updated to 3');

      dbCheck.close();
      service.close();
    });

    test('fails closed on ambiguous nullifier ownership', () => {
      // Create v1 schema with duplicate nullifier (data corruption)
      const db = new Database(testDbPath);
      
      db.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_version VALUES (1, '2026-11-01T12:00:00Z');
      `);

      db.exec(`
        CREATE TABLE enrollments (
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          nullifier TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (telegram_user_id, action)
        );
      `);

      db.exec(`
        CREATE TABLE generation_counter (id INTEGER PRIMARY KEY, next_generation INTEGER);
        INSERT INTO generation_counter VALUES (1, 1);
      `);

      // Insert TWO users with same nullifier (should never happen, but test fail-closed)
      db.exec(`
        INSERT INTO enrollments (telegram_user_id, action, nullifier, expires_at, created_at, revoked)
        VALUES (100, 'test-migration', '0xduplicate', ${Math.floor(Date.now() / 1000) + 86400}, '2026-11-01T12:00:00Z', 0);
      `);
      db.exec(`
        INSERT INTO enrollments (telegram_user_id, action, nullifier, expires_at, created_at, revoked)
        VALUES (200, 'test-migration', '0xduplicate', ${Math.floor(Date.now() / 1000) + 86400}, '2026-11-01T13:00:00Z', 0);
      `);

      db.close();

      // Attempt to open with v2 service (should fail migration)
      const fakeClock = new FakeClock();
      const adapter = new WorldIdChallengeAdapter({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        signingKeyHex: TEST_SIGNING_KEY,
        environment: 'staging',
      });
      const mockClient = new MockWorldIdClient();

      assert.throws(() => {
        new EnrollmentService({
          dbPath: testDbPath,
          challengeAdapter: adapter,
          verificationClient: mockClient as any,
          telegramBotToken: TEST_BOT_TOKEN,
          action: TEST_ACTION,
          clock: fakeClock,
        });
      }, /Ambiguous nullifier ownership/i);
    });

    test('backfills generation_fences from revoked enrollments', () => {
      // Create v1 DB with revoked enrollment
      const db = new Database(testDbPath);
      
      db.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_version VALUES (1, '2026-11-01T12:00:00Z');
      `);

      db.exec(`
        CREATE TABLE enrollments (
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          nullifier TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          revoked_at TEXT,
          revoked_at_seconds INTEGER,
          revoked_generation INTEGER,
          PRIMARY KEY (telegram_user_id, action)
        );
      `);

      db.exec(`
        CREATE TABLE generation_counter (id INTEGER PRIMARY KEY, next_generation INTEGER);
        INSERT INTO generation_counter VALUES (1, 10);
      `);

      // Insert revoked enrollment with generation marker
      const revokedAt = Math.floor(Date.now() / 1000);
      db.exec(`
        INSERT INTO enrollments (telegram_user_id, action, nullifier, expires_at, created_at, revoked, revoked_at, revoked_at_seconds, revoked_generation)
        VALUES (555, 'test-migration', '0xrevoked_nullifier', ${revokedAt + 86400}, '2026-11-01T12:00:00Z', 1, '2026-11-01T13:00:00Z', ${revokedAt}, 5);
      `);

      db.close();

      // Open with v2 service (triggers migration with fence backfill)
      const fakeClock = new FakeClock();
      const adapter = new WorldIdChallengeAdapter({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        signingKeyHex: TEST_SIGNING_KEY,
        environment: 'staging',
      });
      const mockClient = new MockWorldIdClient();

      const service = new EnrollmentService({
        dbPath: testDbPath,
        challengeAdapter: adapter,
        verificationClient: mockClient as any,
        telegramBotToken: TEST_BOT_TOKEN,
        action: TEST_ACTION,
        clock: fakeClock,
      });

      // Verify generation_fences backfilled
      const dbCheck = new Database(testDbPath);
      
      const fence = dbCheck.prepare(`
        SELECT * FROM generation_fences WHERE telegram_user_id = 555 AND action = 'test-migration'
      `).get() as any;

      assert.ok(fence, 'Revoked enrollment must have generation fence');
      assert.equal(fence.fence_generation, 5, 'Fence must have correct generation');
      assert.equal(fence.fence_timestamp, revokedAt, 'Fence must have correct timestamp');

      dbCheck.close();
      service.close();
    });

    test('detects partial migration restart and fails safe', () => {
      // Simulate crash scenario: v2 tables exist with data, but version=1
      const db = new Database(testDbPath);
      
      db.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_version VALUES (1, '2026-11-01T12:00:00Z');
      `);

      db.exec(`
        CREATE TABLE enrollments (
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          nullifier TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (telegram_user_id, action)
        );
      `);

      db.exec(`
        CREATE TABLE generation_counter (id INTEGER PRIMARY KEY, next_generation INTEGER);
        INSERT INTO generation_counter VALUES (1, 1);
      `);

      // Create v2 tables (simulating partial migration)
      db.exec(`
        CREATE TABLE nullifier_claims (
          nullifier TEXT NOT NULL,
          action TEXT NOT NULL,
          telegram_user_id INTEGER NOT NULL,
          claimed_at INTEGER NOT NULL,
          claimed_at_iso TEXT NOT NULL,
          PRIMARY KEY (nullifier, action)
        );
      `);

      db.exec(`
        CREATE TABLE generation_fences (
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          fence_generation INTEGER NOT NULL,
          fence_timestamp INTEGER NOT NULL,
          fence_iso TEXT NOT NULL,
          PRIMARY KEY (telegram_user_id, action)
        );
      `);

      // Insert data (simulating completed backfill)
      db.exec(`
        INSERT INTO nullifier_claims VALUES ('0xtest', 'test-migration', 123, ${Math.floor(Date.now() / 1000)}, '2026-11-01T12:00:00Z');
      `);

      db.close();

      // Attempt restart (should detect partial migration)
      const fakeClock = new FakeClock();
      const adapter = new WorldIdChallengeAdapter({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        signingKeyHex: TEST_SIGNING_KEY,
        environment: 'staging',
      });
      const mockClient = new MockWorldIdClient();

      assert.throws(() => {
        new EnrollmentService({
          dbPath: testDbPath,
          challengeAdapter: adapter,
          verificationClient: mockClient as any,
          telegramBotToken: TEST_BOT_TOKEN,
          action: TEST_ACTION,
          clock: fakeClock,
        });
      }, /MIGRATION RESTART DETECTED/i);
    });
  });

  describe('Blocker 1: Immutable Nullifier Ownership', () => {
    test('prevents revoked-owner nullifier takeover', async () => {
      const fakeClock = new FakeClock();
      const adapter = new WorldIdChallengeAdapter({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        signingKeyHex: TEST_SIGNING_KEY,
        environment: 'staging',
      });
      const mockClient = new MockWorldIdClient();

      const service = new EnrollmentService({
        dbPath: testDbPath,
        challengeAdapter: adapter,
        verificationClient: mockClient as any,
        telegramBotToken: TEST_BOT_TOKEN,
        action: TEST_ACTION,
        clock: fakeClock,
      });

      const sharedNullifier = '0ximmutable_test';

      // User A enrolls
      const initDataA = createValidInitData(100, TEST_BOT_TOKEN);
      const challengeA = await service.createChallenge(initDataA);
      mockClient.setResponse(challengeA.signedChallenge.nonce, {
        success: true,
        nullifier: sharedNullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      await service.completeEnrollment({
        initData: initDataA,
        idkitResult: createIDKitResult(challengeA.signedChallenge.nonce, TEST_ACTION, challengeA.signedChallenge.signalHash),
      });

      // User A revokes
      await service.revokeEnrollment(100);

      // User B attempts to claim same nullifier (should fail)
      fakeClock.advance(10);
      const initDataB = createValidInitData(200, TEST_BOT_TOKEN);
      const challengeB = await service.createChallenge(initDataB);
      mockClient.setResponse(challengeB.signedChallenge.nonce, {
        success: true,
        nullifier: sharedNullifier,
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      const resultB = await service.completeEnrollment({
        initData: initDataB,
        idkitResult: createIDKitResult(challengeB.signedChallenge.nonce, TEST_ACTION, challengeB.signedChallenge.signalHash),
      });

      assert.equal(resultB.success, false, 'Must prevent takeover of revoked nullifier');
      assert.match(resultB.error || '', /different account|immutable/i, 'Error must mention immutable binding');

      service.close();
    });

    test('prevents old-binding replacement on re-enrollment', async () => {
      const fakeClock = new FakeClock();
      const adapter = new WorldIdChallengeAdapter({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        signingKeyHex: TEST_SIGNING_KEY,
        environment: 'staging',
      });
      const mockClient = new MockWorldIdClient();

      const service = new EnrollmentService({
        dbPath: testDbPath,
        challengeAdapter: adapter,
        verificationClient: mockClient as any,
        telegramBotToken: TEST_BOT_TOKEN,
        action: TEST_ACTION,
        clock: fakeClock,
      });

      // User enrolls with nullifier N1
      const initData = createValidInitData(300, TEST_BOT_TOKEN);
      const challenge1 = await service.createChallenge(initData);
      mockClient.setResponse(challenge1.signedChallenge.nonce, {
        success: true,
        nullifier: '0xbinding1',
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      await service.completeEnrollment({
        initData,
        idkitResult: createIDKitResult(challenge1.signedChallenge.nonce, TEST_ACTION, challenge1.signedChallenge.signalHash),
      });

      // User revokes
      await service.revokeEnrollment(300);

      // User attempts to re-enroll with different nullifier N2
      fakeClock.advance(10);
      const challenge2 = await service.createChallenge(initData);
      mockClient.setResponse(challenge2.signedChallenge.nonce, {
        success: true,
        nullifier: '0xbinding2',  // Different nullifier
        issuerSchemaId: 1,
        expiresAtMin: fakeClock.nowSeconds() + 86400,
      });

      const result2 = await service.completeEnrollment({
        initData,
        idkitResult: createIDKitResult(challenge2.signedChallenge.nonce, TEST_ACTION, challenge2.signedChallenge.signalHash),
      });

      assert.equal(result2.success, true, 'User can re-enroll with new nullifier');

      // Verify BOTH nullifiers are permanently claimed
      const db = new Database(testDbPath);
      const claims = db.prepare(`
        SELECT nullifier FROM nullifier_claims WHERE telegram_user_id = 300 ORDER BY claimed_at
      `).all() as any[];

      assert.equal(claims.length, 2, 'Both nullifiers must be permanently claimed');
      assert.equal(claims[0].nullifier, '0xbinding1', 'First nullifier must remain claimed');
      assert.equal(claims[1].nullifier, '0xbinding2', 'Second nullifier must be claimed');

      db.close();
      service.close();
    });
  });

  describe('Blocker 3: directEnroll Restriction', () => {
    test('fails in production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const fakeClock = new FakeClock();
        const adapter = new WorldIdChallengeAdapter({
          appId: TEST_APP_ID,
          rpId: TEST_RP_ID,
          signingKeyHex: TEST_SIGNING_KEY,
          environment: 'staging',
        });
        const mockClient = new MockWorldIdClient();

        const service = new EnrollmentService({
          dbPath: testDbPath,
          challengeAdapter: adapter,
          verificationClient: mockClient as any,
          telegramBotToken: TEST_BOT_TOKEN,
          action: TEST_ACTION,
          clock: fakeClock,
        });

        assert.rejects(
          async () => {
            await service.directEnroll({
              telegramUserId: 999,
              nullifier: '0xtest',
              credential: { credential_type: 'orb' },
            });
          },
          /test-only.*production/i
        );

        service.close();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });
});
