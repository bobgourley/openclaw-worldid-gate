/**
 * Transactional enrollment completion service with requester-bound challenge validation.
 *
 * Handles atomic challenge consumption + enrollment creation in a single transaction,
 * ensuring that invalid proofs or account mismatches do not burn another account's challenge.
 *
 * @module enrollment-service
 */

import Database from "better-sqlite3";
import type {
  ChallengeSession,
  Enrollment,
} from "./enrollment-store.js";
import type {
  WorldIdVerificationClient,
  WorldIdV4VerifyRequest,
  ExpectedVerificationContext,
} from "./worldid-client.js";
import type {
  TelegramInitDataConfig,
  ValidatedTelegramUser,
} from "./telegram-initdata.js";
import { validateTelegramInitData } from "./telegram-initdata.js";

/**
 * Enrollment service configuration.
 */
export interface EnrollmentServiceConfig {
  /** Path to SQLite database file (shared connection for transactional integrity) */
  dbPath: string;
  /** World ID verification client (dependency injection) */
  worldIdClient: WorldIdVerificationClient;
  /** Telegram bot token for initData validation */
  telegramBotToken: string;
  /** Default enrollment TTL in seconds (default: 2592000 = 30 days) */
  enrollmentTtlSeconds?: number;
  /** Enable WAL mode (default: true) */
  enableWal?: boolean;
}

/**
 * Challenge creation request.
 */
export interface CreateChallengeRequest {
  /** Authenticated Telegram user ID from trusted source (e.g., Bot API) */
  authenticatedTelegramUserId: number;
  /** Action identifier */
  action: string;
  /** Challenge TTL in seconds (default: 300 = 5 minutes) */
  challengeTtlSeconds?: number;
}

/**
 * Challenge creation result.
 */
export interface CreateChallengeResult {
  /** Challenge nonce (single-use, bound to requester) */
  nonce: string;
  /** Action identifier */
  action: string;
  /** Unix timestamp (seconds) when challenge expires */
  expiresAt: number;
}

/**
 * Enrollment completion request (from Telegram Mini App).
 */
export interface CompleteEnrollmentRequest {
  /** Telegram initData from Mini App (HMAC-validated) */
  initData: string;
  /** Challenge nonce from enrollment link */
  nonce: string;
  /** World ID v4 proof request */
  proofRequest: WorldIdV4VerifyRequest;
}

/**
 * Enrollment completion result.
 */
export interface CompleteEnrollmentResult {
  success: boolean;
  /** Telegram user ID granted enrollment */
  telegramUserId?: number;
  /** World ID nullifier */
  nullifier?: string;
  /** Enrollment expiry timestamp */
  expiresAt?: number;
  error?: string;
}

/**
 * Transactional enrollment service with requester-bound challenge validation.
 *
 * Uses a single shared database connection for atomic challenge consumption + enrollment creation.
 * All operations within a transaction ensure no partial state or burned challenges.
 */
export class EnrollmentService {
  private db: Database.Database;
  private worldIdClient: WorldIdVerificationClient;
  private telegramConfig: TelegramInitDataConfig;
  private enrollmentTtlSeconds: number;

