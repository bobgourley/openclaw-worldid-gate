/**
 * Transactional enrollment service with authentic SDK integration.
 *
 * Integrates WorldIdChallengeAdapter for official SDK-based challenge creation
 * and signal hashing (Keccak256 + field reduction, not SHA-256).
 *
 * @module enrollment-service-v2
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
 * Backend verification client interface (dependency injection).
 */
export interface BackendVerificationClient {
  /**
   * Verify World ID proof via Developer Portal API.
   *
   * @param idkitResult - IDKit result from World App
   * @param expectedContext - Server-trusted expected context
   * @returns Verification result
   */
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
  
  /** Challenge TTL in seconds (default: 300 = 5 minutes) */
  challengeTtlSeconds?: number;
  
  /** Enrollment TTL in seconds (default: 2592000 = 30 days) */
  enrollmentTtlSeconds?: number;
  
  /** Enable WAL mode (default: true) */
  enableWal?: boolean;
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
 * Stored challenge session (internal).
 */
interface StoredChallengeSession {
  nonce: string;
  telegramUserId: number;
  action: string;
  signalHash: string;
  expiresAt: number;
  createdAt: string;
}

/**
 * Stored enrollment (internal).
 */
interface StoredEnrollment {
  nullifier: string;
  telegramUserId: number;
  action: string;
  expiresAt: number;
  createdAt: string;
}

/**
 * Transactional enrollment service with authentic SDK integration.
 */
export class EnrollmentServiceV2 {
  private db: Database.Database;
  private challengeAdapter: WorldIdChallengeAdapter;
  private verificationClient: BackendVerificationClient;
  private telegramConfig: TelegramInitDataConfig;
  private action: string;
  private challengeTtlSeconds: number;
  private enrollmentTtlSeconds: number;

