/**
 * Session proof verifier binding tests.
 * 
 * Tests whether verifier correctly handles session proofs and validates session_id binding.
 * 
 * FINDINGS TO DOCUMENT:
 * - Does verifier distinguish session vs uniqueness proofs?
 * - Is session_id passed to API and validated?
 * - Does API cryptographically bind session_id in proof?
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import type { IDKitResultSession, ExpectedVerificationContext } from './worldid-types.js';

describe('Session Proof Verifier Binding', () => {
  it('DOCUMENTS: verifier rejects session proofs due to missing action field', async () => {
    const verifier = new WorldIdHttpVerifier({
      appId: 'app_test123',
      rpId: 'rp_test456',
      environment: 'production',
      baseUrlOverride: 'http://localhost:9999', // Will not be called
    });

    // Valid session proof structure per World ID 4.0 spec
    const sessionProof: IDKitResultSession = {
      protocol_version: '4.0',
      nonce: '0xabc123',
      session_id: 'session_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      responses: [{
        identifier: 'proof_of_human',
        proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
        session_nullifier: ['0xaaa', '0xbbb'],
        issuer_schema_id: 1,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'production',
    };

    const expectedContext: ExpectedVerificationContext = {
      action: 'test-action', // Session proofs don't have action!
      nonce: '0xabc123',
      signalHash: '0x0',
    };

    const result = await verifier.verify(sessionProof as any, expectedContext);

    // DOCUMENTS: Verifier will reject because idkitResult.action is undefined
    assert.equal(result.success, false);
    assert.match(result.error || '', /Action mismatch|undefined/);
  });

  it('DOCUMENTS: verifier expects response.nullifier but session has session_nullifier', async () => {
    const verifier = new WorldIdHttpVerifier({
      appId: 'app_test123',
      rpId: 'rp_test456',
      environment: 'production',
      baseUrlOverride: 'http://localhost:9999',
    });

    const sessionProof: IDKitResultSession = {
      protocol_version: '4.0',
      nonce: '0xabc123',
      session_id: 'session_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      responses: [{
        identifier: 'proof_of_human',
        proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
        session_nullifier: ['0xaaa', '0xbbb'], // NOT nullifier field
        issuer_schema_id: 1,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'production',
    };

    // Even if we bypass action check, nullifier check will fail
    // because session responses have session_nullifier, not nullifier

    // DOCUMENTS: Verifier line 172-177 checks response.nullifier
    // but session responses don't have that field
  });

  it('INFERENCE: session_id must be in API request per spec', () => {
    // From API spec (https://docs.world.org/api-reference/developer-portal/verify):
    // VerifyV4SessionProofRequest REQUIRES:
    // - protocol_version: '4.0'
    // - nonce: string
    // - session_id: string  <-- REQUIRED field
    // - responses: array
    
    // Current verifier forwards idkitResult as-is (line 180-181):
    // const verifyRequest: V4VerifyRequest = idkitResult;
    
    // So session_id IS included in API request if we fix validation

    // QUESTION: Does API cryptographically verify session_id binding?
    // - API spec shows session_id as required field
    // - Proof array contains 5 elements (Groth16 proof + Merkle root)
    // - Circuit must take session_id as public input for binding
    
    // UNKNOWN: Cannot determine circuit inputs from API spec alone
    // Need: Circuit source code or protocol documentation
  });

  it('FACT: API spec requires session_id field in request', () => {
    // From https://docs.world.org/api-reference/developer-portal/verify
    // VerifyV4SessionProofRequest schema:
    
    const apiSpec = {
      required: ['protocol_version', 'nonce', 'session_id', 'responses'],
      properties: {
        session_id: {
          type: 'string',
          description: 'Opaque session ID in the format session_<128 hex characters>',
          example: 'session_5f3a9c2e...8d1b0a',
        },
      },
    };

    // FACT: session_id is required in API request
    assert.ok(apiSpec.required.includes('session_id'));
  });

  it('FACT: Verifier forwards idkitResult as-is to API', () => {
    // From worldid-verifier-http.ts line 180-181:
    // const verifyRequest: V4VerifyRequest = idkitResult;
    // 
    // This means session_id from idkitResult IS sent to API
    
    // FACT: If we fix validation to allow session proofs,
    // session_id WILL be in API request
  });

  it('UNKNOWN: Whether circuit cryptographically binds session_id', () => {
    // Cannot determine from available documentation whether:
    // 1. session_id is a public input to ZK circuit
    // 2. Proof binds to specific session_id value
    // 3. API validates session_id against proof
    
    // Would need:
    // - Circuit source code
    // - Protocol specs showing circuit public inputs
    // - Or test with real World App proof
    
    // Current implementation: 
    // - We check session_id matches enrollment BEFORE calling verifier
    // - If verifier doesn't validate session_id, attacker could:
    //   a) Get legitimate proof for their session
    //   b) Submit with victim's session_id
    //   c) Bypass if no cryptographic binding
    
    // Mitigation:
    // - Checking session_id before verifier is safe IF verifier validates it
    // - If verifier doesn't validate, we need different approach
  });
});
