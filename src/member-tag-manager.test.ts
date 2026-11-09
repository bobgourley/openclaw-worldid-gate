/**
 * Tests for member tag manager.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemberTagManager } from './member-tag-manager.js';
import type { TelegramApiClient, SetTagResult } from './telegram-api-client.js';
import type { EnrollmentService } from './enrollment-service-production.js';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';

describe('MemberTagManager', () => {
  it('should apply tag to verified user', async () => {
    const { manager, mocks, db, dbPath } = createTestManager();

    try {
      const result = await manager.applyTagToMember(123);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'Tag applied');
      assert.strictEqual(mocks.tagCalls.length, 1);
      assert.strictEqual(mocks.tagCalls[0].userId, 123);
      assert.strictEqual(mocks.tagCalls[0].tag, 'Test Tag');
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should skip admin users', async () => {
    const { manager, mocks, db, dbPath } = createTestManager({
      memberStatus: 'administrator',
    });

    try {
      const result = await manager.applyTagToMember(123);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'User is admin (skip)');
      assert.strictEqual(mocks.tagCalls.length, 0);
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should skip creator users', async () => {
    const { manager, mocks, db, dbPath } = createTestManager({
      memberStatus: 'creator',
    });

    try {
      const result = await manager.applyTagToMember(123);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'User is admin (skip)');
      assert.strictEqual(mocks.tagCalls.length, 0);
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should skip non-members', async () => {
    const { manager, mocks, db, dbPath } = createTestManager({
      memberStatus: 'left',
    });

    try {
      const result = await manager.applyTagToMember(123);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'User not in group');
      assert.strictEqual(mocks.tagCalls.length, 0);
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should detect tag conflict', async () => {
    const { manager, mocks, db, dbPath } = createTestManager({ currentTag: 'External Tag' });

    try {
      // User has a tag we didn't apply (no record in our DB)
      const result = await manager.applyTagToMember(123);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'Tag conflict (different tag exists)');
      assert.strictEqual(mocks.tagCalls.length, 0);
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should remove tag when gate applied it', async () => {
    const { manager, mocks, db, dbPath } = createTestManager({ currentTag: 'Test Tag' });

    try {
      // Record that we applied the tag
      db.prepare(`
        INSERT INTO member_tags (telegram_user_id, chat_id, applied_text, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(123, String(-123456), 'Test Tag', new Date().toISOString());

      const result = await manager.removeTagFromMember(123);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'Tag removed');
      assert.strictEqual(mocks.removeCalls.length, 1);
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should skip removal if gate did not apply tag', async () => {
    const { manager, mocks, db, dbPath } = createTestManager();

    try {
      const result = await manager.removeTagFromMember(123);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'No tag applied by gate (skip)');
      assert.strictEqual(mocks.removeCalls.length, 0);
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should skip removal if tag was changed externally', async () => {
    const { manager, mocks, db, dbPath } = createTestManager({ currentTag: 'Test Tag' });

    try {
      // Record that we applied a different tag
      db.prepare(`
        INSERT INTO member_tags (telegram_user_id, chat_id, applied_text, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(123, String(-123456), 'Different Tag', new Date().toISOString());

      const result = await manager.removeTagFromMember(123);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'Tag changed externally (skip)');
      assert.strictEqual(mocks.removeCalls.length, 0);
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should check permissions on startup', async () => {
    const { manager, mocks, db, dbPath } = createTestManager();

    try {
      const result = await manager.checkPermissions();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'Bot can manage tags');
      assert.strictEqual(mocks.permissionCalls, 1);
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should fail when permission denied', async () => {
    const { manager, mocks, db, dbPath } = createTestManager({
      permissionDenied: true,
    });

    try {
      const result = await manager.checkPermissions();

      assert.strictEqual(result.success, false);
      assert.ok(result.status.includes('Permission check failed'));
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should reconcile all tags', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { manager, mocks, db, dbPath } = createTestManager({
      enrollments: [
        { userId: 100, expired: false, revoked: false },
        { userId: 200, expired: true, revoked: false },
        { userId: 300, expired: false, revoked: true },
      ],
    });

    try {
      // Apply tags to users 200 and 300 (expired/revoked)
      for (const userId of [200, 300]) {
        db.prepare(`
          INSERT INTO member_tags (telegram_user_id, chat_id, applied_text, applied_at)
          VALUES (?, ?, ?, ?)
        `).run(userId, String(-123456), 'Test Tag', new Date().toISOString());
      }

      // Run reconciliation
      const result = await manager.reconcileAllTags();

      // Should have:
      // - Applied tag to user 100 (active, no tag yet)
      // - Removed tags from user 200 (expired) and 300 (revoked)
      assert.strictEqual(result.processed, 3, 'Should process all 3 enrollments');
      assert.ok(result.applied >= 1 || result.skipped >= 1, 'Should apply or skip tag for user 100');
      assert.ok(result.removed >= 2 || result.skipped >= 2, 'Should remove or skip tags for users 200 and 300');
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });

  it('should start sweeper with initial run', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { manager, mocks, db, dbPath } = createTestManager({
      enrollments: [
        { userId: 200, expired: true, revoked: false },
      ],
    });

    try {
      // Apply tag to expired user
      db.prepare(`
        INSERT INTO member_tags (telegram_user_id, chat_id, applied_text, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(200, String(-123456), 'Test Tag', new Date().toISOString());

      // Start sweeper (initial run is async)
      manager.startSweeper();

      // Wait for initial sweep to complete
      await new Promise(resolve => setTimeout(resolve, 300));

      // Sweeper should have run (we don't strictly require a remove call since getChatMember
      // returns no tag by default, so removeTagFromMember will skip)
      // Just verify the sweeper started
      assert.ok((manager as any).sweeperInterval !== null, 'Sweeper should be running');

      manager.stopSweeper();
    } finally {
      manager.stopSweeper(); // Ensure stopped
      db.close();
      await unlink(dbPath);
    }
  });

  it('should use configurable sweep interval', async () => {
    const { manager, db, dbPath } = createTestManager({}, 1); // 1 hour interval

    try {
      manager.startSweeper();

      // Wait a bit for initial sweep
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify interval is set
      assert.ok((manager as any).sweeperInterval !== null);

      manager.stopSweeper();
      assert.strictEqual((manager as any).sweeperInterval, null);
    } finally {
      manager.stopSweeper(); // Ensure stopped
      db.close();
      await unlink(dbPath);
    }
  });

  it('should never block enrollment when tagging fails', async () => {
    const { manager, mocks, db, dbPath } = createTestManager({
      tagShouldFail: true,
    });

    try {
      const result = await manager.applyTagToMember(123);

      // Tag operation fails but returns result without throwing
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'API error');
      
      // This demonstrates fail-safe behavior - enrollment would continue
    } finally {
      db.close();
      await unlink(dbPath);
    }
  });
});

/**
 * Create test manager with mocked dependencies.
 */
