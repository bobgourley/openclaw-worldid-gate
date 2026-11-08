/**
 * Privacy-Safe Diagnostic Logger for World ID Enrollment
 * 
 * Logs only allowlisted fields for operational diagnostics.
 * NO PII, credentials, proofs, nullifiers, or session identifiers.
 * 
 * @module diagnostic-logger
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Privacy-safe diagnostic log entry categories
 */
export type DiagnosticCategory =
  | 'challenge_issued'
  | 'challenge_expired'
  | 'challenge_not_found'
  | 'sdk_poll_timeout'
  | 'callback_received'
  | 'initdata_validation_failed'
  | 'initdata_validation_success'
  | 'proof_validation_started'
  | 'proof_validation_success'
  | 'proof_validation_failed'
  | 'upstream_verify_started'
  | 'upstream_verify_success'
  | 'upstream_verify_failed'
  | 'upstream_verify_timeout'
  | 'fence_rejected'
  | 'ownership_rejected'
  | 'duplicate_enrollment_rejected'
  | 'revoke_started'
  | 'revoke_success'
  | 'revoke_failed'
  | 'revoke_not_found'
  | 'completion_accepted'
  | 'completion_rejected'
  | 'unknown_error';

/**
 * Diagnostic log entry (privacy-safe fields only)
 */
export interface DiagnosticLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  
  /** Random correlation ID (NOT derived from user/session/proof) */
  correlationId: string;
  
  /** Stage or operation */
  stage: DiagnosticCategory;
  
  /** Result: 'success' | 'failure' | 'in_progress' */
  result: 'success' | 'failure' | 'in_progress';
  
  /** Safe error category (no stack traces, no raw errors) */
  errorCategory?: string;
  
  /** SDK/protocol version */
  version?: string;
  
  /** Duration in milliseconds */
  durationMs?: number;
}

/**
 * Sanitized error categories (no raw error messages)
 */
export type SafeErrorCategory =
  | 'network_error'
  | 'timeout_error'
  | 'validation_error'
  | 'proof_error'
  | 'signature_error'
  | 'timestamp_error'
  | 'nullifier_error'
  | 'credential_error'
  | 'database_error'
  | 'unknown_error';

/**
 * Configuration for diagnostic logger
 */
export interface DiagnosticLoggerConfig {
  /** Log directory path */
  logDir: string;
  
  /** Max log file size in bytes (default: 10MB) */
  maxFileSizeBytes?: number;
  
  /** Max number of log files to retain (default: 10) */
  maxFiles?: number;
  
  /** Enable logging (default: true) */
  enabled?: boolean;
}

/**
 * Privacy-Safe Diagnostic Logger
 * 
 * Constraints:
 * - NO request URLs, headers, bodies
 * - NO initData, user IDs, chat IDs, or hashes thereof
 * - NO signatures, challenges, session IDs, nonces
 * - NO nullifiers, proofs, connector URIs
 * - NO IP addresses or credentials
 * - NO raw error messages or stack traces
 * - Correlation IDs are random, NOT derived from identity
 * - Files are mode 0600, directory is mode 0700
 * - Logging failures must not crash security transactions
 */
export class DiagnosticLogger {
  private config: Required<DiagnosticLoggerConfig>;
  private currentLogFile: string;
  
  constructor(config: DiagnosticLoggerConfig) {
    this.config = {
      logDir: config.logDir,
      maxFileSizeBytes: config.maxFileSizeBytes ?? 10 * 1024 * 1024, // 10MB
      maxFiles: config.maxFiles ?? 10,
      enabled: config.enabled ?? true,
    };
    
    if (this.config.enabled) {
      this.initializeLogDirectory();
      this.currentLogFile = this.createLogFile();
    } else {
      this.currentLogFile = '';
    }
  }
  
  /**
   * Generate a random correlation ID (NOT derived from user/session/proof)
   */
  generateCorrelationId(): string {
    return randomBytes(16).toString('hex');
  }
  
  /**
   * Map exception to safe error category (no raw error text)
   */
  sanitizeError(error: unknown): SafeErrorCategory {
    if (!error) return 'unknown_error';
    
    const errorStr = String(error).toLowerCase();
    
    // Network errors
    if (errorStr.includes('econnrefused') || 
        errorStr.includes('enotfound') || 
        errorStr.includes('network') ||
        errorStr.includes('fetch')) {
      return 'network_error';
    }
    
    // Timeout errors
    if (errorStr.includes('timeout') || errorStr.includes('etimedout')) {
      return 'timeout_error';
    }
    
    // Validation errors
    if (errorStr.includes('validation') || 
        errorStr.includes('invalid') || 
        errorStr.includes('malformed')) {
      return 'validation_error';
    }
    
    // Proof/cryptography errors
    if (errorStr.includes('proof') || 
        errorStr.includes('verify') || 
        errorStr.includes('signature')) {
      return 'proof_error';
    }
    
    // Timestamp errors
    if (errorStr.includes('timestamp') || 
        errorStr.includes('expired') ||
        errorStr.includes('clock')) {
      return 'timestamp_error';
    }
    
    // Nullifier errors
    if (errorStr.includes('nullifier') || errorStr.includes('replay')) {
      return 'nullifier_error';
    }
    
    // Credential errors
    if (errorStr.includes('credential') || errorStr.includes('unavailable')) {
      return 'credential_error';
    }
    
    // Database errors
    if (errorStr.includes('database') || 
        errorStr.includes('sqlite') ||
        errorStr.includes('constraint')) {
      return 'database_error';
    }
    
    return 'unknown_error';
  }
  
