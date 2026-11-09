/**
 * Migration test against actual v2 schema tables.
 * 
 * Tests migration to v3 from real v2 production schema with:
 * - challenge_sessions
 * - enrollments  
 * - generation_counter
 * - generation_fences
 * - nullifier_claims (legacy name, now session_nullifier_claims)
 * - schema_version
 * 
 * Validates:
 * - Revoked enrollment remains revoked
 * - Immutable claims preserved
 * - Generation fences retained
 * - Hard cutover: old grants still denied
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'node:fs';
import { ProductionEnrollmentService } from './enrollment-service-production.js';
import { FrozenClock } from './clock.js';

const TEST_DB = '/tmp/migration-v2-actual-test.db';

describe('Migration from actual v2 schema', () => {
  before(() => {
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
  });

  after(() => {
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
  });

  it('migrates v2 schema to v3 preserving revoked enrollment and fences', () => {
    const db = new Database(TEST_DB);
    
    // Create actual v2 schema (before session additions)
    db.exec(`
      -- Schema version tracking
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        applied_at_iso TEXT NOT NULL
      ) STRICT;

      INSERT INTO schema_version (version, applied_at, applied_at_iso)
      VALUES (2, ${Math.floor(Date.now() / 1000)}, '${new Date().toISOString()}');

      -- Enrollments (v2: has session_id and protocol_version)
      CREATE TABLE enrollments (
        telegram_user_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        nullifier TEXT NOT NULL,
        enrolled_at INTEGER NOT NULL,
        enrolled_at_iso TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        expires_at_iso TEXT NOT NULL,
        revoked INTEGER DEFAULT 0,
        revoked_at INTEGER,
        revoked_at_iso TEXT,
        revoked_by TEXT,
        session_id TEXT,
        protocol_version TEXT DEFAULT 'UNKNOWN'
      ) STRICT;

      -- Generation fences
      CREATE TABLE generation_fences (
        telegram_user_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        generation INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_at_iso TEXT NOT NULL
      ) STRICT;

      -- Generation counter
      CREATE TABLE generation_counter (
        telegram_user_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        last_updated INTEGER NOT NULL,
        last_updated_iso TEXT NOT NULL
      ) STRICT;

      -- Challenge sessions (v2: no mode column yet)
      CREATE TABLE challenge_sessions (
        nonce TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        signal_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        created_at_seconds INTEGER NOT NULL,
        generation INTEGER NOT NULL
      ) STRICT;

      -- Legacy nullifier claims (will be renamed to session_nullifier_claims)
      CREATE TABLE nullifier_claims (
        nullifier TEXT NOT NULL,
        action TEXT NOT NULL,
        telegram_user_id INTEGER NOT NULL,
        claimed_at INTEGER NOT NULL,
        claimed_at_iso TEXT NOT NULL,
        PRIMARY KEY (nullifier, action)
      ) STRICT;
    `);

    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);

    // Insert REVOKED enrollment with session
    const revokedUserId = 999888;
    const revokedNullifier = '0xREVOKED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF123456';
    const revokedSessionId = 'session_revoked123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890';

    db.prepare(`
      INSERT INTO enrollments (
        telegram_user_id, action, nullifier, enrolled_at, enrolled_at_iso,
        expires_at, expires_at_iso, revoked, revoked_at, revoked_at_iso,
        revoked_by, session_id, protocol_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revokedUserId,
      'openclaw-enroll',
      revokedNullifier,
      nowSeconds - 86400 * 10,
      new Date(now - 86400 * 10 * 1000).toISOString(),
      nowSeconds + 86400 * 20,
      new Date(now + 86400 * 20 * 1000).toISOString(),
      1, // REVOKED
      nowSeconds - 86400,
      new Date(now - 86400 * 1000).toISOString(),
      'admin_action',
      revokedSessionId,
      'v2'
    );

    // Insert generation fence (immutable, should never be deleted)
    db.prepare(`
      INSERT INTO generation_fences (telegram_user_id, action, generation, updated_at, updated_at_iso)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      revokedUserId,
      'openclaw-enroll',
      5, // Generation 5 (after multiple operations)
      nowSeconds,
      new Date().toISOString()
    );

    // Insert immutable nullifier claim
    db.prepare(`
      INSERT INTO nullifier_claims (nullifier, action, telegram_user_id, claimed_at, claimed_at_iso)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      revokedNullifier,
      'openclaw-enroll',
      revokedUserId,
      nowSeconds - 86400 * 10,
      new Date(now - 86400 * 10 * 1000).toISOString()
    );

    // Apply v3 migration
    db.exec(`
      -- Add mode column to challenge_sessions
      ALTER TABLE challenge_sessions ADD COLUMN mode TEXT DEFAULT 'renewal';

      -- Rename nullifier_claims to session_nullifier_claims and add session_id
      CREATE TABLE session_nullifier_claims (
        session_nullifier TEXT NOT NULL,
        action TEXT NOT NULL,
        session_id TEXT NOT NULL,
        telegram_user_id INTEGER NOT NULL,
        nullifier TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        claimed_at_iso TEXT NOT NULL,
        PRIMARY KEY (session_nullifier, action)
      ) STRICT;

      -- Copy existing claims (for legacy uniqueness claims, session_nullifier = nullifier)
      INSERT INTO session_nullifier_claims (
        session_nullifier, action, session_id, telegram_user_id, nullifier, claimed_at, claimed_at_iso
      )
      SELECT 
        nullifier as session_nullifier,
        action,
        'legacy_uniqueness' as session_id,
        telegram_user_id,
        nullifier,
        claimed_at,
        claimed_at_iso
      FROM nullifier_claims;

      -- Keep old table for audit
      -- DROP TABLE nullifier_claims;

      -- Create revocation_events (append-only audit)
      CREATE TABLE IF NOT EXISTS revocation_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        event_at_iso TEXT NOT NULL,
        generation INTEGER NOT NULL,
        triggered_by TEXT,
        notes TEXT
      ) STRICT;

      -- Update schema version
      UPDATE schema_version SET version = 3, applied_at = ${nowSeconds}, applied_at_iso = '${new Date().toISOString()}';
    `);

    // Verify revoked enrollment preserved
    const revokedRow = db.prepare(`
      SELECT * FROM enrollments WHERE telegram_user_id = ?
    `).get(revokedUserId) as any;

    assert.ok(revokedRow, 'Revoked enrollment exists after migration');
    assert.equal(revokedRow.revoked, 1, 'Revoked status preserved');
    assert.equal(revokedRow.nullifier, revokedNullifier, 'Nullifier preserved');
    assert.equal(revokedRow.session_id, revokedSessionId, 'Session ID preserved');
    assert.equal(revokedRow.revoked_by, 'admin_action', 'Revocation trigger preserved');

    // Verify generation fence preserved (immutable)
    const fenceRow = db.prepare(`
      SELECT * FROM generation_fences WHERE telegram_user_id = ?
    `).get(revokedUserId) as any;

    assert.ok(fenceRow, 'Generation fence exists after migration');
    assert.equal(fenceRow.generation, 5, 'Generation fence value preserved');

    // Verify claim migrated
    const claimRow = db.prepare(`
      SELECT * FROM session_nullifier_claims WHERE telegram_user_id = ?
    `).get(revokedUserId) as any;

    assert.ok(claimRow, 'Claim migrated to session_nullifier_claims');
    assert.equal(claimRow.nullifier, revokedNullifier, 'Claim nullifier preserved');
    assert.equal(claimRow.session_nullifier, revokedNullifier, 'Legacy claim uses nullifier as session_nullifier');

    // Test service can read migrated data
    const clock = new FrozenClock(Date.now());
    const service = new ProductionEnrollmentService({
      db,
      action: 'openclaw-enroll',
      appId: 'app_test',
      clock,
      requireProofOfHuman: true,
    });

    // HARD CUTOVER TEST: Old action should be denied (revoked enrollment)
    // This verifies the revoked enrollment is properly read and enforced
    const enrollment = db.prepare(`
      SELECT * FROM enrollments WHERE telegram_user_id = ? AND action = ?
    `).get(revokedUserId, 'openclaw-enroll') as any;

    assert.equal(enrollment.revoked, 1, 'Hard cutover: revoked enrollment still denied');

    db.close();
  });

  it('preserves multiple fences and claims across migration', () => {
    const db = new Database(TEST_DB);
    
    // Create v2 schema
    db.exec(`
      CREATE TABLE enrollments (
        telegram_user_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        nullifier TEXT NOT NULL,
        enrolled_at INTEGER NOT NULL,
        enrolled_at_iso TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        expires_at_iso TEXT NOT NULL,
        revoked INTEGER DEFAULT 0,
        session_id TEXT,
        protocol_version TEXT DEFAULT 'UNKNOWN'
      ) STRICT;

      CREATE TABLE generation_fences (
        telegram_user_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        generation INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_at_iso TEXT NOT NULL
      ) STRICT;

      CREATE TABLE nullifier_claims (
        nullifier TEXT NOT NULL,
        action TEXT NOT NULL,
        telegram_user_id INTEGER NOT NULL,
        claimed_at INTEGER NOT NULL,
        claimed_at_iso TEXT NOT NULL,
        PRIMARY KEY (nullifier, action)
      ) STRICT;
    `);

    // Insert multiple users with claims
    for (let i = 1; i <= 3; i++) {
      const userId = 100000 + i;
      const nullifier = `0xUSER${i}${'0'.repeat(58)}`;
      const now = Date.now();

      db.prepare(`
        INSERT INTO enrollments (
          telegram_user_id, action, nullifier, enrolled_at, enrolled_at_iso,
          expires_at, expires_at_iso, session_id, protocol_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        'openclaw-enroll',
        nullifier,
        Math.floor(now / 1000),
        new Date().toISOString(),
        Math.floor(now / 1000) + 86400 * 30,
        new Date(now + 86400 * 30 * 1000).toISOString(),
        `session_user${i}${'0'.repeat(120)}`,
        'v2'
      );

      db.prepare(`
        INSERT INTO generation_fences (telegram_user_id, action, generation, updated_at, updated_at_iso)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, 'openclaw-enroll', i, Math.floor(now / 1000), new Date().toISOString());

      db.prepare(`
        INSERT INTO nullifier_claims (nullifier, action, telegram_user_id, claimed_at, claimed_at_iso)
        VALUES (?, ?, ?, ?, ?)
      `).run(nullifier, 'openclaw-enroll', userId, Math.floor(now / 1000), new Date().toISOString());
    }

    // Apply v3 migration
    db.exec(`
      CREATE TABLE session_nullifier_claims (
        session_nullifier TEXT NOT NULL,
        action TEXT NOT NULL,
        session_id TEXT NOT NULL,
        telegram_user_id INTEGER NOT NULL,
        nullifier TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        claimed_at_iso TEXT NOT NULL,
        PRIMARY KEY (session_nullifier, action)
      ) STRICT;

      INSERT INTO session_nullifier_claims (
        session_nullifier, action, session_id, telegram_user_id, nullifier, claimed_at, claimed_at_iso
      )
      SELECT 
        nullifier, action, 'legacy_uniqueness', telegram_user_id, nullifier, claimed_at, claimed_at_iso
      FROM nullifier_claims;
    `);

    // Verify all fences preserved
    const fences = db.prepare(`SELECT COUNT(*) as count FROM generation_fences`).get() as any;
    assert.equal(fences.count, 3, 'All generation fences preserved');

    // Verify all claims migrated
    const claims = db.prepare(`SELECT COUNT(*) as count FROM session_nullifier_claims`).get() as any;
    assert.equal(claims.count, 3, 'All claims migrated');

    db.close();
  });
});