  constructor(config: EnrollmentServiceConfig) {
    this.db = new Database(config.dbPath);
    this.worldIdClient = config.worldIdClient;
    this.telegramConfig = {
      botToken: config.telegramBotToken,
    };
    this.enrollmentTtlSeconds = config.enrollmentTtlSeconds ?? 2592000; // 30 days

    // Enable WAL mode for better concurrency
    if (config.enableWal !== false) {
      this.db.pragma("journal_mode = WAL");
    }

    this.db.pragma("foreign_keys = ON");

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS challenge_sessions (
        nonce TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
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
   * Create a challenge session bound to an authenticated Telegram user.
   *
   * @param request - Challenge creation request with authenticated user ID
   * @returns Challenge nonce and metadata
   */
  async createChallenge(request: CreateChallengeRequest): Promise<CreateChallengeResult> {
    // Validate authenticated user ID
    if (!Number.isSafeInteger(request.authenticatedTelegramUserId) || request.authenticatedTelegramUserId <= 0) {
      throw new Error("Invalid authenticatedTelegramUserId: must be positive safe integer");
    }

    if (typeof request.action !== "string" || request.action.length === 0) {
      throw new Error("Invalid action: must be non-empty string");
    }

    // Generate cryptographically random nonce
    const nonce = this.generateNonce();
    const challengeTtl = request.challengeTtlSeconds ?? 300; // 5 minutes
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + challengeTtl;

    const session: ChallengeSession = {
      nonce,
      telegramUserId: request.authenticatedTelegramUserId,
      action: request.action,
      expiresAt,
      createdAt: new Date().toISOString(),
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO challenge_sessions (nonce, telegram_user_id, action, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run(
        session.nonce,
        session.telegramUserId,
        session.action,
        session.expiresAt,
        session.createdAt,
      );
    } catch (error: any) {
      if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new Error(`Session nonce already exists: ${session.nonce}`);
      }
      throw error;
    }

    return {
      nonce: session.nonce,
      action: session.action,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Complete enrollment with transactional requester-bound validation.
   *
   * Process:
   * 1. Validate Telegram initData HMAC (extract authenticated requester)
   * 2. Peek challenge session to get expected context (read-only, no mutation yet)
   * 3. Validate authenticated requester matches stored challenge requester
   * 4. Verify World ID proof with server-trusted expected context (async HTTP call)
   * 5. Atomic transaction: consume challenge + create enrollment (both or neither)
   *
   * Failures before transaction do not burn challenge. Transaction is all-or-nothing.
   *
   * @param request - Enrollment completion request with initData + proof
   * @returns Enrollment result or error
   */
  async completeEnrollment(request: CompleteEnrollmentRequest): Promise<CompleteEnrollmentResult> {
    // Step 1: Validate initData HMAC (before any database operations)
    const initDataValidation = validateTelegramInitData(request.initData, this.telegramConfig);

    if (!initDataValidation.valid || !initDataValidation.user) {
      return {
        success: false,
        error: `Telegram initData validation failed: ${initDataValidation.error}`,
      };
    }

    const authenticatedUser = initDataValidation.user;

    // Step 2: Peek challenge session (read-only check, do not consume yet)
    const peekStmt = this.db.prepare(`
      SELECT nonce, telegram_user_id, action, expires_at, created_at
      FROM challenge_sessions
      WHERE nonce = ?
    `);

    const challengeRow = peekStmt.get(request.nonce) as any;

    if (!challengeRow) {
      return {
        success: false,
        error: "Challenge session not found",
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (challengeRow.expires_at <= now) {
      // Expired: clean up (no account check needed for expired challenges)
      this.db.prepare("DELETE FROM challenge_sessions WHERE nonce = ?").run(request.nonce);
      return {
        success: false,
        error: "Challenge session expired",
      };
    }

    // Step 3: Validate authenticated requester matches stored challenge requester
    if (authenticatedUser.id !== challengeRow.telegram_user_id) {
      // Account mismatch: DO NOT delete challenge (preserve for legitimate requester)
      return {
        success: false,
        error: `Account mismatch: challenge bound to user ${challengeRow.telegram_user_id}, requester is ${authenticatedUser.id}`,
      };
    }

    const storedAction = challengeRow.action;

    // Step 4: Build server-trusted expected context from stored challenge
    // Signal MUST be bound to requester context to prevent proof replay across accounts
    //
    // SIGNAL BINDING DESIGN:
    // We construct signal as "telegram:{userId}:{action}" and hash it.
    // The client MUST provide this same signal when generating the proof.
    // World ID's proof verification confirms the signal_hash in the proof matches our expected value.
    //
    // CAVEAT: This assumes World ID's proof structure binds signal_hash cryptographically.
    // We are using the documented API contract: if verification succeeds and signal_hash matches,
    // the proof is bound to that signal. We are not auditing the zk-SNARK internals.
    const signal = `telegram:${authenticatedUser.id}:${storedAction}`;
    const signalHash = await this.hashSignalAsync(signal);

    const expectedContext: ExpectedVerificationContext = {
      action: storedAction,
      nonce: request.nonce,
      signalHash,
      requireProofOfHuman: true,
    };

    // Step 5: Verify World ID proof (async HTTP call, outside transaction)
    const verificationResult = await this.worldIdClient.verify(request.proofRequest, expectedContext);

    if (!verificationResult.success || !verificationResult.nullifier) {
      // Proof verification failed: DO NOT consume challenge or create enrollment
      return {
        success: false,
        error: `World ID proof verification failed: ${verificationResult.error}`,
      };
    }

    // Step 6: Atomic transaction: consume challenge + create enrollment
    const transaction = this.db.transaction(() => {
      // Re-check challenge still exists and hasn't been consumed (race condition protection)
      const recheckStmt = this.db.prepare(`
        SELECT nonce, telegram_user_id, expires_at
        FROM challenge_sessions
        WHERE nonce = ?
      `);

      const recheckRow = recheckStmt.get(request.nonce) as any;

      if (!recheckRow) {
        throw new Error("Challenge session was consumed by another request");
      }

      // Re-check not expired (time may have passed during proof verification)
      const txNow = Math.floor(Date.now() / 1000);
      if (recheckRow.expires_at <= txNow) {
        // Delete expired challenge
        this.db.prepare("DELETE FROM challenge_sessions WHERE nonce = ?").run(request.nonce);
        throw new Error("Challenge session expired during proof verification");
      }

      // Re-check account match (paranoid defense against race conditions)
      if (recheckRow.telegram_user_id !== authenticatedUser.id) {
        throw new Error("Challenge account mismatch in transaction");
      }

      // Create enrollment
      const enrollmentExpiresAt = txNow + this.enrollmentTtlSeconds;
      const enrollment: Enrollment = {
        nullifier: verificationResult.nullifier!,
        telegramUserId: authenticatedUser.id,
        action: storedAction,
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
          enrollment.createdAt,
        );
      } catch (error: any) {
        if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
          throw new Error(`Enrollment nullifier already exists for action ${storedAction}`);
        }
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new Error(`User ${authenticatedUser.id} already enrolled for action ${storedAction}`);
        }
        throw error;
      }

      // Consume challenge (delete)
      this.db.prepare("DELETE FROM challenge_sessions WHERE nonce = ?").run(request.nonce);

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
      // Transaction rolled back - challenge preserved if error before deletion
      return {
        success: false,
        error: error instanceof Error ? error.message : "Transaction failed",
      };
    }
  }

  /**
   * Find active enrollment by Telegram user ID and action.
   *
   * @param telegramUserId - Telegram numeric user ID
   * @param action - Action identifier
   * @param currentTime - Current time for expiry check
   * @returns Active enrollment or null
   */
  async findEnrollment(
    telegramUserId: number,
    action: string,
    currentTime: Date,
  ): Promise<Enrollment | null> {
    const stmt = this.db.prepare(`
      SELECT nullifier, telegram_user_id, action, expires_at, created_at
      FROM enrollments
      WHERE telegram_user_id = ? AND action = ?
    `);

    const row = stmt.get(telegramUserId, action) as any;

    if (!row) {
      return null;
    }

    const now = Math.floor(currentTime.getTime() / 1000);
    if (row.expires_at <= now) {
      // Expired: clean up and return null
      this.db.prepare("DELETE FROM enrollments WHERE nullifier = ? AND action = ?").run(row.nullifier, action);
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
   * Delete enrollment by nullifier and action.
   *
   * @param nullifier - World ID nullifier
   * @param action - Action identifier
   * @returns True if deleted, false if not found
   */
  async deleteEnrollment(nullifier: string, action: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      DELETE FROM enrollments
      WHERE nullifier = ? AND action = ?
    `);

    const result = stmt.run(nullifier, action);
    return result.changes > 0;
  }

  /**
   * Generate cryptographically random nonce.
   */
  private generateNonce(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Hash signal for World ID proof binding (async for proper SHA-256).
   *
   * Signal binds proof to specific requester context (Telegram user ID + action).
   * This prevents proof replay across different accounts.
   *
   * SIGNAL BINDING CONTRACT:
   * - Application constructs signal as "telegram:{userId}:{action}"
   * - Hashes signal with SHA-256 to get signal_hash
   * - Client provides same signal when generating proof (must match)
   * - World ID's proof verification confirms signal_hash matches
   * - We rely on World ID's documented API contract: successful verification with matching
   *   signal_hash means the proof is bound to that signal.
   *
   * CAVEAT: We are not auditing zk-SNARK internals, but using the documented API semantics.
   * If World ID's verification says success + signal_hash matches, we trust that binding.
   *
   * @param signal - Signal string to hash
   * @returns Promise<signal hash (0x-prefixed hex string)>
   */
  private async hashSignalAsync(signal: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(signal);
    
    // Use Node.js crypto for SHA-256 (synchronous alternative to Web Crypto)
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(signal).digest("hex");
    
    return `0x${hash}`;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
