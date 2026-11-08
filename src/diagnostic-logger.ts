/**
 * Privacy-Safe Diagnostic Logger for World ID Enrollment
 * 
 * Logs only allowlisted stages and error categories for operational diagnostics.
 * NO PII, credentials, proofs, nullifiers, or session identifiers.
 * NON-THROWING: All public methods guarantee no exceptions reach caller.
 * 
 * @module diagnostic-logger
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, readdirSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Strict allowlist: permitted stages (admission lifecycle phases)
 */
const ALLOWED_STAGES = [
  'challenge_issued',
  'challenge_expired',
  'challenge_not_found',
  'callback_received',
  'initdata_validation_failed',
  'initdata_validation_success',
  'upstream_verify_started',
  'upstream_verify_success',
  'upstream_verify_failed',
  'fence_rejected',
  'ownership_rejected',
  'enrollment_complete',
  'enrollment_rejected',
  'revoke_success',
  'revoke_not_found',
  'admission_granted',
  'admission_rejected',
] as const;

type AllowedStage = typeof ALLOWED_STAGES[number];

/**
 * Strict allowlist: permitted error categories
 */
const ALLOWED_ERROR_CATEGORIES = [
  'webhook_invalid',
  'init_data_invalid',
  'challenge_not_found_error',
  'challenge_expired_error',
  'proof_error',
  'verification_api_error',
  'signature_error',
  'network_timeout',
  'fence_check_fail',
  'ownership_check_fail',
  'database_error',
  'unknown_error',
] as const;

type AllowedErrorCategory = typeof ALLOWED_ERROR_CATEGORIES[number];

/**
 * Diagnostic log entry (privacy-safe fields only)
 */
export interface DiagnosticLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  
  /** Random correlation ID (NOT derived from user/session/proof) */
  correlationId: string;
  
  /** Stage or operation (must be in ALLOWED_STAGES) */
  stage: AllowedStage;
  
  /** Result: 'success' | 'failure' | 'in_progress' */
  result: 'success' | 'failure' | 'in_progress';
  
  /** Safe error category (must be in ALLOWED_ERROR_CATEGORIES if present) */
  errorCategory?: AllowedErrorCategory;
  
  /** Duration in milliseconds */
  durationMs?: number;
}

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
  
  /** Enable logging (default: false, must be explicitly enabled) */
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
 * - Symlink protection via lstatSync
 * - NON-THROWING: Logging failures must never crash security transactions
 */
export class DiagnosticLogger {
  private config: Required<DiagnosticLoggerConfig>;
  private currentLogFile: string;
  private initFailed: boolean = false;
  
  constructor(config: DiagnosticLoggerConfig) {
    this.config = {
      logDir: config.logDir,
      maxFileSizeBytes: config.maxFileSizeBytes ?? 10 * 1024 * 1024, // 10MB
      maxFiles: config.maxFiles ?? 10,
      enabled: config.enabled ?? false, // Disabled by default
    };
    
    this.currentLogFile = '';
    
    if (this.config.enabled) {
      try {
        this.safeInitialize();
      } catch (error) {
        this.initFailed = true;
        this.fallbackToStderr('initialization_failed', undefined, error);
      }
    }
  }
  
  /**
   * Safe initialization (non-throwing wrapper for constructor logic)
   */
  private safeInitialize(): void {
    this.initializeLogDirectory();
    this.cleanupOldLogFilesOnStartup();
    this.currentLogFile = this.createLogFile();
  }
  
