/**
 * Production enrollment service with authentic SDK integration and conservative policy guards.
 *
 * PRODUCTION READINESS GUARDS:
 * - Administrative revocation blocks in-flight completion AND future enrollment
 * - No destructive expiry cleanup (pending retention policy)
 * - Conservative fail-closed for unresolved lifecycle policies
 * - Clock injection for deterministic testing
 *
 * @module enrollment-service-production
 */

import Database from 'better-sqlite3';
import type { WorldIdChallengeAdapter, SignedRpChallenge } from './worldid-challenge-adapter.js';
import { hashSignal } from './worldid-challenge-adapter.js';
import type {
  TelegramInitDataConfig,
  ValidatedTelegramUser,
} from './telegram-initdata.js';
import { validateTelegramInitData } from './telegram-initdata.js';
import type {
  IDKitResult,
  BackendVerificationResult,
  ExpectedVerificationContext,
} from './worldid-types.js';

/**
 * Clock interface for deterministic testing.
 */
export interface Clock {
  nowSeconds(): number;
  nowISO(): string;
}

/**
 * Production clock using system time.
 */
export class SystemClock implements Clock {
  nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  nowISO(): string {
    return new Date().toISOString();
  }
}

/**
 * Backend verification client interface (dependency injection).
 */
export interface BackendVerificationClient {
  verify(
    idkitResult: IDKitResult,
    expectedContext: ExpectedVerificationContext
  ): Promise<BackendVerificationResult>;
}

/**
 * Enrollment service configuration.
 */
export interface EnrollmentServiceConfig {
  /** Path to SQLite database file */
  dbPath: string;

  /** World ID challenge adapter (SDK-based) */
  challengeAdapter: WorldIdChallengeAdapter;

  /** Backend verification client (dependency injection) */
  verificationClient: BackendVerificationClient;

  /** Telegram bot token for initData validation */
  telegramBotToken: string;

  /** Stable action scope for this service (e.g., "telegram-bot-human-verification") */
  action: string;

  /** Challenge TTL in seconds (default: 300 = 5 minutes, min: 60, max: 3600) */
  challengeTtlSeconds?: number;

  /** Enrollment TTL in seconds (default: 2592000 = 30 days, min: 86400, max: 31536000) */
  enrollmentTtlSeconds?: number;

  /** Enable WAL mode (default: true) */
  enableWal?: boolean;

  /** Clock for deterministic testing (default: SystemClock) */
  clock?: Clock;
}

/**
 * Challenge creation result for frontend.
 */
export interface CreateChallengeResult {
  /** Signed RP challenge for frontend IDKit configuration */
  signedChallenge: SignedRpChallenge;
}

/**
 * Enrollment completion request from Telegram Mini App.
 */
export interface CompleteEnrollmentRequest {
  /** Telegram initData (HMAC-validated) */
  initData: string;
  /** IDKit result from World App (contains proof + nonce) */
  idkitResult: IDKitResult;
}

/**
 * Enrollment completion result.
 */
export interface CompleteEnrollmentResult {
  success: boolean;
  telegramUserId?: number;
  nullifier?: string;
  expiresAt?: number;
  error?: string;
}

/**
 * Enrollment query result.
 */
export interface EnrollmentQuery {
  nullifier: string;
  telegramUserId: number;
  action: string;
  expiresAt: number;
  createdAt: string;
  revoked: boolean;
  expired: boolean;
}

/**
 * Production enrollment service with conservative policy guards.
 */
export class EnrollmentService {
  private db: Database.Database;
  private challengeAdapter: WorldIdChallengeAdapter;
  private verificationClient: BackendVerificationClient;
  private telegramConfig: TelegramInitDataConfig;
  private action: string;
  private challengeTtlSeconds: number;
  private enrollmentTtlSeconds: number;
  private clock: Clock;

