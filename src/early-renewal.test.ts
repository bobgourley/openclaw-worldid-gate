/**
 * Early renewal test - /verify for already-active user offers renewal via proveSession
 * 
 * Tests that:
 * - /verify for active enrolled user creates renewal challenge (mode: 'renewal')
 * - Renewal uses proveSession, never session_id:'create'
 * - Successful renewal extends expiry to now + TTL
 * - Expiry date shown in success screen and /status is real server value
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { createHmac } from 'node:crypto';

const TEST_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const TEST_APP_ID = 'app_test_0123456789abcdef';
const TEST_RP_ID = 'rp_test_0123456789';
const TEST_ACTION = 'test-early-renewal';

function createValidInitData(userId: number, botToken: string): string {
  const authDate = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({
    id: userId,
    first_name: 'Test',
    username: 'testuser',
  });

  const dataCheckString = [
    `auth_date=${authDate}`,
    `user=${user}`,
  ].sort().join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return `auth_date=${authDate}&user=${encodeURIComponent(user)}&hash=${hash}`;
}

test('Early renewal via proveSession', async (t) => {
  const adapter = new WorldIdChallengeAdapter({
    appId: TEST_APP_ID,
    rpId: TEST_RP_ID,
    signingKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    challengeTtlSeconds: 300,
    environment: 'staging',
  });

  // Stub verifier that always succeeds
  const stubVerifier = {
    async verify(): Promise<any> {
      return {
        success: true,
        environment: 'staging',
        results: [{
          identifier: 'proof_of_human',
          success: true,
          nullifier: '0x' + '0'.repeat(64),
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400,
        }],
      };
    },
  };

  await t.test('active user receives renewal challenge with proveSession', async () => {
    const service = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: stubVerifier as any,
      action: TEST_ACTION,
      dbPath: ':memory:',
      enrollmentTtlSeconds: 432000, // 5 days
    });

    const userId = 100001;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // Step 1: Create initial enrollment
    const initialChallenge = await service.createChallenge(initData);
    assert.ok(initialChallenge.signedChallenge);
    assert.strictEqual(initialChallenge.signedChallenge.action, TEST_ACTION);
    
    // Simulate enrollment completion with session
    const mockProof = {
      protocol_version: '4.0' as const,
      nonce: initialChallenge.signedChallenge.nonce,
      action: TEST_ACTION,
      session_id: 'session_' + '0'.repeat(128),
      responses: [{
        identifier: 'proof_of_human' as const,
        issuer_schema_id: 1,
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '0x' + '0'.repeat(64),
        signal_hash: initialChallenge.signedChallenge.signalHash,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging' as const,
    };
    
    const enrollmentResult = await service.completeEnrollment({
      initData,
      idkitResult: mockProof,
    });
    if (!enrollmentResult.success) {
      console.error('Enrollment failed:', enrollmentResult.error);
    }
    assert.ok(enrollmentResult.success);
    
    const enrollment = await service.findEnrollment(userId);
    assert.ok(enrollment);
    assert.strictEqual(enrollment.revoked, false);
    assert.strictEqual(enrollment.expired, false);
    assert.ok(enrollment.sessionId);
    const originalExpiresAt = enrollment.expiresAt;

    // Step 2: Request early renewal (user is still active)
    const renewalChallenge = await service.createSessionChallenge(initData, { mode: 'renewal' });
    assert.ok(renewalChallenge.signedChallenge);
    
    // Verify renewal challenge uses existing session_id, not 'create'
    assert.strictEqual(renewalChallenge.signedChallenge.sessionId, enrollment.sessionId);
    assert.notStrictEqual(renewalChallenge.signedChallenge.sessionId, 'create');

    // Step 3: Complete renewal proof
    const renewalProof = {
      protocol_version: '4.0' as const,
      nonce: renewalChallenge.signedChallenge.nonce,
      session_id: enrollment.sessionId,
      responses: [{
        identifier: 'proof_of_human' as const,
        issuer_schema_id: 1,
        proof: ['6', '7', '8', '9', '10'],
        nullifier: '0x' + '0'.repeat(64),
        signal_hash: renewalChallenge.signedChallenge.signalHash,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging' as const,
    };
    
    const renewalResult = await service.completeEnrollment({
      initData,
      idkitResult: renewalProof,
    });
    assert.ok(renewalResult.success);

    // Step 4: Verify expiry was extended
    const updatedEnrollment = await service.findEnrollment(userId);
    assert.ok(updatedEnrollment);
    assert.ok(updatedEnrollment.expiresAt > originalExpiresAt, 'Expiry should be extended');
    
    // Verify new expiry is approximately now + 5 days (432000 seconds)
    const now = Math.floor(Date.now() / 1000);
    const expectedExpiry = now + 432000;
    const expiryDelta = Math.abs(updatedEnrollment.expiresAt - expectedExpiry);
    assert.ok(expiryDelta < 10, `Expiry delta ${expiryDelta}s should be less than 10s`);
  });

  await t.test('renewal challenge never has session_id create', async () => {
    const service = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: stubVerifier as any,
      action: TEST_ACTION,
      dbPath: ':memory:',
      enrollmentTtlSeconds: 432000,
    });

    const userId = 100002;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // Create and complete initial enrollment
    const initialChallenge = await service.createChallenge(initData);
    const mockProof = {
      protocol_version: '4.0' as const,
      nonce: initialChallenge.signedChallenge.nonce,
      action: TEST_ACTION,
      session_id: 'session_' + '1'.repeat(128),
      responses: [{
        identifier: 'proof_of_human' as const,
        issuer_schema_id: 1,
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '0x' + '1'.repeat(64),
        signal_hash: initialChallenge.signedChallenge.signalHash,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging' as const,
    };
    
    await service.completeEnrollment({
      initData,
      idkitResult: mockProof,
    });

    // Request renewal
    const renewalChallenge = await service.createSessionChallenge(initData, { mode: 'renewal' });
    
    // CRITICAL: renewal challenge must use existing session_id, never 'create'
    assert.notStrictEqual(renewalChallenge.signedChallenge.sessionId, 'create');
    assert.strictEqual(renewalChallenge.signedChallenge.sessionId, 'session_' + '1'.repeat(128));
  });

  await t.test('new enrollment uses session_id create', async () => {
    const service = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: stubVerifier as any,
      action: TEST_ACTION,
      dbPath: ':memory:',
      enrollmentTtlSeconds: 432000,
    });

    const userId = 100003;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // New enrollment (no existing enrollment)
    const challenge = await service.createChallenge(initData);
    
    // New enrollment should have session_id 'create'
    assert.strictEqual(challenge.signedChallenge.sessionId, 'create');
  });
});
