/**
 * Early renewal test - /verify for already-active user offers renewal via proveSession
 * 
 * Tests that:
 * - Active enrolled user with session_id creates renewal challenge (mode: 'renewal')
 * - Revoked user creates reactivation challenge (mode: 'reactivation')
 * - Expired user creates renewal challenge (mode: 'renewal')
 * - User without session_id gets clear error, never falls back to session_id:'create'
 * - Successful renewal extends expiry to now + TTL
 * - Challenge issued before revoke is rejected
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { createHmac } from 'node:crypto';
import type { IDKitResult } from './worldid-types.js';

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
    async verify(proof: any, context: any): Promise<any> {
      return {
        success: true,
        nullifier: proof.responses[0].nullifier,
        environment: 'staging',
      };
    },
  };

  await t.test('active user with session creates renewal challenge and extends expiry', async () => {
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

    // Step 1: Create initial enrollment with session
    const initialChallenge = await service.createChallenge(initData);
    assert.ok(initialChallenge.signedChallenge);
    assert.strictEqual(initialChallenge.signedChallenge.action, TEST_ACTION);
    assert.ok(initialChallenge.signal);
    
    // Simulate enrollment completion with session
    const mockProof: IDKitResult = {
      protocol_version: '4.0',
      nonce: initialChallenge.signedChallenge.nonce,
      action: TEST_ACTION,
      session_id: 'session_' + '0'.repeat(128),
      responses: [{
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '0x' + '0'.repeat(64),
        signal_hash: initialChallenge.signedChallenge.signalHash,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging',
    };
    
    const enrollmentResult = await service.completeEnrollment({
      initData,
      idkitResult: mockProof,
    });
    assert.ok(enrollmentResult.success, `Initial enrollment should succeed: ${enrollmentResult.error || ''}`);
    
    const enrollment = await service.findEnrollment(userId);
    assert.ok(enrollment, 'Enrollment should exist');
    assert.strictEqual(enrollment.revoked, false);
    assert.strictEqual(enrollment.expired, false);
    assert.ok(enrollment.sessionId, 'Enrollment should have sessionId');
    const originalExpiresAt = enrollment.expiresAt;

    // Step 2: Request early renewal (user is still active)
    const renewalChallenge = await service.createSessionChallenge(initData, { mode: 'renewal' });
    assert.ok(renewalChallenge.signedChallenge, 'Renewal challenge should be created');
    // Session challenge has no action field (session-only proof)
    assert.strictEqual(renewalChallenge.signedChallenge.action, null, 'Session challenge should have null action');

    // Step 3: Complete renewal proof using existing session_id
    // Session proofs use session_nullifier tuple instead of regular nullifier
    // Both elements must be 0x-prefixed hex strings
    const renewalProof: any = {
      protocol_version: '4.0',
      nonce: renewalChallenge.signedChallenge.nonce,
      session_id: enrollment.sessionId, // Use existing sessionId from enrollment
      responses: [{
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        proof: ['6', '7', '8', '9', '10'],
        session_nullifier: ['0x' + '0'.repeat(64), '0x' + '1'.repeat(64)], // [nullifier, randomized action as hex]
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging',
    };
    
    const renewalResult = await service.completeEnrollment({
      initData,
      idkitResult: renewalProof,
    });
    assert.ok(renewalResult.success, `Renewal should succeed: ${renewalResult.error || ''}`);

    // Step 4: Verify expiry was extended
    const updatedEnrollment = await service.findEnrollment(userId);
    assert.ok(updatedEnrollment, 'Updated enrollment should exist');
    assert.ok(updatedEnrollment.expiresAt > originalExpiresAt, 'Expiry should be extended');
    
    // Verify new expiry is approximately now + 5 days (432000 seconds)
    const now = Math.floor(Date.now() / 1000);
    const expectedExpiry = now + 432000;
    const expiryDelta = Math.abs(updatedEnrollment.expiresAt - expectedExpiry);
    assert.ok(expiryDelta < 10, `Expiry delta ${expiryDelta}s should be less than 10s`);
  });

  await t.test('user without session_id gets clear error', async () => {
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

    // Create and complete initial enrollment WITHOUT session_id
    const initialChallenge = await service.createChallenge(initData);
    const mockProofWithoutSession: IDKitResult = {
      protocol_version: '4.0',
      nonce: initialChallenge.signedChallenge.nonce,
      action: TEST_ACTION,
      // No session_id field
      responses: [{
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '0x' + '1'.repeat(64),
        signal_hash: initialChallenge.signedChallenge.signalHash,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging',
    };
    
    await service.completeEnrollment({
      initData,
      idkitResult: mockProofWithoutSession,
    });

    const enrollment = await service.findEnrollment(userId);
    assert.ok(enrollment);
    assert.strictEqual(enrollment.sessionId, null, 'Enrollment should not have sessionId');

    // Request renewal should fail with clear error
    await assert.rejects(
      async () => {
        await service.createSessionChallenge(initData, { mode: 'renewal' });
      },
      /No session ID found/,
      'Should reject with clear error about missing session ID'
    );
  });

  await t.test('revoked user creates reactivation challenge', async () => {
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

    // Create initial enrollment with session
    const initialChallenge = await service.createChallenge(initData);
    const mockProof: IDKitResult = {
      protocol_version: '4.0',
      nonce: initialChallenge.signedChallenge.nonce,
      action: TEST_ACTION,
      session_id: 'session_' + '2'.repeat(128),
      responses: [{
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '0x' + '2'.repeat(64),
        signal_hash: initialChallenge.signedChallenge.signalHash,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging',
    };
    
    await service.completeEnrollment({
      initData,
      idkitResult: mockProof,
    });

    // Revoke enrollment
    await service.revokeEnrollment(userId);
    const revokedEnrollment = await service.findEnrollment(userId);
    assert.ok(revokedEnrollment?.revoked);

    // renewal mode should fail for revoked
    await assert.rejects(
      async () => {
        await service.createSessionChallenge(initData, { mode: 'renewal' });
      },
      /has been revoked/,
      'Renewal mode should reject revoked enrollment'
    );

    // reactivation mode should succeed
    const reactivationChallenge = await service.createSessionChallenge(initData, { mode: 'reactivation' });
    assert.ok(reactivationChallenge.signedChallenge, 'Reactivation challenge should be created');
  });

  await t.test('expired user creates renewal challenge', async () => {
    const service = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: stubVerifier as any,
      action: TEST_ACTION,
      dbPath: ':memory:',
      enrollmentTtlSeconds: 86400, // 1 day minimum
    });

    const userId = 100004;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // Create initial enrollment with past expiry
    const initialChallenge = await service.createChallenge(initData);
    const mockProof: IDKitResult = {
      protocol_version: '4.0',
      nonce: initialChallenge.signedChallenge.nonce,
      action: TEST_ACTION,
      session_id: 'session_' + '3'.repeat(128),
      responses: [{
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '0x' + '3'.repeat(64),
        signal_hash: initialChallenge.signedChallenge.signalHash,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging',
    };
    
    await service.completeEnrollment({
      initData,
      idkitResult: mockProof,
    });

    // Manually set expiry to past by directly updating DB
    const db = (service as any).db;
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`UPDATE enrollments SET expires_at = ? WHERE telegram_user_id = ?`)
      .run(now - 100, userId);

    const expiredEnrollment = await service.findEnrollment(userId);
    assert.ok(expiredEnrollment);
    assert.ok(expiredEnrollment.expired, 'Enrollment should be expired');
    assert.strictEqual(expiredEnrollment.revoked, false, 'Enrollment should not be revoked');

    // Renewal mode should still work for expired (but not revoked)
    const renewalChallenge = await service.createSessionChallenge(initData, { mode: 'renewal' });
    assert.ok(renewalChallenge.signedChallenge, 'Renewal challenge should be created for expired enrollment');
  });

  await t.test('challenge issued before revoke is rejected', async () => {
    const service = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: stubVerifier as any,
      action: TEST_ACTION,
      dbPath: ':memory:',
      enrollmentTtlSeconds: 432000,
    });

    const userId = 100005;
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);

    // Create initial enrollment with session
    const initialChallenge = await service.createChallenge(initData);
    const mockProof: IDKitResult = {
      protocol_version: '4.0',
      nonce: initialChallenge.signedChallenge.nonce,
      action: TEST_ACTION,
      session_id: 'session_' + '4'.repeat(128),
      responses: [{
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '0x' + '4'.repeat(64),
        signal_hash: initialChallenge.signedChallenge.signalHash,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging',
    };
    
    await service.completeEnrollment({
      initData,
      idkitResult: mockProof,
    });

    // Create renewal challenge BEFORE revoke
    const renewalChallengeBeforeRevoke = await service.createSessionChallenge(initData, { mode: 'renewal' });
    
    // NOW revoke the enrollment
    await service.revokeEnrollment(userId);
    
    // Try to complete renewal with challenge issued before revoke
    // Session proof format with session_nullifier tuple
    // Both elements must be 0x-prefixed hex strings
    const renewalProof: any = {
      protocol_version: '4.0',
      nonce: renewalChallengeBeforeRevoke.signedChallenge.nonce,
      session_id: mockProof.session_id,
      responses: [{
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        proof: ['6', '7', '8', '9', '10'],
        session_nullifier: ['0x' + '4'.repeat(64), '0x' + '5'.repeat(64)],
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging',
    };
    
    const renewalResult = await service.completeEnrollment({
      initData,
      idkitResult: renewalProof,
    });
    
    // Should fail because enrollment was revoked after challenge was created
    // The mode check will detect 'renewal' challenge but revoked enrollment
    assert.strictEqual(renewalResult.success, false, 'Renewal should fail when enrollment revoked after challenge creation');
    assert.ok(renewalResult.error, 'Should have error message');
  });
});