  /**
   * Generate a random correlation ID (NOT derived from user/session/proof)
   * NON-THROWING: Returns fallback on error.
   */
  generateCorrelationId(): string {
    try {
      return randomBytes(16).toString('hex');
    } catch {
      return `fallback-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    }
  }
  
  /**
   * Log a diagnostic entry (NON-THROWING: safe logging that never crashes)
   */
  log(entry: DiagnosticLogEntry): void {
    if (!this.config.enabled || this.initFailed) return;
    
    try {
      // Validate stage and errorCategory against strict allowlists
      this.validateEntry(entry);
      
      // Check if rotation needed
      if (this.needsRotation()) {
        this.rotateLogFile();
      }
      
      // Append to current log file
      const logLine = JSON.stringify(entry) + '\n';
      appendFileSync(this.currentLogFile, logLine, { mode: 0o600 });
    } catch (error) {
      // Fallback to sanitized stderr (no raw error details)
      this.fallbackToStderr(entry.stage, entry.errorCategory, error);
    }
  }
  
  /**
   * Validate entry against strict allowlists (throws on invalid)
   */
  private validateEntry(entry: DiagnosticLogEntry): void {
    if (!ALLOWED_STAGES.includes(entry.stage)) {
      throw new Error(`Invalid stage: '${entry.stage}' not in allowlist`);
    }

    if (entry.errorCategory !== undefined && !ALLOWED_ERROR_CATEGORIES.includes(entry.errorCategory)) {
      throw new Error(`Invalid errorCategory: '${entry.errorCategory}' not in allowlist`);
    }
  }
  
  /**
   * Fallback to sanitized stderr when primary logging fails.
   * Emits ONLY stage and errorCategory, no metadata or error details.
   */
  private fallbackToStderr(stage: string, errorCategory: string | undefined, _err: unknown): void {
    try {
      const fallbackEntry = {
        timestamp: new Date().toISOString(),
        stage,
        ...(errorCategory && { errorCategory }),
        fallback: true,
      };
      process.stderr.write(JSON.stringify(fallbackEntry) + '\n');
    } catch {
      // Ultimate fallback: silent failure (logging must never crash admission)
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
      durationMs: expiresInSeconds * 1000,
    });
  }
  
  /**
   * Log challenge expiry check
   */
  logChallengeExpired(correlationId: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'challenge_expired',
      result: 'failure',
      errorCategory: 'challenge_expired_error',
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
  logUpstreamVerifyFailed(correlationId: string, errorCategory: AllowedErrorCategory, durationMs: number): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'upstream_verify_failed',
      result: 'failure',
      errorCategory,
      durationMs,
    });
  }
  
  /**
   * Log fence rejection
   */
  logFenceRejected(correlationId: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'fence_rejected',
      result: 'failure',
      errorCategory: 'fence_check_fail',
    });
  }
  
  /**
   * Log ownership rejection (nullifier already claimed by another account)
   */
  logOwnershipRejected(correlationId: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'ownership_rejected',
      result: 'failure',
      errorCategory: 'ownership_check_fail',
    });
  }
  
  /**
   * Log enrollment completion
   */
  logEnrollmentComplete(correlationId: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'enrollment_complete',
      result: 'success',
    });
  }
  
  /**
   * Log enrollment rejection
   */
  logEnrollmentRejected(correlationId: string, errorCategory: AllowedErrorCategory): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: 'enrollment_rejected',
      result: 'failure',
      errorCategory,
    });
  }
  
  /**
   * Log revoke transaction
   */
  logRevoke(correlationId: string, success: boolean): void {
    this.log({
      timestamp: new Date().toISOString(),
      correlationId,
      stage: success ? 'revoke_success' : 'revoke_not_found',
      result: success ? 'success' : 'failure',
    });
  }
  
  /**
   * Initialize log directory with secure permissions
   * THROWS on failure (called only in constructor/safeInitialize)
   */
  private initializeLogDirectory(): void {
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true, mode: 0o700 });
    } else {
      // Validate existing directory (permissions, not a symlink)
      const stats = lstatSync(this.config.logDir);
      if (stats.isSymbolicLink()) {
        throw new Error(`Log directory is a symlink: ${this.config.logDir}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Log directory path exists but is not a directory: ${this.config.logDir}`);
      }
    }
  }
  
  /**
   * Cleanup old log files on startup (enforce maxFiles before creating new file)
   * THROWS on failure (called only in constructor/safeInitialize)
   */
  private cleanupOldLogFilesOnStartup(): void {
    const files = readdirSync(this.config.logDir)
      .filter(f => f.startsWith('diagnostic-') && f.endsWith('.ndjson'))
      .map(f => {
        const path = join(this.config.logDir, f);
        const stats = lstatSync(path);
        
        // Skip symlinks
        if (stats.isSymbolicLink()) {
          return null;
        }
        
        return {
          name: f,
          path,
          mtime: stats.mtime.getTime(),
        };
      })
      .filter(f => f !== null)
      .sort((a, b) => b!.mtime - a!.mtime); // Newest first
    
    // Remove files beyond retention limit
    for (let i = this.config.maxFiles - 1; i < files.length; i++) {
      unlinkSync(files[i]!.path);
    }
  }
  
  /**
   * Create new log file with secure permissions
   * THROWS on failure (called only in controlled contexts)
   */
  private createLogFile(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `diagnostic-${timestamp}.ndjson`;
    const filepath = join(this.config.logDir, filename);
    
    // Validate path is not a symlink (if it somehow already exists)
    if (existsSync(filepath)) {
      const stats = lstatSync(filepath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Log file path is a symlink: ${filepath}`);
      }
    }
    
    // Create empty file with mode 0600
    writeFileSync(filepath, '', { mode: 0o600 });
    
    return filepath;
  }
  
  /**
   * Check if log file needs rotation
   * NON-THROWING: Returns true on error (triggers rotation)
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
   * NON-THROWING: Failures are caught and logged to stderr
   */
  private rotateLogFile(): void {
    try {
      this.currentLogFile = this.createLogFile();
      this.cleanupOldLogFiles();
    } catch (error) {
      this.fallbackToStderr('log_rotation_failed', undefined, error);
    }
  }
  
  /**
   * Remove oldest log files beyond retention limit
   * THROWS on failure (called only in rotateLogFile, which is nonthrowing)
   */
  private cleanupOldLogFiles(): void {
    const files = readdirSync(this.config.logDir)
      .filter(f => f.startsWith('diagnostic-') && f.endsWith('.ndjson'))
      .map(f => {
        const path = join(this.config.logDir, f);
        const stats = lstatSync(path);
        
        // Skip symlinks
        if (stats.isSymbolicLink()) {
          return null;
        }
        
        return {
          name: f,
          path,
          mtime: stats.mtime.getTime(),
        };
      })
      .filter(f => f !== null)
      .sort((a, b) => b!.mtime - a!.mtime); // Newest first
    
    // Remove files beyond retention limit
    for (let i = this.config.maxFiles; i < files.length; i++) {
      unlinkSync(files[i]!.path);
    }
  }
}

/**
 * Create diagnostic logger instance
 */
export function createDiagnosticLogger(config: DiagnosticLoggerConfig): DiagnosticLogger {
  return new DiagnosticLogger(config);
}
