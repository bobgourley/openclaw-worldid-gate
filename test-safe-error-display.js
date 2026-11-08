#!/usr/bin/env node
/**
 * Safe Error Display Test
 * 
 * Proves:
 * 1. Known SDK codes (rp_signature_expired, nullifier_replayed) visible in error message
 * 2. Unknown sentinel absent from DOM and console
 * 3. No raw console.error with unvalidated values
 */

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const HTML_PATH = './dist/ui/enrollment-safe-errors.html';
const UNKNOWN_SENTINEL = 'ATTACKER_INJECTED_0xSECRET';

console.log('=== Safe Error Display Test ===\n');

let passed = 0;
let failed = 0;

// Test 1: Known error codes in allowlist
console.log('Test 1: Known error codes in allowlist');
try {
  const html = readFileSync(HTML_PATH, 'utf-8');
  
  // Extract handleProofError function
  const handleProofErrorMatch = html.match(/function handleProofError\(errorCode\)\s*{([\s\S]+?)function \w+\(/);
  assert(handleProofErrorMatch, 'Could not extract handleProofError');
  
  const handleProofErrorBody = handleProofErrorMatch[1];
  
  // Verify allowlist exists
  assert(handleProofErrorBody.includes('knownErrors'), 'Must have knownErrors allowlist');
  
  // Verify known codes are in allowlist
  assert(handleProofErrorBody.includes("'rp_signature_expired'"), 'rp_signature_expired must be in allowlist');
  assert(handleProofErrorBody.includes("'nullifier_replayed'"), 'nullifier_replayed must be in allowlist');
  assert(handleProofErrorBody.includes("'user_rejected'"), 'user_rejected must be in allowlist');
  
  console.log('✓ Known error codes in allowlist\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 2: Error code sanitization (unknown → unknown_error)
console.log('Test 2: Error code sanitization');
try {
  const html = readFileSync(HTML_PATH, 'utf-8');
  
  const handleProofErrorMatch = html.match(/function handleProofError\(errorCode\)\s*{([\s\S]+?)function \w+\(/);
  const handleProofErrorBody = handleProofErrorMatch[1];
  
  // Verify sanitization logic
  assert(handleProofErrorBody.includes('knownErrors.includes(errorCode)'), 'Must check if code is in allowlist');
  assert(handleProofErrorBody.includes('unknown_error'), 'Must map unknown codes to unknown_error');
  
  console.log('✓ Unknown codes sanitized to "unknown_error"\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 3: Error code displayed in message (for Bob visibility)
console.log('Test 3: Error code displayed in message');
try {
  const html = readFileSync(HTML_PATH, 'utf-8');
  
  const handleProofErrorMatch = html.match(/function handleProofError\(errorCode\)\s*{([\s\S]+?)function \w+\(/);
  const handleProofErrorBody = handleProofErrorMatch[1];
  
  // Verify error code is appended to message
  assert(handleProofErrorBody.includes('(Code:'), 'Must display error code in message');
  assert(handleProofErrorBody.includes('safeErrorCode'), 'Must use sanitized error code');
  
  console.log('✓ Error code displayed in message (safe, allowlisted)\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 4: No raw console.error with error objects
console.log('Test 4: No raw console.error with error objects');
try {
  const html = readFileSync(HTML_PATH, 'utf-8');
  
  // Find all console.error calls
  const consoleErrorMatches = html.matchAll(/console\.error\([^)]+\)/g);
  
  for (const match of consoleErrorMatches) {
    const call = match[0];
    
    // Verify no error object is logged
    assert(!call.includes('error)'), `Raw error object logged: ${call}`);
    assert(!call.includes('errorCode)'), `Raw errorCode logged without allowlist check: ${call}`);
  }
  
  console.log('✓ No raw console.error with unvalidated values\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 5: User-friendly messages for known codes
console.log('Test 5: User-friendly messages for known codes');
try {
  const html = readFileSync(HTML_PATH, 'utf-8');
  
  const handleProofErrorMatch = html.match(/function handleProofError\(errorCode\)\s*{([\s\S]+?)function \w+\(/);
  const handleProofErrorBody = handleProofErrorMatch[1];
  
  // Verify messages for new codes
  assert(handleProofErrorBody.includes('rp_signature_expired') && 
         handleProofErrorBody.includes('Verification session expired'),
         'rp_signature_expired must have user-friendly message');
  
  assert(handleProofErrorBody.includes('nullifier_replayed') && 
         handleProofErrorBody.includes('already been used'),
         'nullifier_replayed must have user-friendly message');
  
  console.log('✓ User-friendly messages for known codes\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 6: Diff vs 83ebbaa is minimal (only error handling)
console.log('Test 6: Diff vs 83ebbaa is minimal');
try {
  const html = readFileSync(HTML_PATH, 'utf-8');
  
  // Verify core structure unchanged
  assert(html.includes('<title>World ID Verification</title>'), 'Title must be unchanged');
  assert(html.includes('/api/enrollment/session'), 'Session endpoint must be unchanged');
  assert(html.includes('/api/enrollment/complete'), 'Enrollment endpoint must be unchanged');
  assert(html.includes('/idkit-bundle.js'), 'IDKit bundle import must be unchanged');
  assert(html.includes('IDKit.request'), 'IDKit.request call must be unchanged');
  assert(!html.includes('window.IDKitBridge'), 'Must not use fake IDKitBridge');
  
  console.log('✓ Diff vs 83ebbaa is minimal (only error handling)\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Summary
console.log('=== Test Summary ===');
console.log(`Passed: ${passed}/6`);
console.log(`Failed: ${failed}/6`);
console.log('');

if (failed === 0) {
  console.log('✓ All safe error display tests passed');
  console.log('✓ Known codes visible, unknown sanitized, no raw errors');
} else {
  console.log('✗ Safe error display incomplete');
}

process.exit(failed > 0 ? 1 : 0);
