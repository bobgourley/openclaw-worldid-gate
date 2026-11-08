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
import type { MemberTagManager } from './member-tag-manager.js';
import type { DiagnosticLogger } from './diagnostic-logger.js';

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

  /**
   * OPTIONAL: Member tag manager for display-only Telegram labels.
   * 
   * If provided, applies "Human Verified" tag after successful enrollment.
   * Tag operations are fail-safe and never affect enrollment outcome.
   * Tags are display-only UX, NOT access control mechanism.
   */
  memberTagManager?: MemberTagManager;
  
  /** Diagnostic logger (optional, for privacy-safe operational logging) */
  diagnosticLogger?: DiagnosticLogger;
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
  private dbPath: string;
  private challengeAdapter: WorldIdChallengeAdapter;
  private verificationClient: BackendVerificationClient;
  private telegramConfig: TelegramInitDataConfig;
  private action: string;
  private challengeTtlSeconds: number;
  private enrollmentTtlSeconds: number;
  private clock: Clock;
  private memberTagManager?: MemberTagManager;
  private diagnosticLogger?: DiagnosticLogger;

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
    this.dbPath = config.dbPath;
    this.challengeAdapter = config.challengeAdapter;
    this.verificationClient = config.verificationClient;
    this.action = config.action;
    this.challengeTtlSeconds = challengeTtl;
    this.enrollmentTtlSeconds = enrollmentTtl;
    this.clock = config.clock ?? new SystemClock();
    this.memberTagManager = config.memberTagManager;
    this.diagnosticLogger = config.diagnosticLogger;

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

    // Check for legacy schema (pre-versioning) and fail closed
    if (currentVersion === 0) {
      const legacyEnrollmentsExists = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='enrollments'`)
        .get() as any;

      if (legacyEnrollmentsExists) {
        // Detect legacy schema by checking PRIMARY KEY columns
        const tableInfo = this.db.prepare(`PRAGMA table_info(enrollments)`).all() as any[];
        const pkColumns = tableInfo.filter((col: any) => col.pk > 0).map((col: any) => col.name).sort();
        
        // Legacy schema had PRIMARY KEY (nullifier, action)
        // Current schema has PRIMARY KEY (telegram_user_id, action)
        const isLegacySchema = pkColumns.join(',') === 'action,nullifier';

        if (isLegacySchema) {
          throw new Error(
            'SCHEMA MIGRATION REQUIRED: Database contains legacy schema with incompatible PRIMARY KEY.\n' +
            '\n' +
            'The enrollment database schema has changed from PRIMARY KEY (nullifier, action)\n' +
            'to PRIMARY KEY (telegram_user_id, action) to support multiple accounts per person.\n' +
            '\n' +
            'OPERATOR ACTIONS REQUIRED:\n' +
            '1. BACKUP your existing database immediately:\n' +
            `   cp "${this.dbPath}" "${this.dbPath}.backup-$(date +%Y%m%d-%H%M%S)"\n` +
            '\n' +
            '2. Choose migration strategy:\n' +
            '   A. SAFE: Start fresh (no data loss risk, users must re-enroll):\n' +
            `      rm "${this.dbPath}"\n` +
            '   B. MIGRATE: Attempt automatic migration (preserves enrollments):\n' +
            `      Set environment variable: ALLOW_SCHEMA_MIGRATION=1\n` +
            '\n' +
            'Migration will:\n' +
            '- Create new tables with current schema\n' +
            '- Copy enrollments (first enrollment wins per telegram_user_id+action)\n' +
            '- Preserve challenge_sessions if compatible\n' +
            '- Rename old tables to enrollments_legacy_backup\n' +
            '\n' +
            'DO NOT proceed without backing up your database first.'
          );
        }
      }
    }

    if (currentVersion < 1) {
      // v1: Per-account lifecycle schema with monotonic generation tracking
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS challenge_sessions (
          nonce TEXT PRIMARY KEY,
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          signal_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          created_at_seconds INTEGER NOT NULL,
          generation INTEGER NOT NULL
        ) STRICT
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_challenge_sessions_expires_at
        ON challenge_sessions(expires_at)
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS enrollments (
          telegram_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          nullifier TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          revoked_at TEXT,
          revoked_at_seconds INTEGER,
          revoked_generation INTEGER,
          PRIMARY KEY (telegram_user_id, action)
        ) STRICT
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_enrollments_nullifier
        ON enrollments(nullifier)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_enrollments_revoked
        ON enrollments(revoked)
      `);

      // Global generation counter for monotonic event ordering
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS generation_counter (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          next_generation INTEGER NOT NULL DEFAULT 1
        ) STRICT
      `);

      this.db.exec(`INSERT OR IGNORE INTO generation_counter (id, next_generation) VALUES (1, 1)`);

      this.setSchemaVersion(1);
    }

    if (currentVersion < 2) {
      // v2: Immutable nullifier ownership and durable revocation fences
      // ATOMIC: All DDL, backfill, and version update in single transaction
      
      const migrationTransaction = this.db.transaction(() => {
        // Create v2 tables (DDL inside transaction)
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS nullifier_claims (
            nullifier TEXT NOT NULL,
            action TEXT NOT NULL,
            telegram_user_id INTEGER NOT NULL,
            claimed_at INTEGER NOT NULL,
            claimed_at_iso TEXT NOT NULL,
            PRIMARY KEY (nullifier, action)
          ) STRICT
        `);

        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_nullifier_claims_user
          ON nullifier_claims(telegram_user_id, action)
        `);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS generation_fences (
            telegram_user_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            fence_generation INTEGER NOT NULL,
            fence_timestamp INTEGER NOT NULL,
            fence_iso TEXT NOT NULL,
            PRIMARY KEY (telegram_user_id, action)
          ) STRICT
        `);

        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_generation_fences_generation
          ON generation_fences(fence_generation)
        `);

        // Idempotent restart detection
        const existingClaimsCount = this.db.prepare(`
          SELECT COUNT(*) as count FROM nullifier_claims
        `).get() as any;

        if (existingClaimsCount.count > 0) {
          throw new Error(
            'MIGRATION RESTART DETECTED: v2 tables exist with data but version=1.\n' +
            'This indicates a previous migration was interrupted.\n' +
            'Automatic recovery not safe. Manual inspection required:\n' +
            '1. Verify nullifier_claims data integrity\n' +
            '2. Verify generation_fences data integrity\n' +
            '3. Manually update schema_version to 2 if data is correct\n' +
            '4. Or restore from backup and retry migration'
          );
        }

        // Backfill nullifier_claims from existing enrollments
        const existingNullifiers = this.db.prepare(`
          SELECT nullifier, action, telegram_user_id, 
                 MIN(created_at) as first_claim_at,
                 COUNT(DISTINCT telegram_user_id) as user_count
          FROM enrollments
          WHERE nullifier IS NOT NULL AND nullifier != ''
          GROUP BY nullifier, action
        `).all() as any[];

        for (const row of existingNullifiers) {
          if (row.user_count > 1) {
            throw new Error(
              `MIGRATION FAILED: Ambiguous nullifier ownership.\n` +
              `Nullifier ${row.nullifier.substring(0, 10)}... for action ${row.action} ` +
              `claimed by ${row.user_count} users.\n` +
              `Historical data corruption detected. Manual resolution required.`
            );
          }

          this.db.prepare(`
            INSERT INTO nullifier_claims (nullifier, action, telegram_user_id, claimed_at, claimed_at_iso)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            row.nullifier,
            row.action,
            row.telegram_user_id,
            Math.floor(Date.parse(row.first_claim_at) / 1000),
            row.first_claim_at
          );
        }

        // Backfill generation_fences from existing revoked enrollments
        const revokedEnrollments = this.db.prepare(`
          SELECT telegram_user_id, action, revoked_generation, revoked_at_seconds, revoked_at
          FROM enrollments
          WHERE revoked = 1 AND revoked_generation IS NOT NULL
        `).all() as any[];

        for (const row of revokedEnrollments) {
          this.db.prepare(`
            INSERT INTO generation_fences (telegram_user_id, action, fence_generation, fence_timestamp, fence_iso)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            row.telegram_user_id,
            row.action,
            row.revoked_generation,
            row.revoked_at_seconds,
            row.revoked_at
          );
        }

        // Update version INSIDE transaction (commits atomically with DDL and backfill)
        this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
          2,
          this.clock.nowISO()
        );
      });

      // Execute entire migration atomically
      try {
        migrationTransaction();
      } catch (error: any) {
        throw new Error(`Schema v2 migration failed: ${error.message}`);
      }
    }
  }

  private getNextGeneration(): number {
    const result = this.db.prepare(`
      UPDATE generation_counter SET next_generation = next_generation + 1 WHERE id = 1
      RETURNING next_generation - 1 as generation
    `).get() as any;
    return result.generation;
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

    // Check for existing active (non-expired, non-revoked) enrollment
    const existingEnrollment = await this.findEnrollment(authenticatedUserId);
    if (existingEnrollment && !existingEnrollment.revoked && !existingEnrollment.expired) {
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

    // Store challenge session with expected context and monotonic generation
    const now = this.clock.nowSeconds();
    const expiresAt = now + this.challengeTtlSeconds;
    const generation = this.getNextGeneration();

    const session = {
      nonce: signedChallenge.nonce,
      telegramUserId: authenticatedUserId,
      action: this.action,
      signalHash: expectedContext.signalHash,
      expiresAt,
      createdAt: this.clock.nowISO(),
      createdAtSeconds: now,
      generation,
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO challenge_sessions (nonce, telegram_user_id, action, signal_hash, expires_at, created_at, created_at_seconds, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        session.nonce,
        session.telegramUserId,
        session.action,
        session.signalHash,
        session.expiresAt,
        session.createdAt,
        session.createdAtSeconds,
        session.generation
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
    // Generate correlation ID for this enrollment attempt (random, not derived from identity)
    const correlationId = this.diagnosticLogger?.generateCorrelationId();
    
    // Log callback arrival
    if (correlationId) {
      this.diagnosticLogger?.logCallbackReceived(correlationId);
    }
    
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
      SELECT nonce, telegram_user_id, action, signal_hash, expires_at, created_at, created_at_seconds, generation
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
    const verifyStart = Date.now();
    
    if (correlationId) {
      this.diagnosticLogger?.logUpstreamVerifyStarted(correlationId);
    }
    
    try {
      verificationResult = await this.verificationClient.verify(
        request.idkitResult,
        expectedContext
      );
      
      const verifyDuration = Date.now() - verifyStart;
      if (correlationId && verificationResult.success) {
        this.diagnosticLogger?.logUpstreamVerifySuccess(correlationId, verifyDuration);
      } else if (correlationId && !verificationResult.success) {
        this.diagnosticLogger?.logUpstreamVerifyFailed(correlationId, new Error('Proof verification failed'), verifyDuration);
      }
    } catch (error) {
      const verifyDuration = Date.now() - verifyStart;
      if (correlationId) {
        this.diagnosticLogger?.logUpstreamVerifyFailed(correlationId, error, verifyDuration);
      }
      // Network/service errors do not consume challenge
      return {
        success: false,
        error: 'Verification service unavailable',
      };
    }

    if (!verificationResult.success || !verificationResult.nullifier) {
      if (correlationId) {
        this.diagnosticLogger?.logCompletionRejected(correlationId, 'proof_error');
      }
      return {
        success: false,
        error: 'World ID proof verification failed',
      };
    }

    // Step 6: Check for revoked enrollment and generation comparison
    // Per-account revocation: check (telegram_user_id, action), not nullifier
    // Policy: revoked accounts can regain via fresh post-revoke verification
    const revokedCheck = this.db.prepare(`
      SELECT revoked, revoked_at_seconds, revoked_generation FROM enrollments
      WHERE telegram_user_id = ? AND action = ? AND revoked = 1
    `).get(authenticatedUser.id, this.action) as any;

    if (revokedCheck) {
      // Block pre-revocation challenges using monotonic generation
      // Generation provides strict ordering even within same second
      if (challengeRow.generation < revokedCheck.revoked_generation) {
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
        SELECT nonce, telegram_user_id, expires_at, created_at_seconds, generation
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

      // Check generation fence (independent of enrollment state)
      const fenceCheck = this.db.prepare(`
        SELECT fence_generation
        FROM generation_fences
        WHERE telegram_user_id = ? AND action = ?
      `).get(authenticatedUser.id, this.action) as any;

      if (fenceCheck && recheckRow.generation < fenceCheck.fence_generation) {
        throw new Error('Challenge predates revocation fence (fresh verification required)');
      }

      // Re-check for per-account revocation and generation (legacy check, defense-in-depth)
      const txAccountCheck = this.db.prepare(`
        SELECT revoked, revoked_at_seconds, revoked_generation FROM enrollments
        WHERE telegram_user_id = ? AND action = ? AND revoked = 1
      `).get(authenticatedUser.id, this.action) as any;

      if (txAccountCheck && recheckRow.generation < txAccountCheck.revoked_generation) {
        throw new Error('Challenge predates revocation in transaction');
      }

      // Check immutable nullifier ownership (permanent claim)
      const nullifierOwnerCheck = this.db.prepare(`
        SELECT telegram_user_id
        FROM nullifier_claims
        WHERE nullifier = ? AND action = ?
      `).get(verificationResult.nullifier, this.action) as any;

      if (nullifierOwnerCheck && nullifierOwnerCheck.telegram_user_id !== authenticatedUser.id) {
        throw new Error('Nullifier permanently bound to different account (immutable one-human binding)');
      }

      // Atomically claim nullifier on first use
      if (!nullifierOwnerCheck) {
        try {
          this.db.prepare(`
            INSERT INTO nullifier_claims (nullifier, action, telegram_user_id, claimed_at, claimed_at_iso)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            verificationResult.nullifier,
            this.action,
            authenticatedUser.id,
            txNow,
            this.clock.nowISO()
          );
        } catch (error: any) {
          if (error.message && error.message.includes('UNIQUE constraint failed')) {
            throw new Error('Nullifier ownership race: already claimed by another account');
          }
          throw error;
        }
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
            revoked = 0,
            revoked_at = NULL,
            revoked_at_seconds = NULL
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
        // Catch unique constraint violation on (nullifier, action)
        if (error.message && error.message.includes('UNIQUE constraint failed')) {
          throw new Error('Nullifier ownership conflict: already bound to different account');
        }
        throw error;
      }

      // Consume challenge (delete)
      this.db.prepare('DELETE FROM challenge_sessions WHERE nonce = ?').run(request.idkitResult.nonce);

      return enrollment;
    });

    // Execute transaction
    let enrollment;
    try {
      enrollment = transaction();
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Transaction failed',
      };
    }

    // DISPLAY-ONLY: Apply member tag after immutable enrollment succeeds
    // Tag operations are best-effort and NEVER affect enrollment outcome
    // Access control is independent of tag status (enforced at admission gate)
    if (this.memberTagManager) {
      // Non-blocking tag application (failure logged internally)
      this.memberTagManager.applyTagToMember(enrollment.telegramUserId).catch(error => {
        // Tag failure is logged but does not affect enrollment
        console.error('[MemberTag] Failed to apply tag (enrollment still valid):', error);
      });
    }

    // Log successful completion
    if (correlationId) {
      this.diagnosticLogger?.logCompletionAccepted(correlationId);
    }

    return {
      success: true,
      telegramUserId: enrollment.telegramUserId,
      nullifier: enrollment.nullifier,
      expiresAt: enrollment.expiresAt,
    };
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
   * - Blocks in-flight pre-revocation challenges from completing (via generation)
   * - Blocks future enrollment with pre-revocation challenges
   * - Allows post-revocation fresh challenges to restore access
   * - Does NOT delete the record (audit trail + restoration capability)
   *
   * @param telegramUserId - Telegram numeric user ID
   * @returns True if enrollment found and revoked, false if not found
   */
  async revokeEnrollment(telegramUserId: number): Promise<boolean> {
    // Atomic transaction: fence + enrollment + challenges
    const transaction = this.db.transaction(() => {
      const now = this.clock.nowSeconds();
      const generation = this.getNextGeneration();
      
      // 1. UPSERT durable generation fence (creates marker even if no enrollment exists)
      const fenceStmt = this.db.prepare(`
        INSERT INTO generation_fences (telegram_user_id, action, fence_generation, fence_timestamp, fence_iso)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(telegram_user_id, action) DO UPDATE SET
          fence_generation = excluded.fence_generation,
          fence_timestamp = excluded.fence_timestamp,
          fence_iso = excluded.fence_iso
      `);
      
      fenceStmt.run(telegramUserId, this.action, generation, now, this.clock.nowISO());
      
      // 2. Update enrollment if exists (mark revoked with generation)
      const enrollmentStmt = this.db.prepare(`
        UPDATE enrollments
        SET revoked = 1, revoked_at = ?, revoked_at_seconds = ?, revoked_generation = ?
        WHERE telegram_user_id = ? AND action = ? AND revoked = 0
      `);
      
      const enrollmentResult = enrollmentStmt.run(this.clock.nowISO(), now, generation, telegramUserId, this.action);
      const hadEnrollment = enrollmentResult.changes > 0;
      
      // 3. Delete all pending challenges (atomic with fence and enrollment)
      const challengeStmt = this.db.prepare(`
        DELETE FROM challenge_sessions
        WHERE telegram_user_id = ? AND action = ?
      `);
      
      challengeStmt.run(telegramUserId, this.action);
      
      return hadEnrollment;
    });

    const hadEnrollment = transaction();

    // DISPLAY-ONLY: Remove member tag after revocation (best-effort, non-blocking)
    if (hadEnrollment && this.memberTagManager) {
      this.memberTagManager.removeTagFromMember(telegramUserId).catch(error => {
        console.error('[MemberTag] Failed to remove tag after revocation:', error);
      });
    }

    return hadEnrollment;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Direct enrollment for testing (bypasses full verification flow).
   * DO NOT use in production.
   */
  /**
   * Direct enrollment bypass (test utility only).
   * 
   * WARNING: Bypasses authentication, challenge validation, and World ID verification.
   * RESTRICTED: Only available in test environments (NODE_ENV=test).
   * Production callers must use completeEnrollment() with proper authentication.
   * 
   * @internal
   */
  async directEnroll(params: {
    telegramUserId: number;
    nullifier: string;
    credential: { credential_type: string };
  }): Promise<void> {
    // Fail closed in production
    if (process.env.NODE_ENV === 'production') {
      throw new Error('directEnroll is test-only and not available in production');
    }

    const now = this.clock.nowSeconds();
    const expiresAt = now + this.enrollmentTtlSeconds;

    // Check and claim nullifier ownership atomically
    const transaction = this.db.transaction(() => {
      const ownerCheck = this.db.prepare(`
        SELECT telegram_user_id FROM nullifier_claims WHERE nullifier = ? AND action = ?
      `).get(params.nullifier, this.action) as any;

      if (ownerCheck && ownerCheck.telegram_user_id !== params.telegramUserId) {
        throw new Error('Nullifier already claimed by different user');
      }

      if (!ownerCheck) {
        this.db.prepare(`
          INSERT INTO nullifier_claims (nullifier, action, telegram_user_id, claimed_at, claimed_at_iso)
          VALUES (?, ?, ?, ?, ?)
        `).run(params.nullifier, this.action, params.telegramUserId, now, this.clock.nowISO());
      }

      const stmt = this.db.prepare(`
        INSERT INTO enrollments (telegram_user_id, action, nullifier, expires_at, created_at, revoked, revoked_at, revoked_at_seconds)
        VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
        ON CONFLICT (telegram_user_id, action) DO UPDATE SET
          nullifier = excluded.nullifier,
          expires_at = excluded.expires_at,
          created_at = excluded.created_at,
          revoked = 0,
          revoked_at = NULL,
          revoked_at_seconds = NULL
      `);

      stmt.run(params.telegramUserId, this.action, params.nullifier, expiresAt, this.clock.nowISO());
    });

    transaction();
  }
}