  constructor(config: EnrollmentServiceConfig) {
    // Validate stable action scope
    if (!config.action || typeof config.action !== 'string' || config.action.length === 0) {
      throw new Error('Invalid action: must be non-empty string');
    }
    
    // Action must not be per-user (breaks one-human policy)
    if (config.action.includes('{') || config.action.includes('$')) {
      throw new Error('Invalid action: must be stable service scope, not per-user template');
    }

    this.db = new Database(config.dbPath);
    this.challengeAdapter = config.challengeAdapter;
    this.verificationClient = config.verificationClient;
    this.action = config.action;
    this.challengeTtlSeconds = config.challengeTtlSeconds ?? 300;
    this.enrollmentTtlSeconds = config.enrollmentTtlSeconds ?? 2592000;

    this.telegramConfig = {
      botToken: config.telegramBotToken,
    };

    // Enable WAL mode
    if (config.enableWal !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    this.db.pragma('foreign_keys = ON');

    // Create tables with signal_hash column
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS challenge_sessions (
        nonce TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        signal_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_challenge_sessions_expires_at
      ON challenge_sessions(expires_at)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enrollments (
        nullifier TEXT NOT NULL,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (nullifier, action),
        UNIQUE(telegram_user_id, action)
      ) STRICT
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_enrollments_user_action
      ON enrollments(telegram_user_id, action)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_enrollments_expires_at
      ON enrollments(expires_at)
    `);
  }

  /**
   * Create challenge session with SDK-based signed RP context.
   *
   * @param authenticatedTelegramUserId - Telegram user ID from trusted Bot API
   * @returns Signed RP challenge for frontend
   */
  async createChallenge(authenticatedTelegramUserId: number): Promise<CreateChallengeResult> {
    // Validate authenticated user ID
    if (!Number.isSafeInteger(authenticatedTelegramUserId) || authenticatedTelegramUserId <= 0) {
      throw new Error('Invalid authenticatedTelegramUserId: must be positive safe integer');
    }

    // Build signal binding requester to challenge
    // Signal format: telegram:{userId} (no action in signal, action is in challenge scope)
    const signal = `telegram:${authenticatedTelegramUserId}`;

    // Use SDK adapter to create signed challenge
    const { signedChallenge, expectedContext } = this.challengeAdapter.createChallenge(
      this.action,
      signal
    );

    // Store challenge session with expected context
    const session: StoredChallengeSession = {
      nonce: signedChallenge.nonce,
      telegramUserId: authenticatedTelegramUserId,
      action: this.action,
      signalHash: expectedContext.signalHash,
      expiresAt: signedChallenge.expiresAt,
      createdAt: new Date().toISOString(),
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO challenge_sessions (nonce, telegram_user_id, action, signal_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        session.nonce,
        session.telegramUserId,
        session.action,
        session.signalHash,
        session.expiresAt,
        session.createdAt
      );
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new Error(`Session nonce already exists: ${session.nonce}`);
      }
      throw error;
    }

    return {
      signedChallenge,
    };
  }

  /**
   * Complete enrollment with transactional requester-bound validation.
   *
   * @param request - Enrollment completion request from Mini App
   * @returns Enrollment result
   */
  async completeEnrollment(request: CompleteEnrollmentRequest): Promise<CompleteEnrollmentResult> {
    // Step 1: Validate initData HMAC
    const initDataValidation = validateTelegramInitData(request.initData, this.telegramConfig);

    if (!initDataValidation.valid || !initDataValidation.user) {
      return {
        success: false,
        error: `Telegram initData validation failed: ${initDataValidation.error}`,
      };
    }

    const authenticatedUser = initDataValidation.user;

    // Step 2: Peek challenge session (read-only, do not consume yet)
    const peekStmt = this.db.prepare(`
      SELECT nonce, telegram_user_id, action, signal_hash, expires_at, created_at
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

    const now = Math.floor(Date.now() / 1000);
    if (challengeRow.expires_at <= now) {
      // Expired: clean up
      this.db.prepare('DELETE FROM challenge_sessions WHERE nonce = ?').run(request.idkitResult.nonce);
      return {
        success: false,
        error: 'Challenge session expired',
      };
    }

    // Step 3: Validate authenticated requester matches stored challenge requester
    if (authenticatedUser.id !== challengeRow.telegram_user_id) {
      return {
        success: false,
        error: `Account mismatch: challenge bound to user ${challengeRow.telegram_user_id}, requester is ${authenticatedUser.id}`,
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
    const verificationResult = await this.verificationClient.verify(
      request.idkitResult,
      expectedContext
    );

    if (!verificationResult.success || !verificationResult.nullifier) {
      return {
        success: false,
        error: `World ID proof verification failed: ${verificationResult.error}`,
      };
    }

    // Step 6: Atomic transaction: consume challenge + create enrollment
    const transaction = this.db.transaction(() => {
      // Re-check challenge still exists (race protection)
      const recheckStmt = this.db.prepare(`
        SELECT nonce, telegram_user_id, expires_at
        FROM challenge_sessions
        WHERE nonce = ?
      `);

      const recheckRow = recheckStmt.get(request.idkitResult.nonce) as any;

      if (!recheckRow) {
        throw new Error('Challenge session was consumed by another request');
      }

      // Re-check not expired
      const txNow = Math.floor(Date.now() / 1000);
      if (recheckRow.expires_at <= txNow) {
        this.db.prepare('DELETE FROM challenge_sessions WHERE nonce = ?').run(request.idkitResult.nonce);
        throw new Error('Challenge session expired during proof verification');
      }

      // Re-check account match
      if (recheckRow.telegram_user_id !== authenticatedUser.id) {
        throw new Error('Challenge account mismatch in transaction');
      }

      // Create enrollment
      const enrollmentExpiresAt = txNow + this.enrollmentTtlSeconds;
      const enrollment: StoredEnrollment = {
        nullifier: verificationResult.nullifier!,
        telegramUserId: authenticatedUser.id,
        action: this.action,
        expiresAt: enrollmentExpiresAt,
        createdAt: new Date().toISOString(),
      };

      try {
        const insertStmt = this.db.prepare(`
          INSERT INTO enrollments (nullifier, telegram_user_id, action, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);

        insertStmt.run(
          enrollment.nullifier,
          enrollment.telegramUserId,
          enrollment.action,
          enrollment.expiresAt,
          enrollment.createdAt
        );
      } catch (error: any) {
        if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          throw new Error(`Enrollment nullifier already exists for action ${this.action}`);
        }
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          throw new Error(`User ${authenticatedUser.id} already enrolled for action ${this.action}`);
        }
        throw error;
      }

      // Consume challenge
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
   * @param currentTime - Current time for expiry check
   * @returns Active enrollment or null
   */
  async findEnrollment(
    telegramUserId: number,
    currentTime: Date
  ): Promise<StoredEnrollment | null> {
    const stmt = this.db.prepare(`
      SELECT nullifier, telegram_user_id, action, expires_at, created_at
      FROM enrollments
      WHERE telegram_user_id = ? AND action = ?
    `);

    const row = stmt.get(telegramUserId, this.action) as any;

    if (!row) {
      return null;
    }

    const now = Math.floor(currentTime.getTime() / 1000);
    if (row.expires_at <= now) {
      // Expired: clean up
      this.db.prepare('DELETE FROM enrollments WHERE nullifier = ? AND action = ?').run(
        row.nullifier,
        this.action
      );
      return null;
    }

    return {
      nullifier: row.nullifier,
      telegramUserId: row.telegram_user_id,
      action: row.action,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  /**
   * Delete enrollment (administrative revocation).
   *
   * @param nullifier - World ID nullifier
   * @returns True if deleted, false if not found
   */
  async deleteEnrollment(nullifier: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      DELETE FROM enrollments
      WHERE nullifier = ? AND action = ?
    `);

    const result = stmt.run(nullifier, this.action);
    return result.changes > 0;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
