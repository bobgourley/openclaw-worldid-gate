/**
 * SQLite implementation of enrollment and challenge session stores.
 *
 * Provides durable transactional persistence with atomic operations for
 * challenge session consumption and enrollment creation. Portable to Mac Node24.
 *
 * @module enrollment-store-sqlite
 */

import Database from "better-sqlite3";
import type {
  ChallengeSession,
  ChallengeSessionStore,
  Enrollment,
  EnrollmentStore,
} from "./enrollment-store.js";

/**
 * SQLite configuration for enrollment stores.
 */
export interface SqliteStoreConfig {
  /** Path to SQLite database file (use ":memory:" for in-memory testing) */
  dbPath: string;
  /** Enable WAL mode for better concurrency (default: true) */
  enableWal?: boolean;
  /** Enable foreign keys (default: true) */
  enableForeignKeys?: boolean;
}

/**
 * SQLite challenge session store with transactional atomic operations.
 *
 * Session consumption is atomic: consume() deletes the session within a transaction,
 * ensuring exactly-once semantics even under concurrent access.
 */
export class SqliteChallengeSessionStore implements ChallengeSessionStore {
  private db: Database.Database;

  constructor(config: SqliteStoreConfig) {
    this.db = new Database(config.dbPath);

    // Enable WAL mode for better concurrency (allows multiple readers during writes)
    if (config.enableWal !== false) {
      this.db.pragma("journal_mode = WAL");
    }

    // Enable foreign keys
    if (config.enableForeignKeys !== false) {
      this.db.pragma("foreign_keys = ON");
    }

    // Create challenge_sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS challenge_sessions (
        nonce TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT
    `);

    // Index for expiry cleanup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_challenge_sessions_expires_at
      ON challenge_sessions(expires_at)
    `);
  }

  async createSession(session: ChallengeSession): Promise<void> {
    // Runtime validate session structure
    if (!session || typeof session !== "object") {
      throw new Error("Invalid session: must be object");
    }
    if (typeof session.nonce !== "string" || session.nonce.length === 0) {
      throw new Error("Invalid session: nonce must be non-empty string");
    }
    if (!Number.isSafeInteger(session.telegramUserId) || session.telegramUserId <= 0) {
      throw new Error("Invalid session: telegramUserId must be positive safe integer");
    }
    if (typeof session.action !== "string" || session.action.length === 0) {
      throw new Error("Invalid session: action must be non-empty string");
    }
    if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= 0) {
      throw new Error("Invalid session: expiresAt must be positive safe integer");
    }

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
  }

  async consumeSession(nonce: string): Promise<ChallengeSession | null> {
    // Atomic consume: SELECT + DELETE in a transaction
    const transaction = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        SELECT nonce, telegram_user_id, action, expires_at, created_at
        FROM challenge_sessions
        WHERE nonce = ?
      `);

      const row = stmt.get(nonce) as any;

      if (!row) {
        return null;
      }

      const now = Math.floor(Date.now() / 1000);
      if (row.expires_at <= now) {
        // Expired: delete and return null
        this.db.prepare("DELETE FROM challenge_sessions WHERE nonce = ?").run(nonce);
        return null;
      }

      // Valid session: delete and return
      this.db.prepare("DELETE FROM challenge_sessions WHERE nonce = ?").run(nonce);

      return {
        nonce: row.nonce,
        telegramUserId: row.telegram_user_id,
        action: row.action,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      } as ChallengeSession;
    });

    return transaction();
  }

  async expireSessions(beforeTimestamp: number): Promise<number> {
    const stmt = this.db.prepare(`
      DELETE FROM challenge_sessions
      WHERE expires_at <= ?
    `);

    const result = stmt.run(beforeTimestamp);
    return result.changes;
  }

  /**
   * Close the database connection.
   * Call this when shutting down to ensure all writes are flushed.
   */
  close(): void {
    this.db.close();
  }
}

/**
 * SQLite enrollment store with transactional atomic operations.
 *
 * Enrollment creation enforces unique constraints on nullifier and
 * (telegramUserId, action) pair within a transaction.
 */
export class SqliteEnrollmentStore implements EnrollmentStore {
  private db: Database.Database;

  constructor(config: SqliteStoreConfig) {
    this.db = new Database(config.dbPath);

    // Enable WAL mode for better concurrency
    if (config.enableWal !== false) {
      this.db.pragma("journal_mode = WAL");
    }

    // Enable foreign keys
    if (config.enableForeignKeys !== false) {
      this.db.pragma("foreign_keys = ON");
    }

    // Create enrollments table with session support
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enrollments (
        nullifier TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        session_id TEXT,
        protocol_version TEXT,
        revoked_at TEXT,
        revoked_by TEXT,
        reactivated_at TEXT,
        reactivated_by TEXT,
        migration_generation INTEGER NOT NULL DEFAULT 1,
        UNIQUE(telegram_user_id, action),
        UNIQUE(session_id)
      ) STRICT
    `);

    // Create session nullifier claims table for replay protection
    // Composite primary key (session_nullifier, action) as per World ID tuple
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_nullifier_claims (
        session_nullifier TEXT NOT NULL,
        action TEXT NOT NULL,
        session_id TEXT NOT NULL,
        enrollment_nullifier TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (session_nullifier, action),
        FOREIGN KEY (enrollment_nullifier) REFERENCES enrollments(nullifier)
      ) STRICT
    `);

    // Index for user+action lookup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_enrollments_user_action
      ON enrollments(telegram_user_id, action)
    `);

    // Index for expiry cleanup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_enrollments_expires_at
      ON enrollments(expires_at)
    `);

    // Index for session lookup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_enrollments_session
      ON enrollments(session_id) WHERE session_id IS NOT NULL
    `);

    // Index for session nullifier action lookup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_nullifier_claims_action
      ON session_nullifier_claims(session_nullifier, action)
    `);
  }

  async createEnrollment(enrollment: Enrollment): Promise<void> {
    // Runtime validate enrollment structure
    if (!enrollment || typeof enrollment !== "object") {
      throw new Error("Invalid enrollment: must be object");
    }
    if (typeof enrollment.nullifier !== "string" || enrollment.nullifier.length === 0) {
      throw new Error("Invalid enrollment: nullifier must be non-empty string");
    }
    if (!Number.isSafeInteger(enrollment.telegramUserId) || enrollment.telegramUserId <= 0) {
      throw new Error("Invalid enrollment: telegramUserId must be positive safe integer");
    }
    if (typeof enrollment.action !== "string" || enrollment.action.length === 0) {
      throw new Error("Invalid enrollment: action must be non-empty string");
    }
    if (!Number.isSafeInteger(enrollment.expiresAt) || enrollment.expiresAt <= 0) {
      throw new Error("Invalid enrollment: expiresAt must be positive safe integer");
    }
    if (enrollment.sessionId !== undefined && enrollment.sessionId !== null) {
      if (typeof enrollment.sessionId !== "string" || !enrollment.sessionId.startsWith("session_")) {
        throw new Error("Invalid enrollment: sessionId must be null or string starting with 'session_'");
      }
    }

    try {
      const stmt = this.db.prepare(`
        INSERT INTO enrollments (
          nullifier, telegram_user_id, action, expires_at, created_at,
          session_id, protocol_version, migration_generation
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        enrollment.nullifier,
        enrollment.telegramUserId,
        enrollment.action,
        enrollment.expiresAt,
        enrollment.createdAt,
        enrollment.sessionId || null,
        enrollment.protocolVersion || null,
        enrollment.migrationGeneration || 1,
      );
    } catch (error: any) {
      if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new Error(`Enrollment nullifier already exists: ${enrollment.nullifier}`);
      }
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const sessionIdMatch = error.message?.includes("session_id");
        if (sessionIdMatch) {
          throw new Error(`Session ID already bound to different enrollment: ${enrollment.sessionId}`);
        }
        throw new Error(
          `Enrollment for telegramUserId ${enrollment.telegramUserId} and action ${enrollment.action} already exists`,
        );
      }
      throw error;
    }
  }

  async findEnrollment(
    telegramUserId: number,
    action: string,
    currentTime: Date,
  ): Promise<Enrollment | null> {
    const stmt = this.db.prepare(`
      SELECT 
        nullifier, telegram_user_id, action, expires_at, created_at,
        session_id, protocol_version, revoked_at, revoked_by,
        reactivated_at, reactivated_by, migration_generation
      FROM enrollments
      WHERE telegram_user_id = ? AND action = ?
    `);

    const row = stmt.get(telegramUserId, action) as any;

    if (!row) {
      return null;
    }

    // Revoked enrollments are not active
    if (row.revoked_at) {
      return null;
    }

    const now = Math.floor(currentTime.getTime() / 1000);
    if (row.expires_at <= now) {
      // Expired: clean up and return null
      this.db.prepare("DELETE FROM enrollments WHERE nullifier = ?").run(row.nullifier);
      return null;
    }

    return {
      nullifier: row.nullifier,
      telegramUserId: row.telegram_user_id,
      action: row.action,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      sessionId: row.session_id,
      protocolVersion: row.protocol_version,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      reactivatedAt: row.reactivated_at,
      reactivatedBy: row.reactivated_by,
      migrationGeneration: row.migration_generation,
    };
  }

  async deleteEnrollment(nullifier: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      DELETE FROM enrollments
      WHERE nullifier = ?
    `);

    const result = stmt.run(nullifier);
    return result.changes > 0;
  }

  async expireEnrollments(beforeTimestamp: number): Promise<number> {
    const stmt = this.db.prepare(`
      DELETE FROM enrollments
      WHERE expires_at <= ?
    `);

    const result = stmt.run(beforeTimestamp);
    return result.changes;
  }

  async revokeEnrollment(nullifier: string, revokedBy: 'user' | 'admin'): Promise<boolean> {
    const stmt = this.db.prepare(`
      UPDATE enrollments
      SET revoked_at = ?, revoked_by = ?
      WHERE nullifier = ? AND revoked_at IS NULL
    `);

    const result = stmt.run(new Date().toISOString(), revokedBy, nullifier);
    return result.changes > 0;
  }

  async reactivateEnrollment(nullifier: string, reactivatedBy: 'user' | 'admin'): Promise<boolean> {
    const stmt = this.db.prepare(`
      UPDATE enrollments
      SET reactivated_at = ?, reactivated_by = ?, revoked_at = NULL, revoked_by = NULL
      WHERE nullifier = ? AND revoked_at IS NOT NULL
    `);

    const result = stmt.run(new Date().toISOString(), reactivatedBy, nullifier);
    return result.changes > 0;
  }

  async recordSessionNullifierClaim(claim: import("./enrollment-store.js").SessionNullifierClaim): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO session_nullifier_claims (
          session_nullifier, action, session_id, enrollment_nullifier, claimed_at
        )
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run(
        claim.sessionNullifier,
        claim.action,
        claim.sessionId,
        claim.enrollmentNullifier,
        claim.claimedAt,
      );
    } catch (error: any) {
      if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error(`Session nullifier already claimed: ${claim.sessionNullifier} for action ${claim.action}`);
      }
      throw error;
    }
  }

  async isSessionNullifierClaimed(sessionNullifier: string, action: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      SELECT 1
      FROM session_nullifier_claims
      WHERE session_nullifier = ? AND action = ?
    `);

    const row = stmt.get(sessionNullifier, action);
    return row !== undefined;
  }

  /**
   * Close the database connection.
   * Call this when shutting down to ensure all writes are flushed.
   */
  close(): void {
    this.db.close();
  }
}