  constructor(config: EnrollmentServiceConfig) {
    // Validate stable action scope
    if (!config.action || typeof config.action !== 'string' || config.action.length === 0) {
      throw new Error('Invalid action: must be non-empty string');
    }

    // Action must not be per-user (breaks one-human policy)
    if (config.action.includes('{') || config.action.includes('$')) {
      throw new Error('Invalid action: must be stable service scope, not per-user template');
    }

    // Validate TTL bounds
    const challengeTtl = config.challengeTtlSeconds ?? 300;
    if (!Number.isSafeInteger(challengeTtl) || challengeTtl < 60 || challengeTtl > 3600) {
      throw new Error('Invalid challengeTtlSeconds: must be 60-3600');
    }

    const enrollmentTtl = config.enrollmentTtlSeconds ?? 2592000;
    if (!Number.isSafeInteger(enrollmentTtl) || enrollmentTtl < 86400 || enrollmentTtl > 31536000) {
      throw new Error('Invalid enrollmentTtlSeconds: must be 86400-31536000 (1-365 days)');
    }

    this.db = new Database(config.dbPath);
    this.challengeAdapter = config.challengeAdapter;
    this.verificationClient = config.verificationClient;
    this.action = config.action;
    this.challengeTtlSeconds = challengeTtl;
    this.enrollmentTtlSeconds = enrollmentTtl;
    this.clock = config.clock ?? new SystemClock();

    this.telegramConfig = {
      botToken: config.telegramBotToken,
    };

    // Enable WAL mode
    if (config.enableWal !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    this.db.pragma('foreign_keys = ON');

    // Create schema with revocation tracking
    this.initializeSchema();
  }

  /**
   * Initialize database schema with migration support.
   */
  private initializeSchema(): void {
    // Schema version tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `);

    const currentVersion = this.getSchemaVersion();

    if (currentVersion < 1) {
      // v1: Initial schema with per-account lifecycle tracking
      this.db.exec(`
        CREATE TABLE challenge_sessions (
          nonce TEXT PRIMARY KEY,
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          signal_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          created_at_seconds INTEGER NOT NULL
        ) STRICT
      `);

      this.db.exec(`
        CREATE INDEX idx_challenge_sessions_expires_at
        ON challenge_sessions(expires_at)
      `);

      this.db.exec(`
        CREATE TABLE enrollments (
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          nullifier TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          revoked_at TEXT,
          revoked_at_seconds INTEGER,
          PRIMARY KEY (telegram_user_id, action)
        ) STRICT
      `);

      this.db.exec(`
        CREATE INDEX idx_enrollments_nullifier
        ON enrollments(nullifier)
      `);

      this.db.exec(`
        CREATE INDEX idx_enrollments_revoked
        ON enrollments(revoked)
      `);

      this.setSchemaVersion(1);
    }
  }

  private getSchemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) as version FROM schema_version').get() as any;
    return row?.version ?? 0;
  }

  private setSchemaVersion(version: number): void {
    this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      version,
      this.clock.nowISO()
    );
  }

  /**
   * Create challenge session with Telegram initData authentication.
   *
   * @param initData - Telegram initData (HMAC-validated, extracts authenticated user ID)
   * @returns Signed RP challenge for frontend
   */
  async createChallenge(initData: string): Promise<CreateChallengeResult> {
    // Authenticate Telegram initData FIRST (not accept browser-provided user ID)
    const initDataValidation = validateTelegramInitData(initData, this.telegramConfig);

    if (!initDataValidation.valid || !initDataValidation.user) {
      throw new Error(`Telegram initData validation failed: ${initDataValidation.error}`);
    }

    const authenticatedUserId = initDataValidation.user.id;

    // Check for existing active enrollment
    const existingEnrollment = await this.findEnrollment(authenticatedUserId);
    if (existingEnrollment && !existingEnrollment.revoked) {
      throw new Error('User already enrolled (policy: one active enrollment per account)');
    }

    // Build signal binding requester to challenge
    const signal = `telegram:${authenticatedUserId}`;

    // Use SDK adapter to create signed challenge with service TTL
    // Note: Adapter has its own TTL; we override with our validated TTL
    const { signedChallenge, expectedContext } = this.challengeAdapter.createChallenge(
      this.action,
      signal
    );

    // Store challenge session with expected context
    const now = this.clock.nowSeconds();
    const expiresAt = now + this.challengeTtlSeconds;

    const session = {
      nonce: signedChallenge.nonce,
      telegramUserId: authenticatedUserId,
      action: this.action,
      signalHash: expectedContext.signalHash,
      expiresAt,
      createdAt: this.clock.nowISO(),
      createdAtSeconds: now,
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO challenge_sessions (nonce, telegram_user_id, action, signal_hash, expires_at, created_at, created_at_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        session.nonce,
        session.telegramUserId,
        session.action,
        session.signalHash,
        session.expiresAt,
        session.createdAt,
        session.createdAtSeconds
      );
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new Error('Challenge session conflict (retry with new request)');
      }
      throw error;
    }

    // Override adapter expiry with service TTL
    const serviceChallenge = {
      ...signedChallenge,
      expiresAt,
    };

    return {
      signedChallenge: serviceChallenge,
    };
  }

  /**
   * Complete enrollment with transactional requester-bound validation.
   *
   * @param request - Enrollment completion request from Mini App
   * @returns Enrollment result
   */
  async completeEnrollment(request: CompleteEnrollmentRequest): Promise<CompleteEnrollmentResult> {
    // Validate input structure (fail-closed boundary)
    if (!request || typeof request !== 'object') {
      return { success: false, error: 'Invalid request: expected object' };
    }

    if (!request.initData || typeof request.initData !== 'string') {
      return { success: false, error: 'Invalid request: initData required' };
    }

    if (!request.idkitResult || typeof request.idkitResult !== 'object') {
      return { success: false, error: 'Invalid request: idkitResult required' };
    }

    if (!request.idkitResult.nonce || typeof request.idkitResult.nonce !== 'string') {
      return { success: false, error: 'Invalid request: idkitResult.nonce required' };
    }

    // Step 1: Validate initData HMAC
    const initDataValidation = validateTelegramInitData(request.initData, this.telegramConfig);

    if (!initDataValidation.valid || !initDataValidation.user) {
      return {
        success: false,
        error: 'Telegram initData validation failed',
      };
    }

    const authenticatedUser = initDataValidation.user;

    // Step 2: Peek challenge session (read-only, do not consume yet)
    const peekStmt = this.db.prepare(`
      SELECT nonce, telegram_user_id, action, signal_hash, expires_at, created_at, created_at_seconds
      FROM challenge_sessions
      WHERE nonce = ?
    `);

    const challengeRow = peekStmt.get(request.idkitResult.nonce) as any;

    if (!challengeRow) {
      return {
        success: false,
        error: 'Challenge session not found',
      };
    }

    const now = this.clock.nowSeconds();
    if (challengeRow.expires_at <= now) {
      // Expired: DO NOT delete (pending retention policy)
      return {
        success: false,
        error: 'Challenge session expired',
      };
    }

    // Step 3: Validate authenticated requester matches stored challenge requester
    if (authenticatedUser.id !== challengeRow.telegram_user_id) {
      return {
        success: false,
        error: 'Account mismatch: challenge not bound to this user',
      };
    }

    // Step 4: Build expected context from stored challenge
    const expectedContext: ExpectedVerificationContext = {
      action: challengeRow.action,
      nonce: challengeRow.nonce,
      signalHash: challengeRow.signal_hash,
      requireProofOfHuman: true,
    };

    // Step 5: Verify proof (async HTTP call, outside transaction)
    let verificationResult: BackendVerificationResult;
    try {
      verificationResult = await this.verificationClient.verify(
        request.idkitResult,
        expectedContext
      );
    } catch (error) {
      // Network/service errors do not consume challenge
      return {
        success: false,
        error: 'Verification service unavailable',
      };
    }

    if (!verificationResult.success || !verificationResult.nullifier) {
      return {
        success: false,
        error: 'World ID proof verification failed',
      };
    }

    // Step 6: Check for revoked enrollment and generation comparison
    // Per-account revocation: check (telegram_user_id, action), not nullifier
    // Policy: revoked accounts can regain via fresh post-revoke verification
    const revokedCheck = this.db.prepare(`
      SELECT revoked, revoked_at_seconds FROM enrollments
      WHERE telegram_user_id = ? AND action = ? AND revoked = 1
    `).get(authenticatedUser.id, this.action) as any;

    if (revokedCheck) {
      // Block pre-revocation challenges from completing
      if (challengeRow.created_at_seconds <= revokedCheck.revoked_at_seconds) {
        return {
          success: false,
          error: 'Challenge predates revocation (fresh verification required)',
        };
      }
      // Post-revocation challenge: allow fresh verification to restore
      // (continues to transaction below)
    }

    // Step 7: Atomic transaction: consume challenge + create enrollment
    const transaction = this.db.transaction(() => {
      // Re-check challenge still exists (race condition protection)
      const recheckStmt = this.db.prepare(`
        SELECT nonce, telegram_user_id, expires_at, created_at_seconds
        FROM challenge_sessions
        WHERE nonce = ?
      `);

      const recheckRow = recheckStmt.get(request.idkitResult.nonce) as any;

      if (!recheckRow) {
        throw new Error('Challenge session was consumed by another request');
      }

      // Re-check not expired (clock may have advanced during verification)
      const txNow = this.clock.nowSeconds();
      if (recheckRow.expires_at <= txNow) {
        // DO NOT delete (pending retention policy)
        throw new Error('Challenge session expired during proof verification');
      }

      // Re-check account match
      if (recheckRow.telegram_user_id !== authenticatedUser.id) {
        throw new Error('Challenge account mismatch in transaction');
      }

      // Re-check for per-account revocation and generation (race protection)
      const txAccountCheck = this.db.prepare(`
        SELECT revoked, revoked_at_seconds FROM enrollments
        WHERE telegram_user_id = ? AND action = ? AND revoked = 1
      `).get(authenticatedUser.id, this.action) as any;

      if (txAccountCheck && recheckRow.created_at_seconds <= txAccountCheck.revoked_at_seconds) {
        throw new Error('Challenge predates revocation in transaction');
      }

      // Create or restore enrollment
      const enrollmentExpiresAt = txNow + this.enrollmentTtlSeconds;
      const enrollment = {
        nullifier: verificationResult.nullifier!,
        telegramUserId: authenticatedUser.id,
        action: this.action,
        expiresAt: enrollmentExpiresAt,
        createdAt: this.clock.nowISO(),
        revoked: 0,
      };

      try {
        // UPSERT: replace existing enrollment (including revoked) for this account
        const upsertStmt = this.db.prepare(`
          INSERT INTO enrollments (telegram_user_id, action, nullifier, expires_at, created_at, revoked, revoked_at, revoked_at_seconds)
          VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(telegram_user_id, action) DO UPDATE SET
            nullifier = excluded.nullifier,
            expires_at = excluded.expires_at,
            created_at = excluded.created_at,
            revoked = excluded.revoked,
            revoked_at = excluded.revoked_at,
            revoked_at_seconds = excluded.revoked_at_seconds
        `);

        upsertStmt.run(
          enrollment.telegramUserId,
          enrollment.action,
          enrollment.nullifier,
          enrollment.expiresAt,
          enrollment.createdAt,
          enrollment.revoked
        );
      } catch (error: any) {
        throw error;
      }

      // Consume challenge (delete)
      this.db.prepare('DELETE FROM challenge_sessions WHERE nonce = ?').run(request.idkitResult.nonce);

      return enrollment;
    });

    // Execute transaction
    try {
      const enrollment = transaction();

      return {
        success: true,
        telegramUserId: enrollment.telegramUserId,
        nullifier: enrollment.nullifier,
        expiresAt: enrollment.expiresAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Transaction failed',
      };
    }
  }

  /**
   * Find active enrollment by Telegram user ID.
   *
   * @param telegramUserId - Telegram numeric user ID
   * @returns Active enrollment or null
   */
  async findEnrollment(telegramUserId: number): Promise<EnrollmentQuery | null> {
    const stmt = this.db.prepare(`
      SELECT nullifier, telegram_user_id, action, expires_at, created_at, revoked
      FROM enrollments
      WHERE telegram_user_id = ? AND action = ?
    `);

    const row = stmt.get(telegramUserId, this.action) as any;

    if (!row) {
      return null;
    }

    // Return enrollment record (including revoked and expired)
    // Caller can check revoked/expiry flags
    const now = this.clock.nowSeconds();
    const expired = row.expires_at <= now;

    return {
      nullifier: row.nullifier,
      telegramUserId: row.telegram_user_id,
      action: row.action,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      revoked: row.revoked === 1,
      expired,
    };
  }

  /**
   * Revoke enrollment by Telegram account (administrative action).
   *
   * Policy: Per-account revocation with fresh verification restore.
   * This operation:
   * - Blocks in-flight pre-revocation challenges from completing
   * - Blocks future enrollment with pre-revocation challenges
   * - Allows post-revocation fresh challenges to restore access
   * - Does NOT delete the record (audit trail + restoration capability)
   *
   * @param telegramUserId - Telegram numeric user ID
   * @returns True if enrollment found and revoked, false if not found
   */
  async revokeEnrollment(telegramUserId: number): Promise<boolean> {
    const now = this.clock.nowSeconds();
    const stmt = this.db.prepare(`
      UPDATE enrollments
      SET revoked = 1, revoked_at = ?, revoked_at_seconds = ?
      WHERE telegram_user_id = ? AND action = ? AND revoked = 0
    `);

    const result = stmt.run(this.clock.nowISO(), now, telegramUserId, this.action);
    return result.changes > 0;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