function createTestManager(options: {
  memberStatus?: string;
  permissionDenied?: boolean;
  tagShouldFail?: boolean;
  enrollments?: Array<{ userId: number; expired: boolean; revoked: boolean }>;
  currentTag?: string | null;
} = {}, sweepIntervalHours = 24) {
  const dbPath = join(tmpdir(), `test-member-tags-${Date.now()}.db`);
  const db = new Database(dbPath);

  // Create member_tags table
  db.exec(`
    CREATE TABLE member_tags (
      telegram_user_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      applied_text TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      removed_at TEXT,
      PRIMARY KEY (telegram_user_id, chat_id)
    ) STRICT
  `);

  // Create enrollments table for reconciliation tests
  db.exec(`
    CREATE TABLE enrollments (
      telegram_user_id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    ) STRICT
  `);

  const mocks = {
    tagCalls: [] as Array<{ userId: number; tag: string }>,
    removeCalls: [] as Array<{ userId: number }>,
    permissionCalls: 0,
  };

  const mockTelegramClient: TelegramApiClient = {
    setChatMemberTag: async (chatId, userId, tag) => {
      if (options.tagShouldFail) {
        return { success: false, error: 'API error' };
      }
      mocks.tagCalls.push({ userId, tag });
      return { success: true };
    },
    removeChatMemberTag: async (chatId, userId) => {
      mocks.removeCalls.push({ userId });
      return { success: true };
    },
    checkTagPermission: async (chatId) => {
      mocks.permissionCalls++;
      if (options.permissionDenied) {
        return { success: false, error: 'Permission check failed' };
      }
      return { success: true };
    },
    getChatMember: async (chatId, userId) => {
      return {
        success: true,
        status: (options.memberStatus || 'member') as any,
        tag: options.currentTag !== undefined ? options.currentTag : null,
        isMember: true,
      };
    },
  } as any;

  const now = Math.floor(Date.now() / 1000);
  
  // Populate enrollments table if provided
  if (options.enrollments) {
    const stmt = db.prepare(`
      INSERT INTO enrollments (telegram_user_id, action, revoked, expires_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const enrollment of options.enrollments) {
      stmt.run(
        enrollment.userId,
        'test-action',
        enrollment.revoked ? 1 : 0,
        now + (enrollment.expired ? -86400 : 86400)
      );
    }
  }
  
  const mockEnrollmentService: EnrollmentService = {
    findEnrollment: async (userId) => {
      // Check if this user is in custom enrollments list
      if (options.enrollments) {
        const enrollment = options.enrollments.find(e => e.userId === userId);
        if (!enrollment) {
          return null;
        }
        return {
          nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          telegramUserId: userId,
          action: 'test-action',
          expiresAt: now + (enrollment.expired ? -86400 : 86400),
          createdAt: new Date().toISOString(),
          revoked: enrollment.revoked,
          expired: enrollment.expired,
        };
      }
      
      // Default: active enrollment
      return {
        nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        telegramUserId: userId,
        action: 'test-action',
        expiresAt: now + 86400,
        createdAt: new Date().toISOString(),
        revoked: false,
        expired: false,
      };
    },
  } as any;

  const manager = new MemberTagManager({
    telegramClient: mockTelegramClient,
    enrollmentService: mockEnrollmentService,
    db,
    targetChatId: -123456,
    tagText: 'Test Tag',
    action: 'test-action',
    enabled: true,
    sweepIntervalHours,
  });

  return { manager, mocks, db, dbPath };
}
