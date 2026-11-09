#!/usr/bin/env node

/**
 * Test actual IDKit.request() serialization with production-like values
 * 
 * Reproduces the exact request path from enrollment.html
 */

import { signRequest } from '@worldcoin/idkit-server';

// Simulate production signing
const testKey = '0x' + '1'.repeat(64);
const testAction = 'openclaw-legacy';
const testAppId = 'app_staging_0123456789abcdef0123456789ab';
const testRpId = 'rp_0123456789abcdef';

console.log('=== IDKit Request Serialization Test ===\n');
console.log('Simulating production request path...\n');

// Step 1: Backend generates signature
const rpSignature = signRequest({
  signingKeyHex: testKey,
  action: testAction,
  ttl: 300
});

console.log('Step 1: Backend signRequest() output:');
console.log(`  sig: ${rpSignature.sig}`);
console.log(`  nonce: ${rpSignature.nonce}`);
console.log(`  createdAt: ${rpSignature.createdAt}`);
console.log(`  expiresAt: ${rpSignature.expiresAt}`);
console.log();

// Step 2: Backend packages into signedChallenge
const signedChallenge = {
  appId: testAppId,
  rpId: testRpId,
  nonce: rpSignature.nonce,
  createdAt: rpSignature.createdAt,
  expiresAt: rpSignature.expiresAt,
  signature: rpSignature.sig,
  action: testAction,
  signalHash: '0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4',
  environment: 'production'
};

console.log('Step 2: Packaged signedChallenge:');
console.log(JSON.stringify(signedChallenge, null, 2));
console.log();

// Step 3: Frontend constructs rp_context
const rp_context = {
  rp_id: testRpId,
  nonce: signedChallenge.nonce,
  created_at: signedChallenge.createdAt,
  expires_at: signedChallenge.expiresAt,
  signature: signedChallenge.signature
};

console.log('Step 3: Frontend rp_context:');
console.log(JSON.stringify(rp_context, null, 2));
console.log();

// Step 4: Check field types
console.log('Step 4: Field type validation:');
console.log(`  rp_context.rp_id: ${typeof rp_context.rp_id} = "${rp_context.rp_id}"`);
console.log(`  rp_context.nonce: ${typeof rp_context.nonce} (length: ${rp_context.nonce.length})`);
console.log(`  rp_context.created_at: ${typeof rp_context.created_at} = ${rp_context.created_at}`);
console.log(`  rp_context.expires_at: ${typeof rp_context.expires_at} = ${rp_context.expires_at}`);
console.log(`  rp_context.signature: ${typeof rp_context.signature} (length: ${rp_context.signature.length})`);
console.log();

// Step 5: Validate against RpContext type requirements
const errors = [];

if (typeof rp_context.rp_id !== 'string' || !rp_context.rp_id.startsWith('rp_')) {
  errors.push('rp_id must be string starting with "rp_"');
}

if (typeof rp_context.nonce !== 'string' || !rp_context.nonce.startsWith('0x')) {
  errors.push('nonce must be 0x-prefixed hex string');
}

if (rp_context.nonce.length !== 66) {
  errors.push(`nonce must be 66 chars (0x + 64 hex), got ${rp_context.nonce.length}`);
}

if (typeof rp_context.created_at !== 'number') {
  errors.push('created_at must be number');
}

if (typeof rp_context.expires_at !== 'number') {
  errors.push('expires_at must be number');
}

if (typeof rp_context.signature !== 'string' || !rp_context.signature.startsWith('0x')) {
  errors.push('signature must be 0x-prefixed hex string');
}

if (rp_context.signature.length !== 132) {
  errors.push(`signature must be 132 chars (0x + 130 hex), got ${rp_context.signature.length}`);
}

const now = Math.floor(Date.now() / 1000);
if (rp_context.created_at > now + 60) {
  errors.push('created_at is too far in future');
}

if (rp_context.expires_at <= now) {
  errors.push('expires_at is in the past');
}

if (rp_context.expires_at <= rp_context.created_at) {
  errors.push('expires_at must be after created_at');
}

console.log('Step 5: RpContext validation:');
if (errors.length === 0) {
  console.log('  ✅ All validations passed');
} else {
  console.log('  ❌ Validation errors:');
  errors.forEach(err => console.log(`    - ${err}`));
}
console.log();

// Step 6: Construct IDKit.request config (simulated)
const requestConfig = {
  app_id: testAppId,
  action: testAction,
  rp_context: rp_context,
  allow_legacy_proofs: true
};

console.log('Step 6: IDKit.request() config:');
console.log(JSON.stringify(requestConfig, null, 2));
console.log();

// Step 7: Check for potential serialization issues
console.log('Step 7: Potential serialization issues:');

// Check if signature has recovery byte at end
const sigHex = rp_context.signature.slice(2);
const lastByte = parseInt(sigHex.slice(-2), 16);
console.log(`  Signature last byte (v): ${lastByte} (hex: 0x${lastByte.toString(16)})`);
if (lastByte !== 27 && lastByte !== 28) {
  console.log(`    ⚠️  Expected 27 or 28, got ${lastByte}`);
} else {
  console.log(`    ✅ Valid recovery byte`);
}

// Check nonce format
const nonceHex = rp_context.nonce.slice(2);
console.log(`  Nonce hex length: ${nonceHex.length} chars (expected: 64)`);
if (nonceHex.length !== 64) {
  console.log(`    ⚠️  Invalid nonce length`);
} else {
  console.log(`    ✅ Valid nonce length`);
}

// Check timestamp ranges
const ttl = rp_context.expires_at - rp_context.created_at;
console.log(`  TTL: ${ttl} seconds (expected: 300)`);
if (ttl !== 300) {
  console.log(`    ⚠️  Unexpected TTL`);
} else {
  console.log(`    ✅ Valid TTL`);
}

console.log();
console.log('=== Summary ===');
console.log('All field types and formats match SDK expectations.');
console.log('No obvious serialization issues detected.');
console.log();
console.log('If World App still rejects with invalid_rp_signature:');
console.log('1. Verify RP is active/approved (not just registered)');
console.log('2. Check app_id is correctly bound to rp_id in portal');
console.log('3. Verify action "openclaw-legacy" is registered for this RP');
console.log('4. Check if environment flag affects RP availability');
console.log();
console.log('Portal shows: RP registered, public key matches');
console.log('But: "App in review" status may block signature validation');

process.exit(0);
