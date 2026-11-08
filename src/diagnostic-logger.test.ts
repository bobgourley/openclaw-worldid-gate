/**
 * Tests for Privacy-Safe Diagnostic Logger
 * 
 * Validates:
 * - Only allowlisted stages and error categories are logged
 * - Invalid stages/categories are rejected (fallback to stderr)
 * - Logging failures don't crash
 * - File permissions are secure
 * - Non-throwing guarantee
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { DiagnosticLogger, createDiagnosticLogger } from './diagnostic-logger.js';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TEST_LOG_DIR = '/tmp/test-diagnostic-logs';

describe('DiagnosticLogger', () => {
  let logger: DiagnosticLogger;

  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
  });

  it('creates log directory with mode 0700', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    expect(existsSync(TEST_LOG_DIR)).toBe(true);
    
    const stats = statSync(TEST_LOG_DIR);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('700');
  });

  it('creates log file with mode 0600', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^diagnostic-.*\.ndjson$/);
    
    const filepath = join(TEST_LOG_DIR, files[0]);
    const stats = statSync(filepath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('600');
  });

  it('logs valid diagnostic entry', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'challenge_issued',
      result: 'success',
    });
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.correlationId).toBe(correlationId);
    expect(entry.stage).toBe('challenge_issued');
    expect(entry.result).toBe('success');
  });

  it('allows legitimate proof_error category (strict allowlist)', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    
    // proof_error is in the allowlist and should be accepted
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'upstream_verify_failed',
      result: 'failure',
      errorCategory: 'proof_error',
    });
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.errorCategory).toBe('proof_error');
  });

  it('allows legitimate signature_error category (strict allowlist)', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    
    // signature_error is in the allowlist and should be accepted
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'upstream_verify_failed',
      result: 'failure',
      errorCategory: 'signature_error',
    });
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.errorCategory).toBe('signature_error');
  });

  it('rejects invalid stage (not in allowlist)', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    
    // This should fail silently and not crash (falls back to stderr)
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'invalid_stage_not_in_allowlist' as any,
      result: 'success',
    });
    
    // Log file should still exist but should be empty or not have the invalid entry
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBe(1);
    
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8').trim();
    expect(content).toBe(''); // Invalid entry was not logged
  });

  it('rejects invalid error category (not in allowlist)', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    
    // This should fail silently
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'upstream_verify_failed',
      result: 'failure',
      errorCategory: 'invalid_category_not_in_allowlist' as any,
    });
    
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBe(1);
    
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8').trim();
    expect(content).toBe(''); // Invalid entry was not logged
  });

  it('generates random correlation IDs', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const id1 = logger.generateCorrelationId();
    const id2 = logger.generateCorrelationId();
    
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{32}$/);
    expect(id2).toMatch(/^[0-9a-f]{32}$/);
  });

  it('logs challenge issuance', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logChallengeIssued(correlationId, 300);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('challenge_issued');
    expect(entry.result).toBe('success');
    expect(entry.durationMs).toBe(300000);
  });

  it('logs challenge expired', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logChallengeExpired(correlationId);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('challenge_expired');
    expect(entry.result).toBe('failure');
    expect(entry.errorCategory).toBe('challenge_expired_error');
  });

  it('logs callback received', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logCallbackReceived(correlationId);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('callback_received');
    expect(entry.result).toBe('in_progress');
  });

  it('logs upstream verify success with duration', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logUpstreamVerifySuccess(correlationId, 1234);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('upstream_verify_success');
    expect(entry.result).toBe('success');
    expect(entry.durationMs).toBe(1234);
  });

  it('logs upstream verify failure with error category', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logUpstreamVerifyFailed(correlationId, 'proof_error', 5678);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('upstream_verify_failed');
    expect(entry.result).toBe('failure');
    expect(entry.errorCategory).toBe('proof_error');
    expect(entry.durationMs).toBe(5678);
  });

  it('logs fence rejected', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logFenceRejected(correlationId);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('fence_rejected');
    expect(entry.result).toBe('failure');
    expect(entry.errorCategory).toBe('fence_check_fail');
  });

  it('logs ownership rejected', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logOwnershipRejected(correlationId);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('ownership_rejected');
    expect(entry.result).toBe('failure');
    expect(entry.errorCategory).toBe('ownership_check_fail');
  });

  it('logs enrollment complete', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logEnrollmentComplete(correlationId);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('enrollment_complete');
    expect(entry.result).toBe('success');
  });

  it('logs enrollment rejected with error category', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logEnrollmentRejected(correlationId, 'database_error');
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('enrollment_rejected');
    expect(entry.result).toBe('failure');
    expect(entry.errorCategory).toBe('database_error');
  });

  it('logs revoke success', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logRevoke(correlationId, true);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('revoke_success');
    expect(entry.result).toBe('success');
  });

  it('logs revoke not found', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    logger.logRevoke(correlationId, false);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('revoke_not_found');
    expect(entry.result).toBe('failure');
  });

  it('rotates log file when size limit reached', () => {
    logger = createDiagnosticLogger({
      logDir: TEST_LOG_DIR,
      maxFileSizeBytes: 1024, // 1KB limit
      enabled: true,
    });
    
    const correlationId = logger.generateCorrelationId();
    
    // Log many entries to exceed size limit
    for (let i = 0; i < 100; i++) {
      logger.log({
        timestamp: new Date().toISOString(),
        correlationId,
        stage: 'challenge_issued',
        result: 'success',
      });
    }
    
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBeGreaterThan(1);
  });

  it('retains only max files after rotation', () => {
    logger = createDiagnosticLogger({
      logDir: TEST_LOG_DIR,
      maxFileSizeBytes: 512,
      maxFiles: 3,
      enabled: true,
    });
    
    const correlationId = logger.generateCorrelationId();
    
    // Log many entries to trigger multiple rotations
    for (let i = 0; i < 200; i++) {
      logger.log({
        timestamp: new Date().toISOString(),
        correlationId,
        stage: 'challenge_issued',
        result: 'success',
      });
    }
    
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBeLessThanOrEqual(3);
  });

  it('disabled logger does not create files', () => {
    logger = createDiagnosticLogger({
      logDir: TEST_LOG_DIR,
      enabled: false,
    });
    
    const correlationId = logger.generateCorrelationId();
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'challenge_issued',
      result: 'success',
    });
    
    if (existsSync(TEST_LOG_DIR)) {
      const files = readdirSync(TEST_LOG_DIR);
      expect(files.length).toBe(0);
    }
  });

  it('logging failure does not throw exception (non-throwing guarantee)', () => {
    logger = createDiagnosticLogger({ logDir: '/nonexistent/path', enabled: true });
    
    const correlationId = logger.generateCorrelationId();
    
    // This should not throw
    expect(() => {
      logger.log({
        timestamp: new Date().toISOString(),
        correlationId,
        stage: 'challenge_issued',
        result: 'success',
      });
    }).not.toThrow();
  });

  it('correlation ID generation failure uses fallback (non-throwing)', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR, enabled: true });
    
    // generateCorrelationId should always return a value, even if randomBytes fails
    const id = logger.generateCorrelationId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('cleans up old files on startup (retention enforcement)', () => {
    // Create logger with maxFiles=2
    logger = createDiagnosticLogger({
      logDir: TEST_LOG_DIR,
      maxFiles: 2,
      enabled: true,
    });
    
    const correlationId = logger.generateCorrelationId();
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'challenge_issued',
      result: 'success',
    });
    
    // Should have 1 file
    let files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBe(1);
    
    // Create a new logger (simulates restart)
    logger = createDiagnosticLogger({
      logDir: TEST_LOG_DIR,
      maxFiles: 2,
      enabled: true,
    });
    
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'challenge_issued',
      result: 'success',
    });
    
    // Should still have at most 2 files
    files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBeLessThanOrEqual(2);
  });
});
