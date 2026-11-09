/**
 * Challenge mode binding and race condition tests.
 * 
 * CRITICAL SECURITY TESTS:
 * - Renewal challenge created before revocation MUST fail after revocation
 * - Reactivation challenge created while revoked MUST fail if enrollment un-revoked
 * - Challenge mode is durably bound at creation time
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EnrollmentService, type Clock, type BackendVerificationClient } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import type { IDKitResult, BackendVerificationResult, ExpectedVerificationContext, IDKitResultSession } from './worldid-types.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';

// Test configuration
const TEST_SIGNING_KEY = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_APP_ID = 'app_test1234567890abcdef1234567890';
const TEST_RP_ID = 'rp_test1234567890ab';
const TEST_BOT_TOKEN = 'test_bot_12345';
const TEST_ACTION = 'test-challenge-mode-race';

// Fake clock
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

// Mock verification client - returns nullifier from request
class MockVerificationClient implements BackendVerificationClient {
  async verify(
    idkitResult: IDKitResult,
    expectedContext: ExpectedVerificationContext
  ): Promise<BackendVerificationResult> {
    // Extract nullifier from responses
    const nullifier = (idkitResult.responses && idkitResult.responses[0])
      ? (idkitResult.responses[0] as any).nullifier
      : '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde1';

    return {
      success: true,
      nullifier,
      issuerSchemaId: 1,
      expiresAtMin: Math.floor(Date.now() / 1000) + 86400,
    };
  }
}

// Generate valid initData
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

describe('Challenge Mode Race Conditions', () => {
  let service: EnrollmentService;
  let mockClient: MockVerificationClient;
  let fakeClock: FakeClock;
  let adapter: WorldIdChallengeAdapter;
  let testDbPath: string;

  before(() => {
    testDbPath = '/tmp/test-challenge-mode-race-' + Date.now() + '.db';
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    fakeClock = new FakeClock();
    adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      environment: 'staging',
    });
    mockClient = new MockVerificationClient();

    service = new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter: adapter,
      verificationClient: mockClient as any,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
      clock: fakeClock,
    });
  });

  after(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('renewal challenge created before revocation fails after revocation', async () => {
    const userId = 10001;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // 1. Enroll user with session creation
    const challenge1 = await service.createChallenge(initData);
    const enrollment1 = await service.completeEnrollment({
      initData,
      idkitResult: {
        protocol_version: '4.0',
        nonce: challenge1.signedChallenge.nonce,
        action: TEST_ACTION,
        session_id: 'session_' + 'a'.repeat(128),
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: 'test_signal_hash_1',
          proof: ['1', '2', '3'],
          nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde1',
          issuer_schema_id: 1,
          expires_at_min: fakeClock.nowSeconds() + 86400,
        }],
        environment: 'staging',
      },
    });

    if (!enrollment1.success) {
      console.error('Enrollment1 failed:', enrollment1.error);
    }
    assert.ok(enrollment1.success);
    assert.ok(enrollment1.sessionId);

    // 2. Create RENEWAL challenge (enrollment is active, not revoked)
    const renewalChallenge = await service.createSessionChallenge(initData, { mode: 'renewal' });
    assert.ok(renewalChallenge.signedChallenge);
    const renewalNonce = renewalChallenge.signedChallenge.nonce;

    // 3. Get challenge generation before revocation
    const db = new Database(testDbPath);
    const challengeGen = db.prepare(`
      SELECT generation FROM challenge_sessions WHERE nonce = ?
    `).get(renewalNonce) as any;
    const challengeGeneration = challengeGen.generation;

    // 4. REVOKE enrollment AFTER challenge creation (manually, without deleting challenge)
    // This simulates a race where revocation happens while challenge is pending
    const now = fakeClock.nowSeconds();
    const newGeneration = challengeGeneration + 10; // Higher generation than challenge
    
    // Set generation fence
    db.prepare(`
      INSERT INTO generation_fences (telegram_user_id, action, fence_generation, fence_timestamp, fence_iso)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, TEST_ACTION, newGeneration, now, fakeClock.nowISO());
    
    // Mark enrollment as revoked
    db.prepare(`
      UPDATE enrollments
      SET revoked = 1, revoked_at = ?, revoked_at_seconds = ?, revoked_generation = ?
      WHERE telegram_user_id = ? AND action = ?
    `).run(fakeClock.nowISO(), now, newGeneration, userId, TEST_ACTION);
    
    // Record revocation event
    db.prepare(`
      INSERT INTO revocation_events (telegram_user_id, action, event_type, event_at, event_at_iso, generation, triggered_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, TEST_ACTION, 'revoked', now, fakeClock.nowISO(), newGeneration, 'test', 'Manual revocation for race test');
    
    db.close();

    // 4. Attempt to complete renewal challenge (must fail - challenge predates revocation)
    const renewalResult = await service.verifySession({
      initData,
      idkitResult: {
        protocol_version: '4.0',
        nonce: renewalNonce,
        session_id: enrollment1.sessionId!,
        responses: [{
          identifier: 'proof_of_human',
          session_nullifier: ['0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde1', TEST_ACTION],
          issuer_schema_id: 1,
          verifiable_credential: {
            expires_at_min: fakeClock.nowSeconds() + 86400,
          },
        }],
        environment: 'staging',
      },
    });

    // CRITICAL: Must fail because challenge was created when enrollment was active (renewal mode)
    // but enrollment was revoked after challenge creation
    // Generation fence check happens first, then mode check (both are valid rejection reasons)
    assert.equal(renewalResult.success, false);
    assert.ok(
      renewalResult.error!.includes('predates revocation fence') || 
      renewalResult.error!.match(/renewal.*invalid.*revoked/i),
      `Expected fence or mode error, got: ${renewalResult.error}`
    );
  });

  it('reactivation challenge fails if enrollment not revoked at verification', async () => {
    const userId = 10002;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // 1. Enroll user
    const challenge1 = await service.createChallenge(initData);
    await service.completeEnrollment({
      initData,
      idkitResult: {
        protocol_version: '4.0',
        nonce: challenge1.signedChallenge.nonce,
        action: TEST_ACTION,
        session_id: 'session_' + 'b'.repeat(128),
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: 'test_signal_hash_2',
          proof: ['1', '2', '3'],
          nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde2',
          issuer_schema_id: 1,
          expires_at_min: fakeClock.nowSeconds() + 86400,
        }],
        environment: 'staging',
      },
    });

    // 2. Revoke enrollment
    await service.revokeEnrollment(userId);

    // 3. Create REACTIVATION challenge while revoked
    const reactivationChallenge = await service.createSessionChallenge(initData, { mode: 'reactivation' });
    const reactivationNonce = reactivationChallenge.signedChallenge.nonce;

    // 4. Manually clear revoked flag (simulating administrative un-revoke)
    const db = new Database(testDbPath);
    db.prepare(`
      UPDATE enrollments
      SET revoked = 0, revoked_at = NULL, revoked_at_seconds = NULL, revoked_generation = NULL
      WHERE telegram_user_id = ? AND action = ?
    `).run(userId, TEST_ACTION);
    db.close();

    // 5. Attempt to complete reactivation challenge (must fail - enrollment not revoked)
    const enrollment = await service.findEnrollment(userId);
    const reactivationResult = await service.verifySession({
      initData,
      idkitResult: {
        protocol_version: '4.0',
        nonce: reactivationNonce,
        session_id: enrollment!.sessionId!,
        responses: [{
          identifier: 'proof_of_human',
          session_nullifier: ['0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde2', TEST_ACTION],
          issuer_schema_id: 1,
          verifiable_credential: {
            expires_at_min: fakeClock.nowSeconds() + 86400,
          },
        }],
        environment: 'staging',
      },
    });

    // CRITICAL: Must fail because challenge was created for reactivation
    // but enrollment is not revoked at verification time
    assert.equal(reactivationResult.success, false);
    assert.match(reactivationResult.error!, /reactivation.*invalid.*not revoked/i);
  });

  it('challenge mode defaults to renewal for legacy challenges', async () => {
    const userId = 10003;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // 1. Enroll user
    const challenge1 = await service.createChallenge(initData);
    const enrollment1 = await service.completeEnrollment({
      initData,
      idkitResult: {
        protocol_version: '4.0',
        nonce: challenge1.signedChallenge.nonce,
        action: TEST_ACTION,
        session_id: 'session_' + 'c'.repeat(128),
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: 'test_signal_hash_3',
          proof: ['1', '2', '3'],
          nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde3',
          issuer_schema_id: 1,
          expires_at_min: fakeClock.nowSeconds() + 86400,
        }],
        environment: 'staging',
      },
    });

    assert.ok(enrollment1.success);

    // 2. Create session challenge without explicit mode
    const challengeNoMode = await service.createSessionChallenge(initData);

    // 3. Manually NULL the mode column (simulating legacy challenge)
    const db = new Database(testDbPath);
    db.prepare(`
      UPDATE challenge_sessions
      SET mode = NULL
      WHERE nonce = ?
    `).run(challengeNoMode.signedChallenge.nonce);
    db.close();

    // 4. Verify with active enrollment succeeds (defaults to renewal, enrollment is active)
    const verifyResult = await service.verifySession({
      initData,
      idkitResult: {
        protocol_version: '4.0',
        nonce: challengeNoMode.signedChallenge.nonce,
        session_id: enrollment1.sessionId!,
        responses: [{
          identifier: 'proof_of_human',
          session_nullifier: ['0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde3', TEST_ACTION],
          issuer_schema_id: 1,
          verifiable_credential: {
            expires_at_min: fakeClock.nowSeconds() + 86400,
          },
        }],
        environment: 'staging',
      },
    });

    // Should succeed - mode defaults to renewal, enrollment is active
    assert.equal(verifyResult.success, true);
  });
});
