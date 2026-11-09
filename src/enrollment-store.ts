/**
 * Production enrollment store abstraction with durable transactional semantics.
 *
 * Defines interfaces for challenge session management and enrollment persistence
 * required for dual authentication binding (Telegram user ID + World ID proof).
 *
 * @module enrollment-store
 */

/**
 * Challenge session for dual authentication flow.
 *
 * Binds a Telegram user ID to a single-use challenge nonce, ensuring the same
 * Telegram account that initiated the challenge completes the verification.
 */
export interface ChallengeSession {
  /** Unique session nonce from RP signature */
  nonce: string;
  /** Telegram numeric user ID that initiated the challenge */
  telegramUserId: number;
  /** Action identifier (e.g., "verify-human-2026") */
  action: string;
  /** Unix timestamp (seconds) when session expires */
  expiresAt: number;
  /** ISO 8601 timestamp when session was created */
  createdAt: string;
}

/**
 * Enrollment record for a verified human.
 */
export interface Enrollment {
  /** World ID nullifier (0x-prefixed hex string representing 256-bit integer) */
  nullifier: string;
  /** Telegram numeric user ID */
  telegramUserId: number;
  /** Action identifier */
  action: string;
  /** Unix timestamp (seconds) when credential expires per proof_of_human expires_at_min */
  expiresAt: number;
  /** ISO 8601 timestamp when enrollment was created */
  createdAt: string;
  /** World ID session ID for returning user verification (session_<128 hex chars>) or null for uniqueness-only */
  sessionId?: string | null;
  /** Protocol version: '3.0' (legacy), '4.0' (v4), or 'UNKNOWN' (existing data with unknown protocol) */
  protocolVersion?: string;
  /** ISO 8601 timestamp when enrollment was revoked, or null if active */
  revokedAt?: string | null;
  /** Who revoked: 'user' | 'admin' | null */
  revokedBy?: string | null;
  /** ISO 8601 timestamp when enrollment was reactivated, or null if never reactivated */
  reactivatedAt?: string | null;
  /** Who reactivated: 'user' | 'admin' | null */
  reactivatedBy?: string | null;
  /** Immutable migration generation for this enrollment (1 = initial, increments on schema changes) */
  migrationGeneration?: number;
}

/**
 * Challenge session store for transactional single-use nonce management.
 */
export interface ChallengeSessionStore {
  /**
   * Create a new challenge session (must fail if nonce already exists).
   *
   * @param session - Challenge session to create
   * @throws If nonce already exists or storage fails
   */
  createSession(session: ChallengeSession): Promise<void>;

  /**
   * Consume (retrieve and delete) a challenge session atomically.
   *
   * @param nonce - Session nonce to consume
   * @returns Challenge session or null if not found/expired
   */
  consumeSession(nonce: string): Promise<ChallengeSession | null>;

  /**
   * Expire (delete) sessions older than given timestamp.
   *
   * @param beforeTimestamp - Unix timestamp (seconds)
   * @returns Number of expired sessions deleted
   */
  expireSessions(beforeTimestamp: number): Promise<number>;
}

/**
 * Session nullifier claim for replay protection of session proofs.
 *
 * Each session proof returns a tuple [nullifier, action] that must be tracked
 * to prevent replay attacks. This is separate from the enrollment nullifier.
 */
export interface SessionNullifierClaim {
  /** Session nullifier from tuple (0x-prefixed hex) */
  sessionNullifier: string;
  /** Action from tuple */
  action: string;
  /** Session ID this nullifier belongs to */
  sessionId: string;
  /** Enrollment nullifier this session claim is linked to */
  enrollmentNullifier: string;
  /** ISO 8601 timestamp when claim was recorded */
  claimedAt: string;
}

/**
 * Enrollment store for durable credential lifecycle management.
 */
export interface EnrollmentStore {
  /**
   * Create a new enrollment (must fail if nullifier or telegramUserId+action already exists).
   *
   * @param enrollment - Enrollment to create
   * @throws If nullifier or (telegramUserId, action) already exists or storage fails
   */
  createEnrollment(enrollment: Enrollment): Promise<void>;

  /**
   * Find active enrollment by Telegram user ID and action (not expired, not revoked).
   *
   * @param telegramUserId - Telegram numeric user ID
   * @param action - Action identifier
   * @param currentTime - Current clock for expiry check (dependency injection for testing)
   * @returns Active enrollment or null if not found/expired/revoked
   */
  findEnrollment(
    telegramUserId: number,
    action: string,
    currentTime: Date,
  ): Promise<Enrollment | null>;

  /**
   * Delete enrollment by nullifier.
   *
   * @param nullifier - World ID nullifier
   * @returns True if enrollment was deleted, false if not found
   */
  deleteEnrollment(nullifier: string): Promise<boolean>;