  /**
   * Log a diagnostic entry (safe logging that never crashes)
   */
  log(entry: DiagnosticLogEntry): void {
    if (!this.config.enabled) return;
    
    try {
      // Validate entry has no forbidden fields
      this.validateEntry(entry);
      
      // Check if rotation needed
      if (this.needsRotation()) {
        this.rotateLogFile();
      }
      
      // Append to current log file
      const logLine = JSON.stringify(entry) + '\n';
      appendFileSync(this.currentLogFile, logLine, { mode: 0o600 });
    } catch (error) {
      // Logging failure must not crash security transactions
      // Log to stderr but continue
      console.error('Diagnostic logging failed (non-fatal):', error);
    }
  }
  
  /**
   * Log challenge issuance
   */
  logChallengeIssued(correlationId: string, expiresInSeconds: number): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'challenge_issued',
      result: 'success',
      durationMs: expiresInSeconds * 1000, // Log TTL as duration
    });
  }
  
  /**
   * Log callback received
   */
  logCallbackReceived(correlationId: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'callback_received',
      result: 'in_progress',
    });
  }
  
  /**
   * Log upstream verification started
   */
  logUpstreamVerifyStarted(correlationId: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'upstream_verify_started',
      result: 'in_progress',
    });
  }
  
  /**
   * Log upstream verification success
   */
  logUpstreamVerifySuccess(correlationId: string, durationMs: number): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'upstream_verify_success',
      result: 'success',
      durationMs,
    });
  }
  
  /**
   * Log upstream verification failure
   */
  logUpstreamVerifyFailed(correlationId: string, error: unknown, durationMs: number): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'upstream_verify_failed',
      result: 'failure',
      errorCategory: this.sanitizeError(error),
      durationMs,
    });
  }
  
  /**
   * Log completion accepted
   */
  logCompletionAccepted(correlationId: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'completion_accepted',
      result: 'success',
    });
  }
  
  /**
   * Log completion rejected
   */
  logCompletionRejected(correlationId: string, errorCategory: SafeErrorCategory): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'completion_rejected',
      result: 'failure',
      errorCategory,
    });
  }
  
  /**
   * Log revoke transaction
   */
  logRevoke(correlationId: string, success: boolean, error?: unknown): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: success ? 'revoke_success' : 'revoke_failed',
      result: success ? 'success' : 'failure',
      errorCategory: error ? this.sanitizeError(error) : undefined,
    });
  }
  
  /**
   * Initialize log directory with secure permissions
   */
  private initializeLogDirectory(): void {
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true, mode: 0o700 });
    }
  }
  
  /**
   * Create new log file with secure permissions
   */
  private createLogFile(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `diagnostic-${timestamp}.ndjson`;
    const filepath = join(this.config.logDir, filename);
    
    // Create empty file with mode 0600
    writeFileSync(filepath, '', { mode: 0o600 });
    
    return filepath;
  }
  
  /**
   * Check if log file needs rotation
   */
  private needsRotation(): boolean {
    try {
      const stats = statSync(this.currentLogFile);
      return stats.size >= this.config.maxFileSizeBytes;
    } catch {
      return true; // Rotate on error
    }
  }
  
  /**
   * Rotate log file and clean up old files
   */
  private rotateLogFile(): void {
    this.currentLogFile = this.createLogFile();
    this.cleanupOldLogFiles();
  }
  
  /**
   * Remove oldest log files beyond retention limit
   */
  private cleanupOldLogFiles(): void {
    try {
      const files = readdirSync(this.config.logDir)
        .filter(f => f.startsWith('diagnostic-') && f.endsWith('.ndjson'))
        .map(f => ({
          name: f,
          path: join(this.config.logDir, f),
          mtime: statSync(join(this.config.logDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime); // Newest first
      
      // Remove files beyond retention limit
      for (let i = this.config.maxFiles; i < files.length; i++) {
        unlinkSync(files[i].path);
      }
    } catch (error) {
      // Cleanup failure is non-fatal
      console.error('Log cleanup failed (non-fatal):', error);
    }
  }
  
  /**
   * Validate entry has no forbidden fields (privacy fence)
   */
  private validateEntry(entry: DiagnosticLogEntry): void {
    const entryStr = JSON.stringify(entry).toLowerCase();
    
    // Forbidden patterns (partial list for demonstration)
    const forbiddenPatterns = [
      'initdata',
      'user_id',
      'chat_id',
      'nullifier',
      'proof',
      'signature',
      'session_id',
      'nonce',
      'connector',
      'telegram',
      'password',
      'token',
      'secret',
      'key',
    ];
    
    for (const pattern of forbiddenPatterns) {
      if (entryStr.includes(pattern)) {
        throw new Error(`Forbidden pattern detected in log entry: ${pattern}`);
      }
    }
  }
}

/**
 * Create diagnostic logger instance
 */
export function createDiagnosticLogger(config: DiagnosticLoggerConfig): DiagnosticLogger {
  return new DiagnosticLogger(config);
}
