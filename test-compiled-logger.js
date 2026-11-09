#!/usr/bin/env node
/**
 * Test Compiled Diagnostic Logger - Real Execution
 * 
 * Tests ACTUAL dist/diagnostic-logger.js in isolated synthetic environment.
 * Verifies file creation, privacy sanitization, stderr output, field types.
 */

import { createDiagnosticLogger } from './dist/diagnostic-logger.js';
import { mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const TEST_LOG_DIR = '/tmp/test-diagnostic-logger-private';

// Clean up old test dir
if (existsSync(TEST_LOG_DIR)) {
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
}

console.log('=== Compiled Diagnostic Logger Test ===\n');

// Test 1: Initialization with proper directory
console.log('Test 1: Safe initialization with proper directory');
try {
  mkdirSync(TEST_LOG_DIR, { recursive: true, mode: 0o700 });
  
  const logger = createDiagnosticLogger({
    logDir: TEST_LOG_DIR,
    maxFileSizeBytes: 1024 * 1024,
    maxFiles: 3,
    enabled: true,
  });
  
  console.log('✓ Logger initialized without throwing');
  
  // Verify log file was created
  const files = readdirSync(TEST_LOG_DIR);
  assert(files.length >= 1, 'Expected at least 1 log file created');
  console.log(`✓ Log file created: ${files[0]}`);
} catch (error) {
  console.error('✗ FAIL:', error.message);
  process.exit(1);
}

// Test 2: Privacy sanitization - all field types
console.log('\nTest 2: Privacy sanitization for all field types');
try {
  const logger = createDiagnosticLogger({
    logDir: TEST_LOG_DIR,
    maxFileSizeBytes: 1024 * 1024,
    maxFiles: 3,
    enabled: true,
  });
  
  // Log various stages with different field types
  logger.logChallengeIssued('corr-123', 300);
  logger.logCallbackReceived('corr-456');
  logger.logChallengeExpired('corr-789');
  logger.logUpstreamVerifyStarted('corr-abc');
  logger.logUpstreamVerifySuccess('corr-def', 150);
  logger.logUpstreamVerifyFailed('corr-xyz', 'proof_error', 250);
  logger.logEnrollmentComplete('corr-final');
  logger.logRevoke('corr-revoke', true);
  
  // Read log file and verify JSON structure
  const files = readdirSync(TEST_LOG_DIR).filter(f => f.startsWith('diagnostic-'));
  assert(files.length >= 1, 'Expected log file');
  
  const logPath = `${TEST_LOG_DIR}/${files[files.length - 1]}`;
  const logContent = readFileSync(logPath, 'utf-8');
  const lines = logContent.trim().split('\n').filter(l => l);
  
  console.log(`✓ Logged ${lines.length} events`);
  
  // Verify each line is valid JSON
  let validJson = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      assert(entry.timestamp, 'Expected timestamp field');
      assert(entry.correlationId, 'Expected correlationId field');
      validJson++;
    } catch (e) {
      console.error(`✗ Invalid JSON line: ${line}`);
      throw e;
    }
  }
  console.log(`✓ All ${validJson} log entries are valid JSON`);
  
  // Privacy checks - no PII/secrets in logs (check for actual values, not category names)
  const fullLog = logContent.toLowerCase();
  const forbidden = ['nullifier":"', '0x', 'proof":"', 'signature":"', 'privatekey', 'secretkey', 'password'];
  for (const word of forbidden) {
    assert(!fullLog.includes(word), `Log should not contain: ${word}`);
  }
  console.log('✓ No forbidden PII/secrets in logs');
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  process.exit(1);
}

// Test 3: Invalid stages/categories rejected (stderr sanitization)
console.log('\nTest 3: Invalid stages/categories rejected with stderr');
try {
  const logger = createDiagnosticLogger({
    logDir: TEST_LOG_DIR,
    maxFileSizeBytes: 1024 * 1024,
    maxFiles: 3,
    enabled: true,
  });
  
  // Capture stderr
  let stderrOutput = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrOutput += chunk.toString();
    return true;
  };
  
  // Try to log invalid stage
  logger.log({
    timestamp: new Date().toISOString(),
    correlationId: 'test-invalid',
    stage: 'INVALID_STAGE_NOT_ALLOWED',
    result: 'failure',
  });
  
  // Try to log invalid error category
  logger.logUpstreamVerifyFailed('test-invalid-2', 'INVALID_CATEGORY', 100);
  
  // Restore stderr
  process.stderr.write = originalStderrWrite;
  
  // Verify stderr contains fallback entries (JSON with fallback:true)
  assert(stderrOutput.includes('INVALID_STAGE_NOT_ALLOWED'), 'Expected invalid stage in stderr');
  assert(stderrOutput.includes('fallback'), 'Expected fallback flag in stderr');
  console.log('✓ Invalid stages/categories rejected with stderr fallback');
  
  // Verify they were NOT written to log file
  const files = readdirSync(TEST_LOG_DIR).filter(f => f.startsWith('diagnostic-'));
  const logPath = `${TEST_LOG_DIR}/${files[files.length - 1]}`;
  const logContent = readFileSync(logPath, 'utf-8');
  assert(!logContent.includes('INVALID_STAGE_NOT_ALLOWED'), 'Invalid stage should not be logged');
  assert(!logContent.includes('INVALID_CATEGORY'), 'Invalid category should not be logged');
  console.log('✓ Invalid entries NOT written to log file');
  
} catch (error) {
  console.error('✗ FAIL:', error.message);
  console.error(error.stack);
  process.exit(1);
}

// Test 4: Non-throwing guarantees
console.log('\nTest 4: Non-throwing guarantees under error conditions');
try {
  const logger = createDiagnosticLogger({
    logDir: TEST_LOG_DIR,
    maxFileSizeBytes: 1024 * 1024,
    maxFiles: 3,
    enabled: true,
  });
  
  // Log with various invalid inputs - should not throw
  logger.logChallengeIssued(null, -1);
  logger.logCallbackReceived('');
  logger.logEnrollmentComplete(undefined);
  logger.logUpstreamVerifyFailed('test', 'INVALID_CATEGORY', 100);
  
  console.log('✓ Logger handles invalid inputs without throwing');
} catch (error) {
  console.error('✗ FAIL:', error.message);
  process.exit(1);
}

// Test 5: Disabled logger (enabled: false) - no files created
console.log('\nTest 5: Disabled logger does not create files');
try {
  const disabledDir = '/tmp/test-disabled-logger';
  if (existsSync(disabledDir)) {
    rmSync(disabledDir, { recursive: true, force: true });
  }
  mkdirSync(disabledDir, { recursive: true, mode: 0o700 });
  
  const logger = createDiagnosticLogger({
    logDir: disabledDir,
    maxFileSizeBytes: 1024 * 1024,
    maxFiles: 3,
    enabled: false,
  });
  
  logger.logChallengeIssued('test', 'nonce', 300);
  logger.logEnrollmentComplete('test', true);
  
  const files = readdirSync(disabledDir).filter(f => f.startsWith('diagnostic-'));
  assert(files.length === 0, 'Disabled logger should not create files');
  console.log('✓ Disabled logger creates no files');
  
  rmSync(disabledDir, { recursive: true, force: true });
} catch (error) {
  console.error('✗ FAIL:', error.message);
  process.exit(1);
}

// Clean up
if (existsSync(TEST_LOG_DIR)) {
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
}

console.log('\n=== All Tests Passed ===');
console.log('Compiled logger functional, privacy-safe, non-throwing.');
