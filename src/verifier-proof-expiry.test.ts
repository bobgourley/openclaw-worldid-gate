/**
 * Proof expiry boundary tests
 * 
 * Verifies that proof expiry uses inclusive boundary (expires_at_min <= now)
 * aligned with enrollment expiry semantics.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldIdVerifierStub } from './verifier-stub.js';
import { createWorldIdProof } from './fixtures.js';

describe('Proof expiry boundary validation', () => {
  it('rejects proof at exact expiry boundary (expires_at_min == now)', async () => {
    const verifier = new WorldIdVerifierStub();
    const nullifier = '0xexpiry_boundary';
    verifier.addValidNullifier(nullifier);

    const now = Math.floor(Date.now() / 1000);
    const proof = createWorldIdProof({
      nullifier,
      action: 'test-action',
      expiresAtMin: now, // Exactly at current time
    });

    const result = await verifier.verify(proof);

    assert.strictEqual(result.success, false);
    assert.ok(result.results?.[0].code === 'expired');
  });

  it('rejects proof one second past expiry', async () => {
    const verifier = new WorldIdVerifierStub();
    const nullifier = '0xpast_expiry';
    verifier.addValidNullifier(nullifier);

    const now = Math.floor(Date.now() / 1000);
    const proof = createWorldIdProof({
      nullifier,
      action: 'test-action',
      expiresAtMin: now - 1, // One second ago
    });

    const result = await verifier.verify(proof);

    assert.strictEqual(result.success, false);
    assert.ok(result.results?.[0].code === 'expired');
  });

  it('accepts proof one second before expiry', async () => {
    const verifier = new WorldIdVerifierStub();
    const nullifier = '0xbefore_expiry';
    verifier.addValidNullifier(nullifier);

    const now = Math.floor(Date.now() / 1000);
    const proof = createWorldIdProof({
      nullifier,
      action: 'test-action',
      expiresAtMin: now + 1, // One second in the future
    });

    const result = await verifier.verify(proof);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.results?.[0].nullifier, nullifier);
  });

  it('accepts proof with no expiry set', async () => {
    const verifier = new WorldIdVerifierStub();
    const nullifier = '0xno_expiry';
    verifier.addValidNullifier(nullifier);

    const proof = createWorldIdProof({
      nullifier,
      action: 'test-action',
      // expiresAtMin not set
    });

    const result = await verifier.verify(proof);

    assert.strictEqual(result.success, true);
  });
});
