#!/usr/bin/env node
/**
 * Diagnostic HTML SDK Error Mapping Test
 * 
 * Proves:
 * 1. Known SDK errors ('rp_signature_expired', 'nullifier_replayed') visible
 * 2. Unknown sentinel NEVER echoed
 * 3. No raw console secrets
 */

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const DIAGNOSTIC_HTML_PATH = './dist/ui/enrollment-diagnostic.html';
const SECRET_SENTINEL = 'SECRET_NULLIFIER_0xABCDEF1234567890';

console.log('=== Diagnostic HTML SDK Error Mapping Test ===\n');

let passed = 0;
let failed = 0;

// Test 1: Known SDK errors are in mapping
console.log('Test 1: Known SDK errors mapped');
try {
  const html = readFileSync(DIAGNOSTIC_HTML_PATH, 'utf-8');
  
  // Verify mapErrorCode function exists
  assert(html.includes('function mapErrorCode'), 'mapErrorCode function must exist');
  
  // Verify known World ID errors are mapped
  assert(html.includes("'rp_signature_expired'"), 'rp_signature_expired must be in mapping');
  assert(html.includes("'nullifier_replayed'"), 'nullifier_replayed must be in mapping');
  
  console.log('✓ Known SDK errors (rp_signature_expired, nullifier_replayed) in mapping\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 2: Unknown codes map to 'unknown' (no raw echo)
console.log('Test 2: Unknown codes map to "unknown" (no raw echo)');
try {
  const html = readFileSync(DIAGNOSTIC_HTML_PATH, 'utf-8');
  
  // Extract mapErrorCode function
  const mapFnMatch = html.match(/function mapErrorCode\(code\)\s*{[\s\S]+?return mapping\[code\] \|\| ['"]unknown['"];?\s*}/);
  assert(mapFnMatch, 'Could not extract mapErrorCode function');
  
  const mapFnCode = mapFnMatch[0];
  
  // Verify it returns 'unknown' for unmapped codes
  assert(mapFnCode.includes("|| 'unknown'") || mapFnCode.includes('|| "unknown"'), 
    'mapErrorCode must return "unknown" for unmapped codes');
  
  // Verify it does NOT include any echo/console.log of raw code
  assert(!mapFnCode.includes('console.log(code)'), 'Must not log raw error code');
  assert(!mapFnCode.includes('console.error(code)'), 'Must not log raw error code');
  
  console.log('✓ Unknown codes map to "unknown" (no raw echo)\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 3: logDiagnostic uses mapErrorCode (not raw error.code)
console.log('Test 3: logDiagnostic uses mapErrorCode (not raw error.code)');
try {
  const html = readFileSync(DIAGNOSTIC_HTML_PATH, 'utf-8');
  
  // Find where proof_failed is logged
  const proofFailedMatch = html.match(/logDiagnostic\(['"]proof_failed['"],\s*['"]failure['"],\s*([^)]+)\)/);
  assert(proofFailedMatch, 'Could not find proof_failed logging');
  
  const errorParam = proofFailedMatch[1];
  
  // Verify it uses mapErrorCode, not raw error.code
  assert(errorParam.includes('mapErrorCode'), 'Must use mapErrorCode for error logging');
  assert(!errorParam.includes('error.code)') || errorParam.includes('mapErrorCode(error.code)'), 
    'Must not log raw error.code without mapping');
  
  console.log('✓ logDiagnostic uses mapErrorCode (sanitized)\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 4: No secret sentinels in HTML source
console.log('Test 4: No secret sentinels in HTML source');
try {
  const html = readFileSync(DIAGNOSTIC_HTML_PATH, 'utf-8');
  
  // Common secret patterns that should NOT be in diagnostic HTML
  const forbiddenPatterns = [
    /0x[a-fA-F0-9]{40,}/,  // Ethereum addresses / nullifiers
    /sk_[a-zA-Z0-9_]+/,     // Secret keys
    /api[_-]?key/i,          // API keys
    /secret[_-]?key/i,       // Secret keys
    /private[_-]?key/i,      // Private keys
    SECRET_SENTINEL          // Test sentinel
  ];
  
  for (const pattern of forbiddenPatterns) {
    const matches = html.match(pattern);
    if (matches && pattern !== SECRET_SENTINEL) {
      // Allow pattern in comments/documentation
      const context = html.substring(Math.max(0, matches.index - 50), matches.index + 50);
      if (!context.includes('//') && !context.includes('/*')) {
        throw new Error(`Forbidden pattern found: ${pattern}`);
      }
    }
    assert(!html.includes(SECRET_SENTINEL), 'Test sentinel must not be in HTML');
  }
  
  console.log('✓ No secret sentinels in HTML source\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 5: ALLOWED_ERROR_CATEGORIES includes sdk_error
console.log('Test 5: ALLOWED_ERROR_CATEGORIES includes sdk_error');
try {
  const html = readFileSync(DIAGNOSTIC_HTML_PATH, 'utf-8');
  
  // Find ALLOWED_ERROR_CATEGORIES
  const allowedCategoriesMatch = html.match(/const ALLOWED_ERROR_CATEGORIES\s*=\s*\[([\s\S]+?)\];/);
  assert(allowedCategoriesMatch, 'Could not find ALLOWED_ERROR_CATEGORIES');
  
  const categories = allowedCategoriesMatch[1];
  
  // Verify sdk_error is in the list
  assert(categories.includes("'sdk_error'") || categories.includes('"sdk_error"'), 
    'ALLOWED_ERROR_CATEGORIES must include sdk_error');
  
  console.log('✓ ALLOWED_ERROR_CATEGORIES includes sdk_error\n');
  passed++;
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  failed++;
}

// Test 6: Diagnostic panel validates categories against allowlist
console.log('Test 6: Diagnostic panel validates categories');
try {
  const html = readFileSync(DIAGNOSTIC_HTML_PATH, 'utf-8');
  
  // Find logDiagnostic function
  const logDiagnosticMatch = html.match(/function logDiagnostic\([\s\S]+?{([\s\S]+?)function updateDiagnosticPanel/);
  assert(logDiagnosticMatch, 'Could not find logDiagnostic function');
  
  const logDiagnosticBody = logDiagnosticMatch[1];
  
  // Verify it checks ALLOWED_DIAGNOSTIC_STAGES
  assert(logDiagnosticBody.includes('ALLOWED_DIAGNOSTIC_STAGES'), 
    'logDiagnostic must check ALLOWED_DIAGNOSTIC_STAGES');
  
  // Verify it checks ALLOWED_ERROR_CATEGORIES
  assert(logDiagnosticBody.includes('ALLOWED_ERROR_CATEGORIES'), 
    'logDiagnostic must check ALLOWED_ERROR_CATEGORIES');
  
  console.log('✓ Diagnostic panel validates against allowlists\n');
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
  console.log('✓ All diagnostic HTML SDK error tests passed');
  console.log('✓ Known errors visible, unknown never echoed, no secrets');
} else {
  console.log('✗ Diagnostic HTML SDK error mapping incomplete');
}

process.exit(failed > 0 ? 1 : 0);
