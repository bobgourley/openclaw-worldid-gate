/**
 * Test that verifier rejects missing expectedMode (fail-closed).
 * 
 * Per reviewer: "missing expectedMode must fail closed"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import type { IDKitResult } from './worldid-types.js';

describe('Verifier expectedMode Required', () => {
  it('rejects missing expectedMode (fail-closed)', async () => {
    const verifier = new WorldIdHttpVerifier({
      appId: 'app_test',
      rpId: 'rp_test',
      environment: 'production',
      baseUrlOverride: 'http://stub',
    });

    const proof: IDKitResult = {
      protocol_version: '4.0',
      nonce: '0xtest',
      action: 'test-action',
      responses: [{
        identifier: 'proof_of_human',
        proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
        nullifier: '0x0000000000000000000000000000000000000000000000000000000000000001',
        signal_hash: '0x0',
        issuer_schema_id: 1,
        expires_at_min: 1234567890,
      }],
      environment: 'production',
    };

    // Missing expectedMode - must fail closed
    const result = await verifier.verify(proof, {
      action: 'test-action',
      nonce: '0xtest',
      signalHash: '0x0',
      // expectedMode intentionally missing
    } as any);

    assert.equal(result.success, false);
    assert.match(result.error || '', /expectedMode required/);
  });

  it('accepts uniqueness proof with expectedMode=uniqueness', async () => {
    const verifier = new WorldIdHttpVerifier({
      appId: 'app_test',
      rpId: 'rp_test',
      environment: 'production',
      baseUrlOverride: 'http://stub',
    });

    const proof: IDKitResult = {
      protocol_version: '4.0',
      nonce: '0xtest',
      action: 'test-action',
      responses: [{
        identifier: 'proof_of_human',
        proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
        nullifier: '0x0000000000000000000000000000000000000000000000000000000000000001',
        signal_hash: '0x0',
        issuer_schema_id: 1,
        expires_at_min: 1234567890,
      }],
      environment: 'production',
    };

    // With expectedMode - validation proceeds (may fail on HTTP, but not on missing expectedMode)
    const result = await verifier.verify(proof, {
      action: 'test-action',
      nonce: '0xtest',
      signalHash: '0x0',
      expectedMode: 'uniqueness',
    });

    // Will fail on HTTP call to stub, but NOT on missing expectedMode
    assert.equal(result.success, false);
    assert.ok(!result.error?.includes('expectedMode required'));
  });
});
