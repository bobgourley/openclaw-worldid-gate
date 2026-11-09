/**
 * Tests for schema v4 migration (member tags table).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import Database from 'better-sqlite3';

describe('Migration v4: member_tags table', () => {
  it('should create member_tags table', async () => {
    const dbPath = join(tmpdir(), `test-migration-v4-${Date.now()}.db`);

    try {
      const challengeAdapter = new WorldIdChallengeAdapter({
        appId: 'app_test' as `app_${string}`,
        rpId: 'rp_test' as `rp_${string}`,
        signingKeyHex: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        challengeTtlSeconds: 300,
        environment: 'staging',
      });

      const stubVerifier = {
        verify: async () => ({ success: true, nullifier: '0x1234' }),
      };

      const service = new EnrollmentService({
        dbPath,
        challengeAdapter,
        verificationClient: stubVerifier as any,
        telegramBotToken: 'test_token',
        action: 'test-action',
        challengeTtlSeconds: 300,
        enrollmentTtlSeconds: 2592000,
      });

      // Check schema version
      const db = (service as any).db as Database.Database;
      const version = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as any;
      assert.ok(version.version >= 4, 'Schema version should be at least 4');

      // Check member_tags table exists
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='member_tags'`)
        .get();
      assert.ok(tableExists, 'member_tags table should exist');

      // Check table structure
      const columns = db.prepare(`PRAGMA table_info(member_tags)`).all() as any[];
      const columnNames = columns.map(c => c.name);
      
      assert.ok(columnNames.includes('telegram_user_id'), 'Should have telegram_user_id column');
      assert.ok(columnNames.includes('chat_id'), 'Should have chat_id column');
      assert.ok(columnNames.includes('applied_text'), 'Should have applied_text column');
      assert.ok(columnNames.includes('applied_at'), 'Should have applied_at column');
      assert.ok(columnNames.includes('removed_at'), 'Should have removed_at column');

      // Check primary key
      const pkColumns = columns.filter(c => c.pk > 0).map(c => c.name).sort();
      assert.deepStrictEqual(pkColumns, ['chat_id', 'telegram_user_id'], 'Primary key should be (telegram_user_id, chat_id)');

      // Check index exists
      const indexes = db.prepare(`PRAGMA index_list(member_tags)`).all() as any[];
      const indexNames = indexes.map(i => i.name);
      assert.ok(indexNames.some(n => n.includes('removed')), 'Should have index on removed_at');

      service.close();
    } finally {
      try {
        await unlink(dbPath);
      } catch {}
    }
  });

  it('should be idempotent', async () => {
    const dbPath = join(tmpdir(), `test-migration-v4-idempotent-${Date.now()}.db`);

    try {
      const challengeAdapter = new WorldIdChallengeAdapter({
        appId: 'app_test' as `app_${string}`,
        rpId: 'rp_test' as `rp_${string}`,
        signingKeyHex: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        challengeTtlSeconds: 300,
        environment: 'staging',
      });

      const stubVerifier = {
        verify: async () => ({ success: true, nullifier: '0x1234' }),
      };

      // Create service twice to ensure migration is idempotent
      const service1 = new EnrollmentService({
        dbPath,
        challengeAdapter,
        verificationClient: stubVerifier as any,
        telegramBotToken: 'test_token',
        action: 'test-action',
        challengeTtlSeconds: 300,
        enrollmentTtlSeconds: 2592000,
      });

      service1.close();

      const service2 = new EnrollmentService({
        dbPath,
        challengeAdapter,
        verificationClient: stubVerifier as any,
        telegramBotToken: 'test_token',
        action: 'test-action',
        challengeTtlSeconds: 300,
        enrollmentTtlSeconds: 2592000,
      });

      // Check schema version is still correct
      const db = (service2 as any).db as Database.Database;
      const version = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as any;
      assert.ok(version.version >= 4, 'Schema version should be at least 4');

      service2.close();
    } finally {
      try {
        await unlink(dbPath);
      } catch {}
    }
  });

  it('should preserve existing data', async () => {
    const dbPath = join(tmpdir(), `test-migration-v4-preserve-${Date.now()}.db`);

    try {
      const challengeAdapter = new WorldIdChallengeAdapter({
        appId: 'app_test' as `app_${string}`,
        rpId: 'rp_test' as `rp_${string}`,
        signingKeyHex: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        challengeTtlSeconds: 300,
        environment: 'staging',
      });

      const stubVerifier = {
        verify: async () => ({ success: true, nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' }),
      };

      const service = new EnrollmentService({
        dbPath,
        challengeAdapter,
        verificationClient: stubVerifier as any,
        telegramBotToken: 'test_token',
        action: 'test-action',
        challengeTtlSeconds: 300,
        enrollmentTtlSeconds: 2592000,
      });

      // Insert test enrollment
      await service.directEnroll({
        telegramUserId: 123,
        nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        credential: { credential_type: 'proof_of_human' },
      });

      // Verify enrollment exists
      const enrollment = await service.findEnrollment(123);
      assert.ok(enrollment, 'Enrollment should exist after migration');
      assert.strictEqual(enrollment.telegramUserId, 123);

      service.close();
    } finally {
      try {
        await unlink(dbPath);
      } catch {}
    }
  });
});