  /**
   * Expire (delete) enrollments older than given timestamp.
   *
   * @param beforeTimestamp - Unix timestamp (seconds)
   * @returns Number of expired enrollments deleted
   */
  expireEnrollments(beforeTimestamp: number): Promise<number>;

  /**
   * Revoke enrollment by nullifier (soft delete with audit trail).
   *
   * @param nullifier - World ID nullifier
   * @param revokedBy - Who revoked: 'user' | 'admin'
   * @returns True if enrollment was revoked, false if not found
   */
  revokeEnrollment(nullifier: string, revokedBy: 'user' | 'admin'): Promise<boolean>;

  /**
   * Reactivate a revoked enrollment (requires explicit authorization).
   *
   * @param nullifier - World ID nullifier
   * @param reactivatedBy - Who reactivated: 'user' | 'admin'
   * @returns True if enrollment was reactivated, false if not found or not revoked
   */
  reactivateEnrollment(nullifier: string, reactivatedBy: 'user' | 'admin'): Promise<boolean>;

  /**
   * Record a session nullifier claim for replay protection.
   *
   * @param claim - Session nullifier claim to record
   * @throws If session nullifier already claimed
   */
  recordSessionNullifierClaim(claim: SessionNullifierClaim): Promise<void>;

  /**
   * Check if session nullifier has been claimed (replay detection).
   *
   * @param sessionNullifier - Session nullifier to check
   * @param action - Action identifier
   * @returns True if already claimed, false if safe to use
   */
  isSessionNullifierClaimed(sessionNullifier: string, action: string): Promise<boolean>;
}

/**
 * In-memory challenge session store for development/testing.
 *
 * NOT FOR PRODUCTION: Data is lost on restart, no atomic operations, no persistence.
 */
export class InMemoryChallengeSessionStore implements ChallengeSessionStore {
  private sessions = new Map<string, ChallengeSession>();

  async createSession(session: ChallengeSession): Promise<void> {
    if (this.sessions.has(session.nonce)) {
      throw new Error(`Session nonce already exists: ${session.nonce}`);
    }
    this.sessions.set(session.nonce, session);
  }

  async consumeSession(nonce: string): Promise<ChallengeSession | null> {
    const session = this.sessions.get(nonce);
    if (!session) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (session.expiresAt <= now) {
      this.sessions.delete(nonce);
      return null;
    }

    this.sessions.delete(nonce);
    return session;
  }

  async expireSessions(beforeTimestamp: number): Promise<number> {
    let count = 0;
    for (const [nonce, session] of this.sessions.entries()) {
      if (session.expiresAt <= beforeTimestamp) {
        this.sessions.delete(nonce);
        count++;
      }
    }
    return count;
  }
}

/**
 * Backward-compatible enrollment store interface for existing AdmissionGate tests.
 * Production implementations should use the full EnrollmentStore interface above.
 */
export interface LegacyEnrollmentStore {
  get(telegramUserId: number): Promise<{ nullifier: string; expiresAt: number; action: string; revoked?: boolean } | null>;
  set(enrollment: { telegramUserId: number; nullifier: string; expiresAt: number; action: string }): Promise<void>;
  revoke(telegramUserId: number): Promise<void>;
}

/**
 * In-memory enrollment store for development/testing.
 *
 * NOT FOR PRODUCTION: Data is lost on restart, no atomic operations, no persistence.
 */
export class InMemoryEnrollmentStore implements EnrollmentStore, LegacyEnrollmentStore {
  private enrollments = new Map<string, Enrollment>();
  private telegramUserIndex = new Map<string, string>(); // `${telegramUserId}:${action}` -> nullifier
  private telegramUserIdToNullifier = new Map<number, string>(); // Legacy: telegramUserId -> nullifier (for latest enrollment)
  private revokedNullifiers = new Set<string>();

  async createEnrollment(enrollment: Enrollment): Promise<void> {
    if (this.enrollments.has(enrollment.nullifier)) {
      throw new Error(`Enrollment nullifier already exists: ${enrollment.nullifier}`);
    }

    const userActionKey = `${enrollment.telegramUserId}:${enrollment.action}`;
    if (this.telegramUserIndex.has(userActionKey)) {
      throw new Error(
        `Enrollment for telegramUserId ${enrollment.telegramUserId} and action ${enrollment.action} already exists`,
      );
    }

    this.enrollments.set(enrollment.nullifier, enrollment);
    this.telegramUserIndex.set(userActionKey, enrollment.nullifier);
  }

  async findEnrollment(
    telegramUserId: number,
    action: string,
    currentTime: Date,
  ): Promise<Enrollment | null> {
    const userActionKey = `${telegramUserId}:${action}`;
    const nullifier = this.telegramUserIndex.get(userActionKey);
    if (!nullifier) {
      return null;
    }

    const enrollment = this.enrollments.get(nullifier);
    if (!enrollment) {
      return null;
    }

    // Revoked enrollments are not active
    if (enrollment.revokedAt) {
      return null;
    }

    const now = Math.floor(currentTime.getTime() / 1000);
    if (enrollment.expiresAt <= now) {
      this.enrollments.delete(nullifier);
      this.telegramUserIndex.delete(userActionKey);
      return null;
    }

    return enrollment;
  }

