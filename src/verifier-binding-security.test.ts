/**
 * Verifier Binding Security Tests
 * 
 * Restored coverage from deleted session-verifier-binding.test.ts
 * Tests security invariants around session ID and mode/shape validation.
 * 
 * Critical security checks:
 * 1. Session ID must match saved enrollment (immutable binding)
 * 2. Mode/shape mismatch rejected (server expectedMode drives verification)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import type { IDKitResult, IDKitResultSession, ExpectedVerificationContext } from './worldid-types.js';

describe('Verifier Binding Security', () => {
  describe('Session ID mismatch detection', () => {
    it('rejects session proof with wrong session_id vs expectedContext', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: 'app_test123',
        rpId: 'rp_test456',
        environment: 'production',
        baseUrlOverride: 'http://localhost:9999', // Will not be called
      });

      // Valid session proof structure
      const sessionProof: IDKitResultSession = {
        protocol_version: '4.0',
        nonce: '0xabc123',
        session_id: 'session_actual1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        responses: [{
          identifier: 'proof_of_human',
          proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
          session_nullifier: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: null,
        nonce: '0xabc123',
        signalHash: null,
        expectedMode: 'session',
        sessionId: 'session_expected_DIFFERENT567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      };

      const result = await verifier.verify(sessionProof as any, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error || '', /Session ID mismatch/i);
    });

    it('accepts session proof with matching session_id', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: 'app_test123',
        rpId: 'rp_test456',
        environment: 'production',
        baseUrlOverride: 'http://localhost:9999',
      });

      const matchingSessionId = 'session_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const sessionProof: IDKitResultSession = {
        protocol_version: '4.0',
        nonce: '0xabc123',
        session_id: matchingSessionId,
        responses: [{
          identifier: 'proof_of_human',
          proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
          session_nullifier: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: null,
        nonce: '0xabc123',
        signalHash: null,
        expectedMode: 'session',
        sessionId: matchingSessionId,
      };

      // Will fail at HTTP level (baseUrlOverride invalid), but session_id validation passes
      const result = await verifier.verify(sessionProof as any, expectedContext);
      
      // Should fail on HTTP error, NOT on session ID mismatch
      assert.equal(result.success, false);
      assert.doesNotMatch(result.error || '', /Session ID mismatch/i);
    });
  });

  describe('Mode/shape mismatch detection', () => {
    it('rejects uniqueness proof when expectedMode is session', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: 'app_test123',
        rpId: 'rp_test456',
        environment: 'production',
        baseUrlOverride: 'http://localhost:9999',
      });

      // Client sends uniqueness proof (has action field)
      const uniquenessProof: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0xabc123',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef',
          proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
          nullifier: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400,
        }],
        environment: 'production',
      };

      // Server expects session proof
      const expectedContext: ExpectedVerificationContext = {
        action: null,
        nonce: '0xabc123',
        signalHash: null,
        expectedMode: 'session', // Server expects session proof
      };

      const result = await verifier.verify(uniquenessProof, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error || '', /Proof shape mismatch.*expected session proof/i);
    });

    it('rejects session proof when expectedMode is uniqueness', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: 'app_test123',
        rpId: 'rp_test456',
        environment: 'production',
        baseUrlOverride: 'http://localhost:9999',
      });

      // Client sends session proof (has session_id, no action)
      const sessionProof: IDKitResultSession = {
        protocol_version: '4.0',
        nonce: '0xabc123',
        session_id: 'session_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        responses: [{
          identifier: 'proof_of_human',
          proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
          session_nullifier: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400,
        }],
        environment: 'production',
      };

      // Server expects uniqueness proof
      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0xabc123',
        signalHash: '0xabcdef',
        expectedMode: 'uniqueness', // Server expects uniqueness proof
      };

      const result = await verifier.verify(sessionProof as any, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error || '', /Proof shape mismatch.*expected uniqueness proof/i);
    });

    it('rejects proof with missing expectedMode (fail-closed)', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: 'app_test123',
        rpId: 'rp_test456',
        environment: 'production',
        baseUrlOverride: 'http://localhost:9999',
      });

      const uniquenessProof: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0xabc123',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef',
          proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
          nullifier: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          issuer_schema_id: 1,
          expires_at_min: Math.floor(Date.now() / 1000) + 86400,
        }],
        environment: 'production',
      };

      // Missing expectedMode - MUST fail closed
      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0xabc123',
        signalHash: '0xabcdef',
      } as any; // Type system would catch this, but runtime must also reject

      const result = await verifier.verify(uniquenessProof, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error || '', /expectedMode required/i);
    });
  });
});
