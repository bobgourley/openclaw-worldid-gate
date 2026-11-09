/**
 * Session proof contract tests - verify correct implementation per World ID 4.0 specs.
 * 
 * Tests that session nullifiers and actions are handled correctly according to:
 * https://worldcoin.github.io/world-id-protocol/world-id-4-specs/
 * 
 * Key findings from official documentation:
 * - "Session Proofs use a randomized `action` as circuit input. This randomized `action` 
 *    ensures the circuit's nullifier output is unique per proof, preserving the one-time use property."
 * - Session nullifiers are DIFFERENT from enrollment nullifiers
 * - Session actions are RANDOMIZED (not the enrollment action)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import { FakeClock } from './clock.js';
import type { VerifySessionRequest } from './types.js';
import { createHmac } from 'node:crypto';

const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const TEST_APP_ID = 'app_test_session_proof' as `app_${string}`;
const TEST_RP_ID = 'rp_test_session' as `rp_${string}`;
const TEST_SIGNING_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_ACTION = 'test-session-contract';

// Create valid Telegram initData
function createValidInitData(userId: number, botToken: string): string {
  const authDate = Math.floor(Date.now() / 1000);
  const userJson = JSON.stringify({ id: userId, first_name: "Test" });
  const dataCheckString = `auth_date=${authDate}\nuser=${userJson}`;
  
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  
  return `auth_date=${authDate}&hash=${hash}&user=${encodeURIComponent(userJson)}`;
}

// Stub fetch for WorldIdHttpVerifier (returns v4 API format)
function createStubFetch(responses: Map<string, any>) {
  return async (url: string, options: any) => {
    const body = JSON.parse(options.body);
    const key = `${body.nonce || 'default'}`;
    const mockResult = responses.get(key);
    
    if (!mockResult || !mockResult.success) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: false, error: 'Mock verification failed' }),
      } as any;
    }
    
    // Return v4 API format
    const v4Response = {
      success: true,
      results: [{
        identifier: 'proof_of_human',
        nullifier: mockResult.nullifier,
        issuer_schema_id: mockResult.issuer_schema_id || 1,
        expires_at_min: mockResult.expires_at_min,
      }],
      environment: 'staging',
    };
    
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(v4Response),
    } as any;
  };
}

describe('Session Proof Contract (World ID 4.0 Specs)', () => {
  it('accepts session proof with different nullifier than enrollment (per spec)', async () => {
    const testDbPath = `/tmp/session-proof-test-${Date.now()}-${Math.random()}.db`;
    const clock = new FakeClock();
    const userId = 100001; // Unique per test
    
    const enrollmentNullifier = '0x' + 'A'.repeat(64);
    const sessionNullifier = '0x' + 'C'.repeat(64);
    const sessionAction = '0x' + 'D'.repeat(64);
    const sessionId = 'session_' + '1'.repeat(128);
    
    const responses = new Map();
    
    // Create adapter
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      environment: 'staging',
    });
    
    // Create verifier with stubbed fetch
    const verifier = new WorldIdHttpVerifier({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      environment: 'staging',
      fetchFn: createStubFetch(responses),
    });
    
    const service = new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter: adapter,
      verificationClient: verifier,
      telegramBotToken: BOT_TOKEN,
      action: TEST_ACTION,
      clock,
    });
    
    const initData = createValidInitData(userId, BOT_TOKEN);
    
    // Step 1: Enrollment with session creation
    const enrollChallenge = await service.createChallenge(initData);
    assert.ok(enrollChallenge.signedChallenge, 'Enrollment challenge should return signed challenge');
    assert.ok(enrollChallenge.signedChallenge.nonce, 'Challenge should have nonce');
    
    responses.set(enrollChallenge.signedChallenge.nonce, {
      success: true,
      nullifier: enrollmentNullifier,
      issuer_schema_id: 1,
      expires_at_min: clock.nowSeconds() + 86400 * 30,
    });
    
    const enrollmentRequest = {
      initData,
      idkitResult: {
        protocol_version: '4.0' as const,
        nonce: enrollChallenge.signedChallenge.nonce,
        action: TEST_ACTION,
        signal_hash: enrollChallenge.signedChallenge.signalHash,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human' as const,
          issuer_schema_id: 1,
          nullifier: enrollmentNullifier,
          proof: ['1', '2', '3', '4', '5'],
          expires_at_min: clock.nowSeconds() + 86400 * 30,
        }],
        environment: 'staging' as const,
      },
    };
    
    const enrollResult = await service.completeEnrollment(enrollmentRequest);
    if (!enrollResult.success) {
      throw new Error(`Enrollment failed: ${enrollResult.error || 'unknown error'}`);
    }
    assert.equal(enrollResult.sessionId, sessionId, 'Session ID should be captured');
    
    // Step 2: Session verification with DIFFERENT nullifier
    const sessionChallenge = await service.createSessionChallenge(initData);
    assert.ok(sessionChallenge.signedChallenge, 'Session challenge should return signed challenge');
    
    responses.set(sessionChallenge.signedChallenge.nonce, {
      success: true,
      nullifier: sessionNullifier, // Different from enrollment
      issuer_schema_id: 1,
      expires_at_min: clock.nowSeconds() + 86400,
    });
    
    const sessionRequest: VerifySessionRequest = {
      initData,
      idkitResult: {
        protocol_version: '4.0' as const,
        nonce: sessionChallenge.signedChallenge.nonce,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human' as const,
          proof: ['1', '2', '3', '4', '5'],
          session_nullifier: [sessionNullifier, sessionAction],
          issuer_schema_id: 1,
          expires_at_min: clock.nowSeconds() + 86400 * 365 * 3,
        }],
        environment: 'staging' as const,
      },
    };
    
    const result = await service.verifySession(sessionRequest);
    assert.equal(result.success, true, 'Session proof with different nullifier should succeed per World ID 4.0 spec');
    
    service.close();
  });

  it('accepts session proof with randomized action (per spec)', async () => {
    const testDbPath = `/tmp/session-proof-test-${Date.now()}-${Math.random()}.db`;
    const clock = new FakeClock();
    const userId = 100002; // Unique per test
    
    const enrollmentNullifier = '0x' + 'B'.repeat(64);
    const sessionNullifier = '0x' + 'E'.repeat(64);
    const randomizedAction = '0x' + '1'.repeat(64); // NOT the enrollment action
    const sessionId = 'session_' + '2'.repeat(128);
    
    const responses = new Map();
    
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      environment: 'staging',
    });
    
    const verifier = new WorldIdHttpVerifier({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      environment: 'staging',
      fetchFn: createStubFetch(responses),
    });
    
    const service = new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter: adapter,
      verificationClient: verifier,
      telegramBotToken: BOT_TOKEN,
      action: TEST_ACTION,
      clock,
    });
    
    const initData = createValidInitData(userId, BOT_TOKEN);
    
    // Enrollment
    const enrollChallenge = await service.createChallenge(initData);
    responses.set(enrollChallenge.signedChallenge.nonce, {
      success: true,
      nullifier: enrollmentNullifier,
      issuer_schema_id: 1,
      expires_at_min: clock.nowSeconds() + 86400 * 30,
    });
    
    await service.completeEnrollment({
      initData,
      idkitResult: {
        protocol_version: '4.0' as const,
        nonce: enrollChallenge.signedChallenge.nonce,
        action: TEST_ACTION,
        signal_hash: enrollChallenge.signedChallenge.signalHash,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human' as const,
          issuer_schema_id: 1,
          nullifier: enrollmentNullifier,
          proof: ['1', '2', '3', '4', '5'],
          expires_at_min: clock.nowSeconds() + 86400 * 30,
        }],
        environment: 'staging' as const,
      },
    });
    
    // Session verification with randomized action
    const sessionChallenge = await service.createSessionChallenge(initData);
    responses.set(sessionChallenge.signedChallenge.nonce, {
      success: true,
      nullifier: sessionNullifier,
      issuer_schema_id: 1,
      expires_at_min: clock.nowSeconds() + 86400,
    });
    
    const sessionRequest: VerifySessionRequest = {
      initData,
      idkitResult: {
        protocol_version: '4.0' as const,
        nonce: sessionChallenge.signedChallenge.nonce,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human' as const,
          proof: ['1', '2', '3', '4', '5'],
          session_nullifier: [sessionNullifier, randomizedAction], // Randomized action per spec
          issuer_schema_id: 1,
          expires_at_min: clock.nowSeconds() + 86400 * 365 * 3,
        }],
        environment: 'staging' as const,
      },
    };
    
    const result = await service.verifySession(sessionRequest);
    assert.equal(result.success, true, 'Session proof with randomized action should succeed per World ID 4.0 spec');
    
    service.close();
  });

  it('rejects replayed session nullifier tuple', async () => {
    const testDbPath = `/tmp/session-proof-test-${Date.now()}-${Math.random()}.db`;
    const clock = new FakeClock();
    const userId = 100003; // Unique per test
    
    const enrollmentNullifier = '0x' + 'F'.repeat(64);
    const sessionNullifier = '0x' + '9'.repeat(64);
    const sessionAction = '0x' + '2'.repeat(64);
    const sessionId = 'session_' + '3'.repeat(128);
    
    const responses = new Map();
    
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      environment: 'staging',
    });
    
    const verifier = new WorldIdHttpVerifier({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      environment: 'staging',
      fetchFn: createStubFetch(responses),
    });
    
    const service = new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter: adapter,
      verificationClient: verifier,
      telegramBotToken: BOT_TOKEN,
      action: TEST_ACTION,
      clock,
    });
    
    const initData = createValidInitData(userId, BOT_TOKEN);
    
    // Enrollment
    const enrollChallenge = await service.createChallenge(initData);
    responses.set(enrollChallenge.signedChallenge.nonce, {
      success: true,
      nullifier: enrollmentNullifier,
      issuer_schema_id: 1,
      expires_at_min: clock.nowSeconds() + 86400 * 30,
    });
    
    await service.completeEnrollment({
      initData,
      idkitResult: {
        protocol_version: '4.0' as const,
        nonce: enrollChallenge.signedChallenge.nonce,
        action: TEST_ACTION,
        signal_hash: enrollChallenge.signedChallenge.signalHash,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human' as const,
          issuer_schema_id: 1,
          nullifier: enrollmentNullifier,
          proof: ['1', '2', '3', '4', '5'],
          expires_at_min: clock.nowSeconds() + 86400 * 30,
        }],
        environment: 'staging' as const,
      },
    });
    
    // First session verification
    const sessionChallenge1 = await service.createSessionChallenge(initData);
    responses.set(sessionChallenge1.signedChallenge.nonce, {
      success: true,
      nullifier: sessionNullifier,
      issuer_schema_id: 1,
      expires_at_min: clock.nowSeconds() + 86400,
    });
    
    const sessionRequest1: VerifySessionRequest = {
      initData,
      idkitResult: {
        protocol_version: '4.0' as const,
        nonce: sessionChallenge1.signedChallenge.nonce,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human' as const,
          proof: ['1', '2', '3', '4', '5'],
          session_nullifier: [sessionNullifier, sessionAction],
          issuer_schema_id: 1,
          expires_at_min: clock.nowSeconds() + 86400 * 365 * 3,
        }],
        environment: 'staging' as const,
      },
    };
    
    const result1 = await service.verifySession(sessionRequest1);
    assert.equal(result1.success, true, 'First session verification should succeed');
    
    // Second verification with SAME session_nullifier tuple - should fail
    const sessionChallenge2 = await service.createSessionChallenge(initData);
    responses.set(sessionChallenge2.signedChallenge.nonce, {
      success: true,
      nullifier: sessionNullifier,
      issuer_schema_id: 1,
      expires_at_min: clock.nowSeconds() + 86400,
    });
    
    const sessionRequest2: VerifySessionRequest = {
      initData,
      idkitResult: {
        protocol_version: '4.0' as const,
        nonce: sessionChallenge2.signedChallenge.nonce,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human' as const,
          proof: ['1', '2', '3', '4', '5'],
          session_nullifier: [sessionNullifier, sessionAction], // SAME tuple
          issuer_schema_id: 1,
          expires_at_min: clock.nowSeconds() + 86400 * 365 * 3,
        }],
        environment: 'staging' as const,
      },
    };
    
    const result2 = await service.verifySession(sessionRequest2);
    assert.equal(result2.success, false, 'Replayed session nullifier tuple should be rejected');
    
    service.close();
  });
});
