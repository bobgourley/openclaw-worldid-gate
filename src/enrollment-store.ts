/**
 * In-memory enrollment store for testing
 * 
 * This is a TEST-ONLY implementation. Production requires:
 * - Durable storage (database, file system with fsync, etc.)
 * - Concurrent access protection (locks, transactions)
 * - Proof reuse prevention across restarts
 * - Nullifier replay protection
 * - Proper error handling for storage failures
 */

import type { Enrollment, EnrollmentStore } from './types.js';

export class InMemoryEnrollmentStore implements EnrollmentStore {
  private readonly enrollments = new Map<number, Enrollment>();

  async get(telegramUserId: number): Promise<Enrollment | null> {
    return this.enrollments.get(telegramUserId) ?? null;
  }

  async set(enrollment: Enrollment): Promise<void> {
    this.enrollments.set(enrollment.telegramUserId, enrollment);
  }

  async revoke(telegramUserId: number): Promise<void> {
    const enrollment = this.enrollments.get(telegramUserId);
    if (enrollment) {
      enrollment.revoked = true;
    }
  }

  /**
   * TEST-ONLY: Clear all enrollments
   */
  clear(): void {
    this.enrollments.clear();
  }

  /**
   * TEST-ONLY: Check if a nullifier has been used
   */
  hasNullifier(nullifier: string): boolean {
    for (const enrollment of this.enrollments.values()) {
      if (enrollment.worldIdNullifier === nullifier) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Production enrollment store (UNIMPLEMENTED)
 * 
 * Requirements:
 * - Durable storage backend (PostgreSQL, SQLite with WAL, etc.)
 * - Unique constraint on nullifiers to prevent reuse
 * - Index on telegramUserId for fast lookups
 * - Atomic check-and-set for enrollment creation
 * - Proper transaction handling
 * - Connection pooling and error recovery
 */
export class DurableEnrollmentStore implements EnrollmentStore {
  async get(_telegramUserId: number): Promise<Enrollment | null> {
    throw new Error('Durable enrollment store is not implemented');
  }

  async set(_enrollment: Enrollment): Promise<void> {
    throw new Error('Durable enrollment store is not implemented');
  }

  async revoke(_telegramUserId: number): Promise<void> {
    throw new Error('Durable enrollment store is not implemented');
  }
}
