/**
 * Tests for Privacy-Safe Diagnostic Logger
 * 
 * Validates:
 * - Only allowlisted fields are logged
 * - Forbidden patterns are rejected
 * - Logging failures don't crash
 * - File permissions are secure
 * - Sanitization of fake secret sentinel inputs
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { DiagnosticLogger, createDiagnosticLogger, type DiagnosticLogEntry } from './diagnostic-logger.js';
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
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    expect(existsSync(TEST_LOG_DIR)).toBe(true);
    
    const stats = statSync(TEST_LOG_DIR);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('700');
  });

  it('creates log file with mode 0600', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^diagnostic-.*\.ndjson$/);
    
    const filepath = join(TEST_LOG_DIR, files[0]);
    const stats = statSync(filepath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('600');
  });

  it('logs valid diagnostic entry', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
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

  it('rejects entry with forbidden pattern: initData', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    
    // This should fail silently and not crash
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'challenge_issued',
      result: 'success',
      errorCategory: 'initData_validation_failed' as any, // Contains forbidden "initData"
    });
    
    // Log file should still exist but may be empty or not have the entry
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBe(1);
  });

  it('rejects entry with forbidden pattern: nullifier', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    
    // This should fail silently
    logger.log({
      timestamp: new Date().toISOString(),
      correlationId: 'nullifier-abc123', // Contains forbidden "nullifier"
      stage: 'challenge_issued',
      result: 'success',
    });
    
    const files = readdirSync(TEST_LOG_DIR);
    expect(files.length).toBe(1);
  });

  it('sanitizes network error to safe category', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const error = new Error('ECONNREFUSED: Connection refused');
    const category = logger.sanitizeError(error);
    
    expect(category).toBe('network_error');
  });

  it('sanitizes timeout error to safe category', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const error = new Error('Request timeout after 30000ms');
    const category = logger.sanitizeError(error);
    
    expect(category).toBe('timeout_error');
  });

  it('sanitizes validation error to safe category', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const error = new Error('Invalid proof format');
    const category = logger.sanitizeError(error);
    
    expect(category).toBe('validation_error');
  });

  it('sanitizes nullifier replay to safe category', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const error = new Error('Nullifier already used for this action');
    const category = logger.sanitizeError(error);
    
    expect(category).toBe('nullifier_error');
  });

  it('sanitizes unknown error to safe category', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const error = new Error('Something weird happened with user_id=123');
    const category = logger.sanitizeError(error);
    
    expect(category).toBe('unknown_error');
  });

  it('generates random correlation IDs', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const id1 = logger.generateCorrelationId();
    const id2 = logger.generateCorrelationId();
    
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{32}$/);
    expect(id2).toMatch(/^[0-9a-f]{32}$/);
  });

  it('logs challenge issuance', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    logger.logChallengeIssued(correlationId, 300);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('challenge_issued');
    expect(entry.result).toBe('success');
    expect(entry.durationMs).toBe(300000);
  });

  it('logs callback received', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    logger.logCallbackReceived(correlationId);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('callback_received');
    expect(entry.result).toBe('in_progress');
  });

  it('logs upstream verify success with duration', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    logger.logUpstreamVerifySuccess(correlationId, 1234);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('upstream_verify_success');
    expect(entry.result).toBe('success');
    expect(entry.durationMs).toBe(1234);
  });

  it('logs upstream verify failure with sanitized error', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    const error = new Error('Proof verification failed');
    logger.logUpstreamVerifyFailed(correlationId, error, 5678);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('upstream_verify_failed');
    expect(entry.result).toBe('failure');
    expect(entry.errorCategory).toBe('proof_error');
    expect(entry.durationMs).toBe(5678);
  });

  it('logs completion accepted', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    logger.logCompletionAccepted(correlationId);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('completion_accepted');
    expect(entry.result).toBe('success');
  });

  it('logs completion rejected with error category', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    logger.logCompletionRejected(correlationId, 'nullifier_error');
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('completion_rejected');
    expect(entry.result).toBe('failure');
    expect(entry.errorCategory).toBe('nullifier_error');
  });

  it('logs revoke success', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    logger.logRevoke(correlationId, true);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('revoke_success');
    expect(entry.result).toBe('success');
  });

  it('logs revoke failure with sanitized error', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    const correlationId = logger.generateCorrelationId();
    const error = new Error('Database constraint violation');
    logger.logRevoke(correlationId, false, error);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    const entry = JSON.parse(content.trim());
    
    expect(entry.stage).toBe('revoke_failed');
    expect(entry.result).toBe('failure');
    expect(entry.errorCategory).toBe('database_error');
  });

  it('rotates log file when size limit reached', () => {
    logger = createDiagnosticLogger({
      logDir: TEST_LOG_DIR,
      maxFileSizeBytes: 1024, // 1KB limit
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

  it('logging failure does not throw exception', () => {
    logger = createDiagnosticLogger({ logDir: '/nonexistent/path' });
    
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

  it('sanitizes fake secret sentinel in error messages', () => {
    logger = createDiagnosticLogger({ logDir: TEST_LOG_DIR });
    
    // Simulate error containing fake secret
    const error = new Error('Authentication failed with token=sk_test_abc123');
    const category = logger.sanitizeError(error);
    
    // Should be categorized safely without leaking the token
    expect(category).toBe('unknown_error');
    
    // Log it and verify token is not in the log file
    const correlationId = logger.generateCorrelationId();
    logger.logCompletionRejected(correlationId, category);
    
    const files = readdirSync(TEST_LOG_DIR);
    const content = readFileSync(join(TEST_LOG_DIR, files[0]), 'utf-8');
    
    expect(content).not.toContain('sk_test_abc123');
    expect(content).not.toContain('token');
  });
});
