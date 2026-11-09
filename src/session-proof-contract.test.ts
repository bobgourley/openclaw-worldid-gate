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
import Database from 'better-sqlite3';
import { EnrollmentService } from './enrollment-service-production.js';
import { FakeClock } from './clock.js';
import type { VerifySessionRequest } from './types.js';

describe('Session Proof Contract (World ID 4.0 Specs)', () => {
  it('accepts session proof with different nullifier than enrollment (per spec)', async () => {
    const testDbPath = `/tmp/session-proof-test-${Date.now()}.db`;
    const clock = new FakeClock();
    const adapter = {
      createChallenge: async () => ({
        nonce: 'test-nonce',
        signalHash: 'test-signal',
      }),
    } as any;
    const verifier = {
      verify: async () => ({
        success: true,
        nullifier: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        issuerSchemaId: 1,
        expiresAtMin: clock.nowSeconds() + 86400,
      }),
    } as any;
    
    const service = new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter: adapter,
      verificationClient: verifier,
      telegramBotToken: '123456:ABC-DEF',
      action: 'test-action',
      clock,
    });

    // Create enrollment with enrollment nullifier
    const enrollmentNullifier = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const sessionId = 'session_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    
    db.prepare(`
      INSERT INTO enrollments (
        telegram_user_id, action, nullifier, enrolled_at, enrolled_at_iso,
        expires_at, expires_at_iso, session_id, protocol_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      123456,
      'test-action',
      enrollmentNullifier,
      Math.floor(Date.now() / 1000),
      new Date().toISOString(),
      Math.floor(Date.now() / 1000) + 86400 * 30,
      new Date(Date.now() + 86400 * 30 * 1000).toISOString(),
      sessionId,
      'v2'
    );

    db.prepare(`
      INSERT INTO generation_fences (telegram_user_id, action, generation, updated_at, updated_at_iso)
      VALUES (?, ?, ?, ?, ?)
    `).run(123456, 'test-action', 1, Math.floor(Date.now() / 1000), new Date().toISOString());

    // Create challenge
    const challenge = await service.createSessionChallenge('query_id=test&user={"id":123456}', {});
    if (!challenge.success) throw new Error('Challenge creation failed');

    // Mock verifier that accepts proofs
    (service as any).verificationClient = {
      verify: async () => ({
        success: true,
        identifier: 'proof_of_human',
        nullifier: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', // Different from enrollment
        issuerSchemaId: 1,
        expiresAt: Date.now() + 86400 * 365 * 3 * 1000,
      }),
    };

    // Verify session with DIFFERENT nullifier (per World ID 4.0 spec)
    const sessionNullifier = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'; // Different from enrollment
    const sessionAction = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'; // Randomized action

    const request: VerifySessionRequest = {
      initData: 'query_id=test&user={"id":123456}',
      idkitResult: {
        protocol_version: '4.0',
        nonce: challenge.challenge.signedChallenge.nonce,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human',
          proof: ['1', '2', '3', '4', '5'],
          session_nullifier: [sessionNullifier, sessionAction],
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400 * 365 * 3,
        }],
        environment: 'production',
      },
    };

    const result = await service.verifySession(request);
    assert.equal(result.success, true, 'Session proof with different nullifier should succeed per World ID 4.0 spec');
  });

  it('accepts session proof with randomized action (per spec)', async () => {
    const db = new Database(':memory:');
    const clock = new FakeClock();
    
    const service = new EnrollmentService({
      db,
      action: 'test-action',
      appId: 'app_test',
      clock,
      requireProofOfHuman: true,
    });

    // Create enrollment
    const enrollmentNullifier = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const sessionId = 'session_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    
    db.prepare(`
      INSERT INTO enrollments (
        telegram_user_id, action, nullifier, enrolled_at, enrolled_at_iso,
        expires_at, expires_at_iso, session_id, protocol_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      123456,
      'test-action',
      enrollmentNullifier,
      Math.floor(Date.now() / 1000),
      new Date().toISOString(),
      Math.floor(Date.now() / 1000) + 86400 * 30,
      new Date(Date.now() + 86400 * 30 * 1000).toISOString(),
      sessionId,
      'v2'
    );

    db.prepare(`
      INSERT INTO generation_fences (telegram_user_id, action, generation, updated_at, updated_at_iso)
      VALUES (?, ?, ?, ?, ?)
    `).run(123456, 'test-action', 1, Math.floor(Date.now() / 1000), new Date().toISOString());

    // Create challenge
    const challenge = await service.createSessionChallenge('query_id=test&user={"id":123456}', {});
    if (!challenge.success) throw new Error('Challenge creation failed');

    // Mock verifier
    (service as any).verificationClient = {
      verify: async () => ({
        success: true,
        identifier: 'proof_of_human',
        nullifier: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        issuerSchemaId: 1,
        expiresAt: Date.now() + 86400 * 365 * 3 * 1000,
      }),
    };

    // Verify session with randomized action (NOT enrollment action)
    const sessionNullifier = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const randomizedAction = '0xRANDOMIZEDACTION11111111111111111111111111111111111111111111'; // NOT 'test-action'

    const request: VerifySessionRequest = {
      initData: 'query_id=test&user={"id":123456}',
      idkitResult: {
        protocol_version: '4.0',
        nonce: challenge.challenge.signedChallenge.nonce,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human',
          proof: ['1', '2', '3', '4', '5'],
          session_nullifier: [sessionNullifier, randomizedAction],
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400 * 365 * 3,
        }],
        environment: 'production',
      },
    };

    const result = await service.verifySession(request);
    assert.equal(result.success, true, 'Session proof with randomized action should succeed per World ID 4.0 spec');
  });

  it('rejects replayed session nullifier tuple', async () => {
    const db = new Database(':memory:');
    const clock = new FakeClock();
    
    const service = new EnrollmentService({
      db,
      action: 'test-action',
      appId: 'app_test',
      clock,
      requireProofOfHuman: true,
    });

    // Create enrollment
    const enrollmentNullifier = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const sessionId = 'session_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    
    db.prepare(`
      INSERT INTO enrollments (
        telegram_user_id, action, nullifier, enrolled_at, enrolled_at_iso,
        expires_at, expires_at_iso, session_id, protocol_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      123456,
      'test-action',
      enrollmentNullifier,
      Math.floor(Date.now() / 1000),
      new Date().toISOString(),
      Math.floor(Date.now() / 1000) + 86400 * 30,
      new Date(Date.now() + 86400 * 30 * 1000).toISOString(),
      sessionId,
      'v2'
    );

    db.prepare(`
      INSERT INTO generation_fences (telegram_user_id, action, generation, updated_at, updated_at_iso)
      VALUES (?, ?, ?, ?, ?)
    `).run(123456, 'test-action', 1, Math.floor(Date.now() / 1000), new Date().toISOString());

    // Mock verifier
    (service as any).verificationClient = {
      verify: async () => ({
        success: true,
        identifier: 'proof_of_human',
        nullifier: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        issuerSchemaId: 1,
        expiresAt: Date.now() + 86400 * 365 * 3 * 1000,
      }),
    };

    const sessionNullifier = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const randomizedAction = '0xRANDOMIZEDACTION11111111111111111111111111111111111111111111';

    // First verification
    const challenge1 = await service.createSessionChallenge('query_id=test&user={"id":123456}', {});
    if (!challenge1.success) throw new Error('Challenge 1 creation failed');

    const request1: VerifySessionRequest = {
      initData: 'query_id=test&user={"id":123456}',
      idkitResult: {
        protocol_version: '4.0',
        nonce: challenge1.challenge.signedChallenge.nonce,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human',
          proof: ['1', '2', '3', '4', '5'],
          session_nullifier: [sessionNullifier, randomizedAction],
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400 * 365 * 3,
        }],
        environment: 'production',
      },
    };

    const result1 = await service.verifySession(request1);
    assert.equal(result1.success, true, 'First session proof should succeed');

    // Second verification with SAME tuple (replay attack)
    const challenge2 = await service.createSessionChallenge('query_id=test2&user={"id":123456}', {});
    if (!challenge2.success) throw new Error('Challenge 2 creation failed');

    const request2: VerifySessionRequest = {
      initData: 'query_id=test2&user={"id":123456}',
      idkitResult: {
        protocol_version: '4.0',
        nonce: challenge2.challenge.signedChallenge.nonce,
        session_id: sessionId,
        responses: [{
          identifier: 'proof_of_human',
          proof: ['1', '2', '3', '4', '5'],
          session_nullifier: [sessionNullifier, randomizedAction], // SAME tuple
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400 * 365 * 3,
        }],
        environment: 'production',
      },
    };

    await assert.rejects(
      async () => await service.verifySession(request2),
      /Session nullifier already used/,
      'Second session proof with same tuple should be rejected (replay protection)'
    );
  });
});
