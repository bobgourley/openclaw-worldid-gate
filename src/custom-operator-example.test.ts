/**
 * Custom operator test example (RUNNABLE with explicit synthetic config)
 * 
 * This demonstrates the documented example from OPERATOR_GUIDE.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionGate } from './admission-gate.js';
import { WorldIdVerifierStub } from './verifier-stub.js';
import { InMemoryEnrollmentStore } from './enrollment-store.js';
import { createTelegramUpdate, createWorldIdProof } from './fixtures.js';
import type { GateConfig } from './types.js';

describe('Custom operator test (documented example)', () => {
  it('simulates enrollment and admission', async () => {
    // Explicit synthetic test config (not placeholder)
    const testConfig: GateConfig = {
      rpId: 'rp_test_synthetic_123',
      action: 'test-action-synthetic',
      verifyEndpoint: 'https://developer.world.org/api/v4/verify',
      requireProofOfHuman: true,
      enrollmentTtlSeconds: 2592000,
      allowTestMode: true,
    };

    const verifier = new WorldIdVerifierStub();
    const store = new InMemoryEnrollmentStore();
    const gate = new AdmissionGate(testConfig, verifier, store);
    
    // Simulate World ID proof for Telegram user 123456789
    const telegramUserId = 123456789;
    const nullifier = '0x0000000000000000000000000000000000000000000000000000000000000123';
    verifier.addValidNullifier(nullifier);
    const proof = createWorldIdProof({ 
      nullifier, 
      action: testConfig.action 
    });
    
    // Enroll user
    const enrollResult = await gate.enroll(telegramUserId, proof);
    if (!enrollResult.success) {
      console.log('Enrollment failed:', enrollResult.error);
    }
    assert.equal(enrollResult.success, true);
    
    // Check admission (createTelegramUpdate uses options object)
    const update = createTelegramUpdate({
      userId: telegramUserId,
      text: 'Hello bot',
    });
    const admissionResult = await gate.checkAdmission({
      telegramUpdate: update,
      timestamp: Date.now(),
    });
    
    assert.equal(admissionResult.allowed, true);
    console.log('Admission successful:', admissionResult);
  });
});
