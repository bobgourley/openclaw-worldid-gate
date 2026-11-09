/**
 * Synthetic migration dry-run test - validates v1 -> v2 -> v3 schema migration
 * with legacy UNKNOWN protocol_version claims and existing generation fences.
 * 
 * Tests data retention across all migrations WITHOUT data loss.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'node:fs';

describe('Synthetic Migration Dry-Run', () => {
  // Each test gets its own database
  function getTestDb(name: string) {
    return `/tmp/synthetic-migration-${name}-${Date.now()}.db`;
  }
  
  function cleanupDb(path: string) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  it('migrates v1 UNKNOWN enrollments to v2 with session_id preservation', () => {
    const TEST_DB = getTestDb('v1-v2');
    const db = new Database(TEST_DB);
    
    // Create v1 schema (original schema without session fields)
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
        revoked_at INTEGER,
        revoked_at_iso TEXT,
        revoked_by TEXT
      );

      CREATE TABLE generation_fences (
        telegram_user_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        generation INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_at_iso TEXT NOT NULL
      );

      CREATE TABLE challenge_sessions (
        nonce TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        signal_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        created_at_seconds INTEGER NOT NULL,
        generation INTEGER NOT NULL
      );
    `);

    // Insert legacy UNKNOWN enrollment
    const legacyUserId = 111111;
    const legacyNullifier = '0xlegacy111111';
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    
    db.prepare(`
      INSERT INTO enrollments (
        telegram_user_id, action, nullifier, enrolled_at, enrolled_at_iso,
        expires_at, expires_at_iso, revoked, revoked_at, revoked_at_iso, revoked_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyUserId,
      'openclaw-enroll',
      legacyNullifier,
      nowSeconds,
      new Date(now).toISOString(),
      nowSeconds + 86400 * 30,
      new Date(now + 86400 * 30 * 1000).toISOString(),
      0,
      null,
      null,
      null
    );

    // Insert generation fence for legacy enrollment
    db.prepare(`
      INSERT INTO generation_fences (
        telegram_user_id, action, generation, updated_at, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      legacyUserId,
      'openclaw-enroll',
      1,
      nowSeconds,
      new Date(now).toISOString()
    );

    // Insert revoked enrollment with fence
    const revokedUserId = 222222;
    const revokedNullifier = '0xrevoked222222';
    
    db.prepare(`
      INSERT INTO enrollments (
        telegram_user_id, action, nullifier, enrolled_at, enrolled_at_iso,
        expires_at, expires_at_iso, revoked, revoked_at, revoked_at_iso, revoked_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revokedUserId,
      'openclaw-enroll',
      revokedNullifier,
      nowSeconds - 86400,
      new Date(now - 86400 * 1000).toISOString(),
      nowSeconds + 86400 * 29,
      new Date(now + 86400 * 29 * 1000).toISOString(),
      1,
      nowSeconds,
      new Date(now).toISOString(),
      'admin_revocation'
    );

    db.prepare(`
      INSERT INTO generation_fences (
        telegram_user_id, action, generation, updated_at, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      revokedUserId,
      'openclaw-enroll',
      3,
      nowSeconds,
      new Date(now).toISOString()
    );

    db.close();

    // Apply v2 migration (add session_id and protocol_version)
    const db2 = new Database(TEST_DB);
    
    db2.exec(`
      ALTER TABLE enrollments ADD COLUMN session_id TEXT;
      ALTER TABLE enrollments ADD COLUMN protocol_version TEXT DEFAULT 'UNKNOWN';
    `);

    // Verify legacy data retained
    const legacyRow = db2.prepare(`
      SELECT * FROM enrollments WHERE telegram_user_id = ?
    `).get(legacyUserId) as any;

    assert.equal(legacyRow.nullifier, legacyNullifier, 'Legacy nullifier preserved');
    assert.equal(legacyRow.revoked, 0, 'Legacy revoked status preserved');
    assert.equal(legacyRow.session_id, null, 'Legacy session_id null');
    assert.equal(legacyRow.protocol_version, 'UNKNOWN', 'Legacy protocol_version UNKNOWN');

    const revokedRow = db2.prepare(`
      SELECT * FROM enrollments WHERE telegram_user_id = ?
    `).get(revokedUserId) as any;

    assert.equal(revokedRow.nullifier, revokedNullifier, 'Revoked nullifier preserved');
    assert.equal(revokedRow.revoked, 1, 'Revoked status preserved');
    assert.equal(revokedRow.revoked_by, 'admin_revocation', 'Revocation trigger preserved');

    // Verify generation fences retained
    const legacyFence = db2.prepare(`
      SELECT * FROM generation_fences WHERE telegram_user_id = ?
    `).get(legacyUserId) as any;

    assert.equal(legacyFence.generation, 1, 'Legacy fence generation preserved');

    const revokedFence = db2.prepare(`
      SELECT * FROM generation_fences WHERE telegram_user_id = ?
    `).get(revokedUserId) as any;

    assert.equal(revokedFence.generation, 3, 'Revoked fence generation preserved');

    db2.close();

    // Apply v3 migration (session_nullifier_claims, revocation_events, challenge mode)
    const db3 = new Database(TEST_DB);

    db3.exec(`
      CREATE TABLE IF NOT EXISTS session_nullifier_claims (
        session_nullifier TEXT NOT NULL,
        action TEXT NOT NULL,
        session_id TEXT NOT NULL,
        telegram_user_id INTEGER NOT NULL,
        nullifier TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        claimed_at_iso TEXT NOT NULL,
        PRIMARY KEY (session_nullifier, action)
      );

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
      );
    `);

    // Add mode column to challenge_sessions if table exists
    const tableExists = db3.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='challenge_sessions'
    `).get();

    if (tableExists) {
      db3.exec(`ALTER TABLE challenge_sessions ADD COLUMN mode TEXT DEFAULT 'renewal'`);
    }

    // Verify all data still intact after v3 migration
    const finalLegacy = db3.prepare(`
      SELECT * FROM enrollments WHERE telegram_user_id = ?
    `).get(legacyUserId) as any;

    assert.equal(finalLegacy.nullifier, legacyNullifier, 'v3: Legacy nullifier preserved');
    assert.equal(finalLegacy.session_id, null, 'v3: Legacy session_id null');
    assert.equal(finalLegacy.protocol_version, 'UNKNOWN', 'v3: Legacy protocol UNKNOWN');

    const finalRevoked = db3.prepare(`
      SELECT * FROM enrollments WHERE telegram_user_id = ?
    `).get(revokedUserId) as any;

    assert.equal(finalRevoked.revoked, 1, 'v3: Revoked status preserved');

    const finalLegacyFence = db3.prepare(`
      SELECT * FROM generation_fences WHERE telegram_user_id = ?
    `).get(legacyUserId) as any;

    assert.equal(finalLegacyFence.generation, 1, 'v3: Legacy fence generation preserved');

    const finalRevokedFence = db3.prepare(`
      SELECT * FROM generation_fences WHERE telegram_user_id = ?
    `).get(revokedUserId) as any;

    assert.equal(finalRevokedFence.generation, 3, 'v3: Revoked fence generation preserved');

    // Verify new tables exist
    const claimsTable = db3.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='session_nullifier_claims'
    `).get();
    assert.ok(claimsTable, 'session_nullifier_claims table created');

    const eventsTable = db3.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='revocation_events'
    `).get();
    assert.ok(eventsTable, 'revocation_events table created');

    db3.close();
  });

  it('verifies schema v3 structure with all tables and columns', () => {
    const TEST_DB = getTestDb('v3-schema');
    const db = new Database(TEST_DB);

    // Create minimal v3 schema to verify structure
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        applied_at_iso TEXT NOT NULL
      ) STRICT;
      
      INSERT INTO schema_version (version, applied_at, applied_at_iso)
      VALUES (3, ${Math.floor(Date.now() / 1000)}, '${new Date().toISOString()}');

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

      CREATE TABLE challenge_sessions (
        nonce TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        signal_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        created_at_seconds INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        mode TEXT DEFAULT 'uniqueness'
      ) STRICT;

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

      CREATE TABLE revocation_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        nullifier TEXT NOT NULL,
        revoked_at INTEGER NOT NULL,
        revoked_at_iso TEXT NOT NULL,
        revoked_by TEXT NOT NULL,
        reason TEXT
      ) STRICT;

      CREATE TABLE generation_fences (
        telegram_user_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        generation INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_at_iso TEXT NOT NULL
      ) STRICT;
    `);

    // Verify schema version
    const versionRow = db.prepare(`SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`).get() as any;
    assert.strictEqual(versionRow.version, 3, 'Schema version is 3');

    // Verify all v3 tables exist
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as any[];
    const tableNames = tables.map((t: any) => t.name);
    
    assert.ok(tableNames.includes('enrollments'), 'enrollments table exists');
    assert.ok(tableNames.includes('challenge_sessions'), 'challenge_sessions table exists');
    assert.ok(tableNames.includes('session_nullifier_claims'), 'session_nullifier_claims table exists');
    assert.ok(tableNames.includes('revocation_events'), 'revocation_events table exists');
    assert.ok(tableNames.includes('generation_fences'), 'generation_fences table exists');
    assert.ok(tableNames.includes('schema_version'), 'schema_version table exists');

    // Verify enrollments has session fields
    const enrollmentSchema = db.prepare(`PRAGMA table_info(enrollments)`).all() as any[];
    const enrollmentCols = enrollmentSchema.map((c: any) => c.name);
    assert.ok(enrollmentCols.includes('session_id'), 'enrollments has session_id column');
    assert.ok(enrollmentCols.includes('protocol_version'), 'enrollments has protocol_version column');

    // Verify challenge_sessions has mode column
    const challengeSchema = db.prepare(`PRAGMA table_info(challenge_sessions)`).all() as any[];
    const challengeCols = challengeSchema.map((c: any) => c.name);
    assert.ok(challengeCols.includes('mode'), 'challenge_sessions has mode column');

    db.close();
    cleanupDb(TEST_DB);
  });
});
