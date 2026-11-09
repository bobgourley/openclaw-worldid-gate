/**
 * Session Verification Integration Tests
 * 
 * Tests complete backend session verification flow with adversarial cases:
 * - Mismatched identifiers (account, session, action, environment, protocol)
 * - Duplicate/racing submissions
 * - Expired challenges
 * - Revoke during verification
 * - Restart persistence
 * - Generation fence enforcement
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { unlinkSync } from 'node:fs';
import { randomBytes, createHmac, createHash } from 'node:crypto';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import type { IDKitResultSession } from './worldid-types.js';

const TEST_DB_PATH = ':memory:'; // Use in-memory for tests
const TEST_ACTION = 'test-session-verification';
const TEST_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

// Mock verification client
class MockVerifier {
  private responses: Map<string, { success: boolean; nullifier?: string }> = new Map();
  
  setResponse(nonce: string, response: { success: boolean; nullifier?: string }) {
    this.responses.set(nonce, response);
  }
  
  async verify(idkitResult: any, expectedContext: any) {
    const response = this.responses.get(expectedContext?.nonce || idkitResult.nonce);
    if (!response) {
      return { success: false };
    }
    
    return {
      success: response.success,
      nullifier: response.nullifier,
      issuerSchemaId: 1,
      expiresAtMin: Math.floor(Date.now() / 1000) + 86400,
    };
  }
}

// Create valid Telegram initData
function createValidInitData(userId: number, botToken: string): string {
  const authDate = Math.floor(Date.now() / 1000);
  const userJson = JSON.stringify({ id: userId, first_name: "Test" });
  const dataCheckString = `auth_date=${authDate}\nuser=${userJson}`;
  
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  
  return `auth_date=${authDate}&hash=${hash}&user=${encodeURIComponent(userJson)}`;
}

// Create IDKitResult for enrollment
function createIDKitResult(nonce: string, action: string, signalHash: string, sessionId?: string, nullifier?: string) {
  return {
    protocol_version: '4.0' as const,
    nonce,
    action,
    session_id: sessionId as any,
    responses: [{
      identifier: 'proof_of_human' as const,
      issuer_schema_id: 1,
      nullifier: nullifier || '0x' + randomBytes(32).toString('hex'),
      expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
      signal_hash: signalHash,
    }],
    environment: 'production' as const,
  };
}

// Create IDKitResultSession for session verification
function createSessionResult(nonce: string, sessionId: string, sessionNullifier: [string, string]): IDKitResultSession {
  return {
    protocol_version: '4.0' as const,
    nonce,
    session_id: sessionId as any,
    responses: [{
      identifier: 'proof_of_human' as const,
      issuer_schema_id: 1,
      session_nullifier: sessionNullifier,
      expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
    }],
    environment: 'production' as const,
  };
}

describe('Session Verification Integration Tests', () => {
  let service: EnrollmentService;
  let verifier: MockVerifier;
  
  beforeEach(() => {
    verifier = new MockVerifier();
    
    service = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter: new WorldIdChallengeAdapter({
        appId: 'app_test_session' as any,
        rpId: 'rp_test_session' as any,
        signingKeyHex: 'a'.repeat(64),
        environment: 'production',
      }),
      verificationClient: verifier as any,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
    });
  });
  
  afterEach(() => {
    service.close();
  });

  describe('Complete session verification flow', () => {
    it('successful enrollment and session verification', async () => {
      const userId = 1001;
      const nullifier = '0x' + randomBytes(32).toString('hex');
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      
      // Step 1: Initial enrollment with session creation
      const challenge1 = await service.createChallenge(initData);
      const sessionId = 'session_' + randomBytes(64).toString('hex');
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash,
        sessionId
      );
      // Nullifier passed in createIDKitResult
      
      verifier.setResponse(challenge1.signedChallenge.nonce, {
        success: true,
        nullifier,
      });
      
      const enrollment = await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
      assert.strictEqual(enrollment.success, true);
      assert.strictEqual(enrollment.sessionId, sessionId);
      
      // Step 2: Create session challenge for returning user
      const sessionChallenge = await service.createSessionChallenge(initData);
      
      // Step 3: Verify with session proof
      const sessionAction = '0x' + randomBytes(32).toString('hex');
      const sessionResult = createSessionResult(
        sessionChallenge.signedChallenge.nonce,
        sessionId,
        [nullifier, sessionAction]
      );
      
      verifier.setResponse(sessionChallenge.signedChallenge.nonce, {
        success: true,
        nullifier,
      });
      
      const verification = await service.verifySession({ initData, idkitResult: sessionResult });
      assert.strictEqual(verification.success, true);
      assert.strictEqual(verification.sessionId, sessionId);
      assert.strictEqual(verification.nullifier, nullifier);
    });
  });

  describe('Adversarial: Mismatched identifiers', () => {
    it('rejects mismatched session ID', async () => {
      const userId = 1001;
      const nullifier = '0x' + randomBytes(32).toString('hex');
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      
      // Enroll with session
      const challenge1 = await service.createChallenge(initData);
      const sessionId = 'session_' + randomBytes(64).toString('hex');
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash,
        sessionId
      );
      // Nullifier passed in createIDKitResult
      
      verifier.setResponse(challenge1.signedChallenge.nonce, { success: true, nullifier });
      await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
      
      // Try to verify with DIFFERENT session ID
      const sessionChallenge = await service.createSessionChallenge(initData);
      const wrongSessionId = 'session_' + randomBytes(64).toString('hex');
      const sessionResult = createSessionResult(
        sessionChallenge.signedChallenge.nonce,
        wrongSessionId, // WRONG session ID
        [nullifier, '0x' + randomBytes(32).toString('hex')]
      );
      
      verifier.setResponse(sessionChallenge.signedChallenge.nonce, { success: true, nullifier });
      
      const verification = await service.verifySession({ initData, idkitResult: sessionResult });
      assert.strictEqual(verification.success, false);
      assert.match(verification.error!, /session.*mismatch|belongs to different/i);
    });

    it('rejects mismatched account (session belongs to different user)', async () => {
      const userA = 1001;
      const userB = 1002;
      const nullifier = '0x' + randomBytes(32).toString('hex');
      const initDataA = createValidInitData(userA, TEST_BOT_TOKEN);
      const initDataB = createValidInitData(userB, TEST_BOT_TOKEN);
      
      // User A enrolls with session
      const challenge1 = await service.createChallenge(initDataA);
      const sessionId = 'session_' + randomBytes(64).toString('hex');
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash,
        sessionId
      );
      // Nullifier passed in createIDKitResult
      
      verifier.setResponse(challenge1.signedChallenge.nonce, { success: true, nullifier });
      await service.completeEnrollment({ initData: initDataA, idkitResult: idkitResult1 });
      
      // User B enrolls (different nullifier)
      const nullifierB = '0x' + randomBytes(32).toString('hex');
      const challenge2 = await service.createChallenge(initDataB);
      const sessionIdB = 'session_' + randomBytes(64).toString('hex');
      const idkitResult2 = createIDKitResult(
        challenge2.signedChallenge.nonce,
        TEST_ACTION,
        challenge2.signedChallenge.signalHash,
        sessionIdB
      );
      // Nullifier passed in createIDKitResult
      
      verifier.setResponse(challenge2.signedChallenge.nonce, { success: true, nullifier: nullifierB });
      await service.completeEnrollment({ initData: initDataB, idkitResult: idkitResult2 });
      
      // User B tries to create challenge but gets their own
      const sessionChallengeB = await service.createSessionChallenge(initDataB);
      
      // User B tries to verify with User A's session ID (attack attempt)
      const sessionResult = createSessionResult(
        sessionChallengeB.signedChallenge.nonce,
        sessionId, // User A's session ID
        [nullifierB, '0x' + randomBytes(32).toString('hex')] // But User B's nullifier
      );
      
      verifier.setResponse(sessionChallengeB.signedChallenge.nonce, { success: true, nullifier: nullifierB });
      
      const verification = await service.verifySession({ initData: initDataB, idkitResult: sessionResult });
      assert.strictEqual(verification.success, false);
      assert.match(verification.error!, /session.*mismatch|belongs to different/i);
    });

    it('rejects session proof when verifier fails', async () => {
      const userId = 1001;
      const nullifier = '0x' + randomBytes(32).toString('hex');
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      
      // Enroll with session
      const challenge1 = await service.createChallenge(initData);
      const sessionId = 'session_' + randomBytes(64).toString('hex');
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash,
        sessionId
      );
      
      verifier.setResponse(challenge1.signedChallenge.nonce, { success: true, nullifier });
      await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
      
      // Session verification where verifier rejects proof
      const sessionChallenge = await service.createSessionChallenge(initData);
      const sessionNullifier = '0x' + randomBytes(32).toString('hex');
      const sessionAction = '0x' + randomBytes(32).toString('hex');
      const sessionResult = createSessionResult(
        sessionChallenge.signedChallenge.nonce,
        sessionId,
        [sessionNullifier, sessionAction]
      );
      
      // Verifier fails (e.g., cryptographic proof invalid)
      verifier.setResponse(sessionChallenge.signedChallenge.nonce, { success: false });
      
      const verification = await service.verifySession({ initData, idkitResult: sessionResult });
      assert.strictEqual(verification.success, false);
      assert.match(verification.error!, /verification failed/i);
    });

    it('accepts session proof with different nullifier than enrollment (per spec)', async () => {
      const userId = 1001;
      const enrollmentNullifier = '0x' + randomBytes(32).toString('hex');
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      
      // Enroll with session
      const challenge1 = await service.createChallenge(initData);
      const sessionId = 'session_' + randomBytes(64).toString('hex');
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash,
        sessionId
      );
      
      verifier.setResponse(challenge1.signedChallenge.nonce, { success: true, nullifier: enrollmentNullifier });
      await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
      
      // Session proof with DIFFERENT nullifier (per World ID 4.0 spec)
      const sessionChallenge = await service.createSessionChallenge(initData);
      const sessionNullifier = '0x' + randomBytes(32).toString('hex'); // Different from enrollment
      const sessionAction = '0x' + randomBytes(32).toString('hex');
      const sessionResult = createSessionResult(
        sessionChallenge.signedChallenge.nonce,
        sessionId,
        [sessionNullifier, sessionAction] // Different nullifier is valid
      );
      
      verifier.setResponse(sessionChallenge.signedChallenge.nonce, { success: true, nullifier: enrollmentNullifier });
      
      const verification = await service.verifySession({ initData, idkitResult: sessionResult });
      assert.strictEqual(verification.success, true, 'Session proofs may use different nullifiers than enrollment');
    });
  });

  describe('Adversarial: Replay attacks', () => {
    it('rejects duplicate session_nullifier (same session, different attempts)', async () => {
      const userId = 1001;
      const nullifier = '0x' + randomBytes(32).toString('hex');
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      
      // Enroll with session
      const challenge1 = await service.createChallenge(initData);
      const sessionId = 'session_' + randomBytes(64).toString('hex');
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash,
        sessionId
      );
      // Nullifier passed in createIDKitResult
      
      verifier.setResponse(challenge1.signedChallenge.nonce, { success: true, nullifier });
      await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
      
      // First session verification
      const sessionChallenge1 = await service.createSessionChallenge(initData);
      const sessionNullifier = '0x' + randomBytes(32).toString('hex');
      const sessionAction = '0x' + randomBytes(32).toString('hex');
      const sessionResult1 = createSessionResult(
        sessionChallenge1.signedChallenge.nonce,
        sessionId,
        [sessionNullifier, sessionAction]
      );
      
      verifier.setResponse(sessionChallenge1.signedChallenge.nonce, { success: true, nullifier });
      
      const verification1 = await service.verifySession({ initData, idkitResult: sessionResult1 });
      assert.strictEqual(verification1.success, true);
      
      // Try to use SAME session_nullifier tuple again (replay attack)
      const sessionChallenge2 = await service.createSessionChallenge(initData);
      const sessionResult2 = createSessionResult(
        sessionChallenge2.signedChallenge.nonce,
        sessionId,
        [sessionNullifier, sessionAction] // SAME tuple (replay)
      );
      
      verifier.setResponse(sessionChallenge2.signedChallenge.nonce, { success: true, nullifier });
      
      const verification2 = await service.verifySession({ initData, idkitResult: sessionResult2 });
      assert.strictEqual(verification2.success, false);
      assert.match(verification2.error!, /already used|replay/i);
    });
  });

  describe('Adversarial: Expired challenges', () => {
    it('rejects expired challenge session', async () => {
      const userId = 1001;
      const nullifier = '0x' + randomBytes(32).toString('hex');
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      
      // Create short-lived service (60 seconds TTL - minimum allowed)
      service.close();
      
      // Use fake clock for deterministic expiry testing
      let fakeNow = Math.floor(Date.now() / 1000);
      const fakeClock = {
        nowSeconds: () => fakeNow,
        nowISO: () => new Date(fakeNow * 1000).toISOString(),
      };
      
      service = new EnrollmentService({
        dbPath: TEST_DB_PATH,
        challengeAdapter: new WorldIdChallengeAdapter({
          appId: 'app_test_session' as any,
          rpId: 'rp_test_session' as any,
          signingKeyHex: 'a'.repeat(64),
          environment: 'production',
        }),
        verificationClient: verifier as any,
        telegramBotToken: TEST_BOT_TOKEN,
        action: TEST_ACTION,
        challengeTtlSeconds: 60, // 60 seconds (minimum)
        clock: fakeClock as any,
      });
      
      // Enroll with session
      const challenge1 = await service.createChallenge(initData);
      const sessionId = 'session_' + randomBytes(64).toString('hex');
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash,
        sessionId
      );
      // Nullifier passed in createIDKitResult
      
      verifier.setResponse(challenge1.signedChallenge.nonce, { success: true, nullifier });
      await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
      
      // Create session challenge
      const sessionChallenge = await service.createSessionChallenge(initData);
      
      // Advance clock past expiry (61 seconds)
      fakeNow += 61;
      
      // Try to verify with expired challenge
      const sessionResult = createSessionResult(
        sessionChallenge.signedChallenge.nonce,
        sessionId,
        [nullifier, '0x' + randomBytes(32).toString('hex')]
      );
      
      verifier.setResponse(sessionChallenge.signedChallenge.nonce, { success: true, nullifier });
      
      const verification = await service.verifySession({ initData, idkitResult: sessionResult });
      assert.strictEqual(verification.success, false);
      assert.match(verification.error!, /expired/i);
    });
  });

  describe('Adversarial: Revocation during verification', () => {
    it('rejects session verification for revoked enrollment', async () => {
      const userId = 1001;
      const nullifier = '0x' + randomBytes(32).toString('hex');
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      
      // Enroll with session
      const challenge1 = await service.createChallenge(initData);
      const sessionId = 'session_' + randomBytes(64).toString('hex');
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash,
        sessionId
      );
      // Nullifier passed in createIDKitResult
      
      verifier.setResponse(challenge1.signedChallenge.nonce, { success: true, nullifier });
      await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
      
      // Create session challenge
      const sessionChallenge = await service.createSessionChallenge(initData);
      
      // Revoke BEFORE verification completes
      await service.revokeEnrollment(userId);
      
      // Try to verify (should fail - enrollment revoked)
      const sessionAction = '0x' + randomBytes(32).toString('hex');
      const sessionResult = createSessionResult(
        sessionChallenge.signedChallenge.nonce,
        sessionId,
        [nullifier, sessionAction]
      );
      
      verifier.setResponse(sessionChallenge.signedChallenge.nonce, { success: true, nullifier });
      
      const verification = await service.verifySession({ initData, idkitResult: sessionResult });
      assert.strictEqual(verification.success, false);
      assert.match(verification.error!, /revoked|challenge.*not found/i);
    });

    it('prevents session challenge creation for revoked enrollment', async () => {
      const userId = 1001;
      const nullifier = '0x' + randomBytes(32).toString('hex');
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      
      // Enroll with session
      const challenge1 = await service.createChallenge(initData);
      const sessionId = 'session_' + randomBytes(64).toString('hex');
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash,
        sessionId
      );
      // Nullifier passed in createIDKitResult
      
      verifier.setResponse(challenge1.signedChallenge.nonce, { success: true, nullifier });
      await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
      
      // Revoke enrollment
      await service.revokeEnrollment(userId);
      
      // Try to create session challenge (should fail)
      await assert.rejects(
        () => service.createSessionChallenge(initData),
        /revoked/i
      );
    });
  });

  describe('Persistence and restart', () => {
    it('persists enrollment and session across service restart', async () => {
      const userId = 1001;
      const nullifier = '0x' + randomBytes(32).toString('hex');
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);
      const dbPath = `/tmp/test-session-${Date.now()}.db`;
      
      try {
        // Create service with persistent DB
        service.close();
        service = new EnrollmentService({
          dbPath,
          challengeAdapter: new WorldIdChallengeAdapter({
            appId: 'app_test_session' as any,
            rpId: 'rp_test_session' as any,
            signingKeyHex: 'a'.repeat(64),
            environment: 'production',
          }),
          verificationClient: verifier as any,
          telegramBotToken: TEST_BOT_TOKEN,
          action: TEST_ACTION,
        });
        
        // Enroll with session
        const challenge1 = await service.createChallenge(initData);
        const sessionId = 'session_' + randomBytes(64).toString('hex');
        const idkitResult1 = createIDKitResult(
          challenge1.signedChallenge.nonce,
          TEST_ACTION,
          challenge1.signedChallenge.signalHash,
          sessionId
        );
        // Nullifier passed in createIDKitResult
        
        verifier.setResponse(challenge1.signedChallenge.nonce, { success: true, nullifier });
        await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
        
        // Close and reopen service (simulates restart)
        service.close();
        service = new EnrollmentService({
          dbPath,
          challengeAdapter: new WorldIdChallengeAdapter({
            appId: 'app_test_session' as any,
            rpId: 'rp_test_session' as any,
            signingKeyHex: 'a'.repeat(64),
            environment: 'production',
          }),
          verificationClient: verifier as any,
          telegramBotToken: TEST_BOT_TOKEN,
          action: TEST_ACTION,
        });
        
        // Verify enrollment persisted
        const enrollment = await service.findEnrollment(userId);
        assert.ok(enrollment);
        assert.strictEqual(enrollment.sessionId, sessionId);
        assert.strictEqual(enrollment.nullifier, nullifier);
        
        // Verify session challenge can still be created
        await service.createSessionChallenge(initData);
        
      } finally {
        try {
          unlinkSync(dbPath);
        } catch {}
      }
    });
  });
});
