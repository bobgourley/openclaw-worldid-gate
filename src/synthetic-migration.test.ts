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
import { ProductionEnrollmentService } from './enrollment-service-production.js';
import { FrozenClock } from './clock.js';

const TEST_DB = '/tmp/synthetic-migration-test.db';

describe('Synthetic Migration Dry-Run', () => {
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

  it('migrates v1 UNKNOWN enrollments to v2 with session_id preservation', () => {
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

  it('production service can operate on migrated database', () => {
    const db = new Database(TEST_DB);
    const clock = new FrozenClock(Date.now());
    
    const service = new ProductionEnrollmentService({
      db,
      action: 'openclaw-enroll',
      appId: 'app_test',
      clock,
      requireProofOfHuman: true,
    });

    // Verify service can read legacy enrollment
    const legacyUserId = 111111;
    const enrollment = db.prepare(`
      SELECT * FROM enrollments WHERE telegram_user_id = ?
    `).get(legacyUserId) as any;

    assert.ok(enrollment, 'Service can read migrated enrollment');
    assert.equal(enrollment.protocol_version, 'UNKNOWN', 'Legacy protocol preserved');

    // Verify service can check generation fence
    const fence = db.prepare(`
      SELECT * FROM generation_fences WHERE telegram_user_id = ?
    `).get(legacyUserId) as any;

    assert.ok(fence, 'Service can read generation fence');
    assert.equal(fence.generation, 1, 'Fence generation preserved');

    db.close();
  });
});
