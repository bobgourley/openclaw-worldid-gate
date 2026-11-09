/**
 * Action-model gap validation tests
 * 
 * Verifies that the stub correctly validates proof action against expected action.
 * This simulates World ID's action-scoping security property.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { WorldIdVerifierStub } from './verifier-stub.js';
import { createWorldIdProof } from './fixtures.js';

describe('Action-model gap validation', () => {
  it('should reject proof with mismatched action when expectedAction is set', async () => {
    const verifier = new WorldIdVerifierStub();
    verifier.setExpectedAction('expected-action');
    const proof = createWorldIdProof({ action: 'different-action' });
    verifier.addValidNullifier(proof.responses[0].nullifier);

    const result = await verifier.verify(proof);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'action_mismatch');
    assert.ok(result.detail?.includes('different-action'));
    assert.ok(result.detail?.includes('expected-action'));
  });

  it('should accept proof with matching action when expectedAction is set', async () => {
    const verifier = new WorldIdVerifierStub();
    verifier.setExpectedAction('test-action');
    const proof = createWorldIdProof({ action: 'test-action' });
    verifier.addValidNullifier(proof.responses[0].nullifier);

    const result = await verifier.verify(proof);

    assert.strictEqual(result.success, true);
  });

  it('should accept any action when expectedAction is undefined', async () => {
    const verifier = new WorldIdVerifierStub();
    verifier.setExpectedAction(undefined);
    const proof = createWorldIdProof({ action: 'any-action' });
    verifier.addValidNullifier(proof.responses[0].nullifier);

    const result = await verifier.verify(proof);

    assert.strictEqual(result.success, true);
  });

  it('should check action before checking nullifier validity', async () => {
    const verifier = new WorldIdVerifierStub();
    verifier.setExpectedAction('expected-action');
    const proof = createWorldIdProof({ action: 'wrong-action' });
    // Do NOT add nullifier to valid set

    const result = await verifier.verify(proof);

    // Should fail on action mismatch, not on invalid nullifier
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'action_mismatch');
  });

  it('should reject empty action when expectedAction is set to non-empty string', async () => {
    const verifier = new WorldIdVerifierStub();
    verifier.setExpectedAction('expected-action');
    const proof = createWorldIdProof({ action: '' });
    verifier.addValidNullifier(proof.responses[0].nullifier);

    const result = await verifier.verify(proof);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'action_mismatch');
  });

  it('should accept empty action when expectedAction is set to empty string', async () => {
    const verifier = new WorldIdVerifierStub();
    verifier.setExpectedAction('');
    const proof = createWorldIdProof({ action: '' });
    verifier.addValidNullifier(proof.responses[0].nullifier);

    const result = await verifier.verify(proof);

    assert.strictEqual(result.success, true);
  });
});
