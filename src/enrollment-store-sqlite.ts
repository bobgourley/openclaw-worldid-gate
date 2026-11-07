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

    // Create enrollments table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enrollments (
        nullifier TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(telegram_user_id, action)
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

    try {
      const stmt = this.db.prepare(`
        INSERT INTO enrollments (nullifier, telegram_user_id, action, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run(
        enrollment.nullifier,
        enrollment.telegramUserId,
        enrollment.action,
        enrollment.expiresAt,
        enrollment.createdAt,
      );
    } catch (error: any) {
      if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new Error(`Enrollment nullifier already exists: ${enrollment.nullifier}`);
      }
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
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
      this.db.prepare("DELETE FROM enrollments WHERE nullifier = ?").run(row.nullifier);
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

  /**
   * Close the database connection.
   * Call this when shutting down to ensure all writes are flushed.
   */
  close(): void {
    this.db.close();
  }
}