  async deleteEnrollment(nullifier: string): Promise<boolean> {
    const enrollment = this.enrollments.get(nullifier);
    if (!enrollment) {
      return false;
    }

    const userActionKey = `${enrollment.telegramUserId}:${enrollment.action}`;
    this.enrollments.delete(nullifier);
    this.telegramUserIndex.delete(userActionKey);
    return true;
  }

  async expireEnrollments(beforeTimestamp: number): Promise<number> {
    let count = 0;
    for (const [nullifier, enrollment] of this.enrollments.entries()) {
      if (enrollment.expiresAt <= beforeTimestamp) {
        const userActionKey = `${enrollment.telegramUserId}:${enrollment.action}`;
        this.enrollments.delete(nullifier);
        this.telegramUserIndex.delete(userActionKey);
        count++;
      }
    }
    return count;
  }

  // Legacy interface methods for backward compatibility with existing tests

  async get(telegramUserId: number): Promise<{ nullifier: string; expiresAt: number; action: string; revoked?: boolean } | null> {
    // Legacy method: get the most recent enrollment for this user (regardless of action)
    const nullifier = this.telegramUserIdToNullifier.get(telegramUserId);
    if (!nullifier) {
      return null;
    }

    const enrollment = this.enrollments.get(nullifier);
    if (!enrollment) {
      return null;
    }

    return {
      nullifier: enrollment.nullifier,
      expiresAt: enrollment.expiresAt,
      action: enrollment.action,
      revoked: this.revokedNullifiers.has(nullifier),
    };
  }

  async set(enrollment: { telegramUserId: number; nullifier?: string; worldIdNullifier?: string; expiresAt: number; action: string }): Promise<void> {
    // Support both old worldIdNullifier and new nullifier field names
    const nullifier = enrollment.nullifier || enrollment.worldIdNullifier;
    if (!nullifier) {
      throw new Error("Enrollment must have either nullifier or worldIdNullifier field");
    }

    const userActionKey = `${enrollment.telegramUserId}:${enrollment.action}`;
    
    // Remove old enrollment if exists
    const oldNullifier = this.telegramUserIndex.get(userActionKey);
    if (oldNullifier) {
      this.enrollments.delete(oldNullifier);
      this.revokedNullifiers.delete(oldNullifier);
    }

    const fullEnrollment: Enrollment = {
      nullifier,
      telegramUserId: enrollment.telegramUserId,
      action: enrollment.action,
      expiresAt: enrollment.expiresAt,
      createdAt: new Date().toISOString(),
    };

    this.enrollments.set(nullifier, fullEnrollment);
    this.telegramUserIndex.set(userActionKey, nullifier);
    this.telegramUserIdToNullifier.set(enrollment.telegramUserId, nullifier);
  }

  async revoke(telegramUserId: number): Promise<void> {
    // Legacy method: revoke the most recent enrollment for this user
    const nullifier = this.telegramUserIdToNullifier.get(telegramUserId);
    if (nullifier) {
      this.revokedNullifiers.add(nullifier);
    }
  }

  async revokeEnrollment(nullifier: string, revokedBy: 'user' | 'admin'): Promise<boolean> {
    const enrollment = this.enrollments.get(nullifier);
    if (!enrollment || enrollment.revokedAt) {
      return false;
    }

    enrollment.revokedAt = new Date().toISOString();
    enrollment.revokedBy = revokedBy;
    this.revokedNullifiers.add(nullifier);
    return true;
  }

  async reactivateEnrollment(nullifier: string, reactivatedBy: 'user' | 'admin'): Promise<boolean> {
    const enrollment = this.enrollments.get(nullifier);
    if (!enrollment || !enrollment.revokedAt) {
      return false;
    }

    enrollment.reactivatedAt = new Date().toISOString();
    enrollment.reactivatedBy = reactivatedBy;
    enrollment.revokedAt = null;
    enrollment.revokedBy = null;
    this.revokedNullifiers.delete(nullifier);
    return true;
  }

  private sessionNullifierClaims = new Map<string, SessionNullifierClaim>();

  async recordSessionNullifierClaim(claim: SessionNullifierClaim): Promise<void> {
    const key = `${claim.sessionNullifier}:${claim.action}`;
    if (this.sessionNullifierClaims.has(key)) {
      throw new Error(`Session nullifier already claimed: ${claim.sessionNullifier}`);
    }
    this.sessionNullifierClaims.set(key, claim);
  }

  async isSessionNullifierClaimed(sessionNullifier: string, action: string): Promise<boolean> {
    const key = `${sessionNullifier}:${action}`;
    return this.sessionNullifierClaims.has(key);
  }
}
