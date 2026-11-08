#!/usr/bin/env node
/**
 * Revocation Semantics Test Harness - Corrected Sequences
 * Tests against ACTUAL compiled dist/ files from 83ebbaa.
 */

import { EnrollmentService } from './dist/enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './dist/worldid-challenge-adapter.js';
import { createHmac, randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_ACTION = 'test-revocation-corrected';
const TEST_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const TEST_DB_PATH = '/tmp/test-revocation-corrected.db';

// Cleanup old test DB
if (existsSync(TEST_DB_PATH)) {
  unlinkSync(TEST_DB_PATH);
}

// Create valid Telegram initData with correct HMAC-SHA256(WebAppData, botToken) signing
function createValidInitData(userId, botToken) {
  const authDate = Math.floor(Date.now() / 1000);
  const userJson = JSON.stringify({ id: userId, first_name: 'Test' });
  const dataCheckString = `auth_date=${authDate}\nuser=${userJson}`;
  
  // Correct Telegram WebApp signing: HMAC-SHA256(data, HMAC-SHA256("WebAppData", botToken))
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  
  const encodedUser = encodeURIComponent(userJson);
  return `auth_date=${authDate}&hash=${hash}&user=${encodedUser}`;
}

// Create mock IDKit result
function createIDKitResult(nonce, action, signalHash, nullifier) {
  return {
    protocol_version: '4.0',
    nonce,
    action,
    responses: [{
      identifier: 'proof_of_human',
      issuer_schema_id: 1,
      nullifier,
      expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
      signal_hash: signalHash,
    }],
    environment: 'production',
  };
}

// Mock verifier
class MockVerifier {
  constructor() {
    this.currentNullifier = null;
  }
  
  setResponse(nullifier) {
    this.currentNullifier = nullifier;
  }
  
  async verify(idkitResult, expectedContext) {
    return {
      success: true,
      nullifier: this.currentNullifier || idkitResult.responses[0].nullifier,
      issuerSchemaId: 1,
      expiresAtMin: Math.floor(Date.now() / 1000) + 86400,
    };
  }
}

async function runTests() {
  console.log('=== Revocation Semantics Test Harness (Corrected Sequences) ===\n');
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Same-owner same nullifier fresh post-revoke success
  try {
    console.log('Test 1: Same-owner fresh post-revoke enrollment with SAME nullifier');
    
    const verifier = new MockVerifier();
    const challengeAdapter = new WorldIdChallengeAdapter({
      appId: 'app_test1',
      rpId: 'rp_test1',
      signingKeyHex: 'a'.repeat(64),
      environment: 'production',
    });
    
    const service = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter,
      verificationClient: verifier,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
    });
    
    const userId = 1001;
    const nullifier = '0xsame_owner_' + randomBytes(16).toString('hex');
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);
    
    // Initial enrollment
    const challenge1 = await service.createChallenge(initData);
    const idkitResult1 = createIDKitResult(
      challenge1.signedChallenge.nonce,
      TEST_ACTION,
      challenge1.signedChallenge.signalHash,
      nullifier
    );
    verifier.setResponse(nullifier);
    
    const enrollment1 = await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
    if (!enrollment1.success) throw new Error('Initial enrollment failed');
    
    // Revoke
    const revoked = await service.revokeEnrollment(userId);
    if (!revoked) throw new Error('Revocation failed');
    
    // Fresh challenge post-revoke
    const challenge2 = await service.createChallenge(initData);
    const idkitResult2 = createIDKitResult(
      challenge2.signedChallenge.nonce,
      TEST_ACTION,
      challenge2.signedChallenge.signalHash,
      nullifier  // SAME nullifier
    );
    verifier.setResponse(nullifier);
    
    const enrollment2 = await service.completeEnrollment({ initData, idkitResult: idkitResult2 });
    
    if (enrollment2.success && enrollment2.nullifier === nullifier) {
      console.log('✓ PASS: Same-owner fresh post-revoke enrollment succeeded\n');
      passed++;
    } else {
      console.log('✗ FAIL: Expected success with same nullifier, got:', enrollment2, '\n');
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Test 1 threw:', error.message, '\n');
    failed++;
  }
  
  // Clean up DB
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
  
  // Test 2: Cross-account takeover rejected
  try {
    console.log('Test 2: Cross-account takeover with same nullifier rejected');
    
    const verifier = new MockVerifier();
    const challengeAdapter = new WorldIdChallengeAdapter({
      appId: 'app_test2',
      rpId: 'rp_test2',
      signingKeyHex: 'b'.repeat(64),
      environment: 'production',
    });
    
    const service = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter,
      verificationClient: verifier,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
    });
    
    const userA = 1001;
    const userB = 1002;
    const nullifier = '0xcross_account_' + randomBytes(16).toString('hex');
    
    // User A enrolls
    const initDataA = createValidInitData(userA, TEST_BOT_TOKEN);
    const challengeA = await service.createChallenge(initDataA);
    const idkitResultA = createIDKitResult(
      challengeA.signedChallenge.nonce,
      TEST_ACTION,
      challengeA.signedChallenge.signalHash,
      nullifier
    );
    verifier.setResponse(nullifier);
    
    const enrollmentA = await service.completeEnrollment({ initData: initDataA, idkitResult: idkitResultA });
    if (!enrollmentA.success) throw new Error('User A enrollment failed');
    
    // Revoke user A
    await service.revokeEnrollment(userA);
    
    // User B tries to enroll with SAME nullifier
    const initDataB = createValidInitData(userB, TEST_BOT_TOKEN);
    const challengeB = await service.createChallenge(initDataB);
    const idkitResultB = createIDKitResult(
      challengeB.signedChallenge.nonce,
      TEST_ACTION,
      challengeB.signedChallenge.signalHash,
      nullifier  // SAME nullifier
    );
    verifier.setResponse(nullifier);
    
    const enrollmentB = await service.completeEnrollment({ initData: initDataB, idkitResult: idkitResultB });
    
    if (!enrollmentB.success && /permanently bound|immutable.*binding|different account/i.test(enrollmentB.error || '')) {
      console.log('✓ PASS: Cross-account takeover rejected\n');
      passed++;
    } else {
      console.log('✗ FAIL: Expected rejection, got:', enrollmentB, '\n');
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Test 2 threw:', error.message, '\n');
    failed++;
  }
  
  // Clean up DB
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
  
  // Test 3: Old challenge created after first revoke, rejected after second revoke fence
  try {
    console.log('Test 3: Challenge created while un-enrolled, rejected after second revoke fence');
    
    const verifier = new MockVerifier();
    const challengeAdapter = new WorldIdChallengeAdapter({
      appId: 'app_test3',
      rpId: 'rp_test3',
      signingKeyHex: 'c'.repeat(64),
      environment: 'production',
    });
    
    const service = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter,
      verificationClient: verifier,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
    });
    
    const userId = 1001;
    const nullifier = '0xold_challenge_' + randomBytes(16).toString('hex');
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);
    
    // Step 1: Initial enrollment
    const challenge1 = await service.createChallenge(initData);
    const idkitResult1 = createIDKitResult(
      challenge1.signedChallenge.nonce,
      TEST_ACTION,
      challenge1.signedChallenge.signalHash,
      nullifier
    );
    verifier.setResponse(nullifier);
    const enroll1 = await service.completeEnrollment({ initData, idkitResult: idkitResult1 });
    if (!enroll1.success) throw new Error('Initial enrollment failed');
    
    // Step 2: First revoke (user now un-enrolled)
    const revoked1 = await service.revokeEnrollment(userId);
    if (!revoked1) throw new Error('First revoke failed');
    
    // Step 3: Create challenge while un-enrolled (valid at this point)
    const oldChallenge = await service.createChallenge(initData);
    
    // Step 4: Second revoke (creates new fence, invalidates oldChallenge)
    await service.revokeEnrollment(userId);
    // Second revoke returns false (no active enrollment) but updates fence
    
    // Step 5: Fresh challenge and restore after second revoke
    const freshChallenge = await service.createChallenge(initData);
    const freshIdkitResult = createIDKitResult(
      freshChallenge.signedChallenge.nonce,
      TEST_ACTION,
      freshChallenge.signedChallenge.signalHash,
      nullifier
    );
    verifier.setResponse(nullifier);
    const freshEnroll = await service.completeEnrollment({ initData, idkitResult: freshIdkitResult });
    if (!freshEnroll.success) throw new Error('Fresh enrollment failed');
    
    // Step 6: Try to complete old challenge (should be rejected)
    const oldIdkitResult = createIDKitResult(
      oldChallenge.signedChallenge.nonce,
      TEST_ACTION,
      oldChallenge.signedChallenge.signalHash,
      nullifier
    );
    verifier.setResponse(nullifier);
    const oldResult = await service.completeEnrollment({ initData, idkitResult: oldIdkitResult });
    
    if (!oldResult.success && /challenge.*not found|challenge expired|challenge.*consumed|predates|already enrolled|fence/i.test(oldResult.error || '')) {
      console.log('✓ PASS: Old challenge rejected (reason: ' + oldResult.error + ')\n');
      passed++;
    } else {
      console.log('✗ FAIL: Expected rejection, got:', oldResult, '\n');
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Test 3 threw:', error.message, '\n');
    failed++;
  }
  
  // Clean up DB
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
  
  // Test 4: Delayed verifier promise (enroll->revoke->challenge/startHeld->revoke2->freshRestore->releaseHeld->reject)
  try {
    console.log('Test 4: Held verifier issued before revoke, resolved after fresh restore rejects');
    
    let resolveVerifier;
    const verifierPromise = new Promise(resolve => { resolveVerifier = resolve; });
    
    class DelayedVerifier {
      async verify(idkitResult, expectedContext) {
        await verifierPromise;
        return {
          success: true,
          nullifier: idkitResult.responses[0].nullifier,
          issuerSchemaId: 1,
          expiresAtMin: Math.floor(Date.now() / 1000) + 86400,
        };
      }
    }
    
    const verifier = new MockVerifier();
    const delayedVerifier = new DelayedVerifier();
    const challengeAdapter = new WorldIdChallengeAdapter({
      appId: 'app_test4',
      rpId: 'rp_test4',
      signingKeyHex: 'd'.repeat(64),
      environment: 'production',
    });
    
    const serviceNormal = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter,
      verificationClient: verifier,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
    });
    
    const serviceDelayed = new EnrollmentService({
      dbPath: TEST_DB_PATH,
      challengeAdapter,
      verificationClient: delayedVerifier,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
    });
    
    const userId = 1001;
    const nullifier = '0xdelayed_' + randomBytes(16).toString('hex');
    const initData = createValidInitData(userId, TEST_BOT_TOKEN);
    
    // Step 1: Initial enrollment with normal verifier
    const challenge1 = await serviceNormal.createChallenge(initData);
    const idkitResult1 = createIDKitResult(
      challenge1.signedChallenge.nonce,
      TEST_ACTION,
      challenge1.signedChallenge.signalHash,
      nullifier
    );
    verifier.setResponse(nullifier);
    const enroll1 = await serviceNormal.completeEnrollment({ initData, idkitResult: idkitResult1 });
    if (!enroll1.success) throw new Error('Initial enrollment failed');
    
    // Step 2: First revoke
    await serviceNormal.revokeEnrollment(userId);
    
    // Step 3: Create challenge and start held async completion while un-enrolled
    const heldChallenge = await serviceDelayed.createChallenge(initData);
    const heldIdkitResult = createIDKitResult(
      heldChallenge.signedChallenge.nonce,
      TEST_ACTION,
      heldChallenge.signedChallenge.signalHash,
      nullifier
    );
    
    // Start held enrollment (will block on verifierPromise)
    const heldPromise = serviceDelayed.completeEnrollment({ initData, idkitResult: heldIdkitResult });
    
    // Wait briefly to ensure held enrollment has started
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Step 4: Second revoke (creates durable fence while held verification pending)
    await serviceNormal.revokeEnrollment(userId);
    
    // Step 5: Fresh challenge and restore
    const freshChallenge = await serviceNormal.createChallenge(initData);
    const freshIdkitResult = createIDKitResult(
      freshChallenge.signedChallenge.nonce,
      TEST_ACTION,
      freshChallenge.signedChallenge.signalHash,
      nullifier
    );
    verifier.setResponse(nullifier);
    const freshEnroll = await serviceNormal.completeEnrollment({ initData, idkitResult: freshIdkitResult });
    if (!freshEnroll.success) throw new Error('Fresh enrollment failed');
    
    // Step 6: Release held verifier and check result
    resolveVerifier();
    const heldResult = await heldPromise;
    
    if (!heldResult.success && /challenge|fence|already enrolled/i.test(heldResult.error || '')) {
      console.log('✓ PASS: Delayed verification rejected (reason: ' + heldResult.error + ')\n');
      passed++;
    } else {
      console.log('✗ FAIL: Expected rejection, got:', heldResult, '\n');
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Test 4 threw:', error.message, '\n');
    failed++;
  }
  
  // Clean up DB
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
  
  // Summary
  console.log('=== Test Summary ===');
  console.log(`Passed: ${passed}/4`);
  console.log(`Failed: ${failed}/4`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
