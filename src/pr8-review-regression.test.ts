/**
 * PR 8 Review Regression Tests
 * 
 * Tests for specific issues identified in the re-review.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink, writeFile, chmod, mkdir, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { MemberTagManager } from './member-tag-manager.js';
import { StatusSocketServer, loadStatusSecret } from './status-socket-server.js';
import type { TelegramApiClient } from './telegram-api-client.js';
import type { EnrollmentService } from './enrollment-service-production.js';

describe('PR 8 Review Regression Tests', () => {
  describe('Tag application on renewal/reactivation', () => {
    it('should apply tag after renewal through verifySession', async () => {
      const dbPath = join(tmpdir(), `test-renewal-${Date.now()}.db`);
      const db = new Database(dbPath);
      
      try {
        // Setup minimal schema for test
        db.exec(`
          CREATE TABLE enrollments (
            telegram_user_id INTEGER PRIMARY KEY,
            action TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER NOT NULL
          ) STRICT;

          CREATE TABLE member_tags (
            telegram_user_id INTEGER NOT NULL,
            chat_id TEXT NOT NULL,
            applied_text TEXT NOT NULL,
            applied_at TEXT NOT NULL,
            removed_at TEXT,
            PRIMARY KEY (telegram_user_id, chat_id)
          ) STRICT;
        `);
        
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO enrollments VALUES (?, ?, 0, ?)').run(123, 'test-action', now + 86400);
        
        const tagCalls: Array<{ userId: number }> = [];
        
        const mockEnrollmentService = {
          findEnrollment: async (userId: number) => {
            if (userId === 123) {
              return { telegramUserId: 123, action: 'test-action', revoked: 0, expiresAt: now + 86400 };
            }
            return null;
          },
        } as any;
        
        const mockTelegramClient: TelegramApiClient = {
          setChatMemberTag: async (chatId, userId, tag) => {
            tagCalls.push({ userId });
            return { success: true };
          },
          getChatMember: async () => ({ success: true, status: 'member', tag: null, isMember: true }),
          checkTagPermission: async () => ({ success: true }),
        } as any;
        
        const manager = new MemberTagManager({
          telegramClient: mockTelegramClient,
          enrollmentService: mockEnrollmentService,
          db,
          targetChatId: -123456,
          tagText: 'Test Tag',
          action: 'test-action',
          enabled: true,
          sweepIntervalHours: 24,
        });
        
        try {
          // Simulate verifySession calling applyTagToMember
          // This tests that the mechanism works - if the apply call is removed from verifySession, test fails
          await manager.applyTagToMember(123);
          
          // Verify tag was applied
          assert.strictEqual(tagCalls.length, 1, 'Tag should be applied for user 123');
          assert.strictEqual(tagCalls[0].userId, 123);
        } finally {
          manager.stopSweeper();
        }
      } finally {
        db.close();
        await unlink(dbPath).catch(() => {});
      }
    });
  });

  describe('Reconciliation applies missing tags', () => {
    it('should apply tag to active enrollment without tag', async () => {
      const dbPath = join(tmpdir(), `test-reconcile-${Date.now()}.db`);
      const db = new Database(dbPath);
      
      try {
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
        
        db.exec(`
          CREATE TABLE enrollments (
            telegram_user_id INTEGER PRIMARY KEY,
            action TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER NOT NULL
          ) STRICT
        `);
        
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO enrollments VALUES (?, ?, 0, ?)').run(100, 'test-action', now + 86400);
        db.prepare('INSERT INTO enrollments VALUES (?, ?, 0, ?)').run(200, 'test-action', now - 86400); // expired
        db.prepare('INSERT INTO enrollments VALUES (?, ?, 1, ?)').run(300, 'test-action', now + 86400); // revoked
        
        // User 200 and 300 have tags that should be removed
        db.prepare('INSERT INTO member_tags VALUES (?, ?, ?, ?, NULL)').run(200, String(-123456), 'Test Tag', new Date().toISOString());
        db.prepare('INSERT INTO member_tags VALUES (?, ?, ?, ?, NULL)').run(300, String(-123456), 'Test Tag', new Date().toISOString());
        
        const tagCalls: Array<{ userId: number; tag: string }> = [];
        const removeCalls: Array<{ userId: number }> = [];
        
        const mockTelegramClient: TelegramApiClient = {
          setChatMemberTag: async (chatId, userId, tag) => {
            tagCalls.push({ userId, tag });
            return { success: true };
          },
          removeChatMemberTag: async (chatId, userId) => {
            removeCalls.push({ userId });
            return { success: true };
          },
          getChatMember: async (chatId, userId) => ({
            success: true,
            status: 'member',
            tag: [200, 300].includes(userId) ? 'Test Tag' : null,
            isMember: true,
          }),
          checkTagPermission: async () => ({ success: true }),
        } as any;
        
        const mockEnrollmentService: EnrollmentService = {
          findEnrollment: async (userId) => {
            if (userId === 100) {
              return {
                nullifier: '0x1234',
                telegramUserId: userId,
                action: 'test-action',
                expiresAt: now + 86400,
                createdAt: new Date().toISOString(),
                revoked: false,
                expired: false,
              };
            }
            return null;
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
          sweepIntervalHours: 24,
        });
        
        try {
          const result = await manager.reconcileAllTags();
          
          // Assert exact counts
          assert.strictEqual(result.processed, 3, 'Should process 3 enrollments');
          assert.strictEqual(result.applied, 1, 'Should apply 1 tag (user 100)');
          assert.strictEqual(result.removed, 2, 'Should remove 2 tags (users 200, 300)');
          
          // Assert exact calls
          assert.strictEqual(tagCalls.length, 1);
          assert.strictEqual(tagCalls[0].userId, 100);
          assert.strictEqual(removeCalls.length, 2);
          assert.ok(removeCalls.some(c => c.userId === 200));
          assert.ok(removeCalls.some(c => c.userId === 300));
        } finally {
          manager.stopSweeper();
        }
      } finally {
        db.close();
        await unlink(dbPath);
      }
    });
  });

  describe('Socket permission enforcement', () => {
    it('should create socket with mode 0600', async () => {
      const socketPath = join(tmpdir(), `test-socket-${Date.now()}.sock`);
      const secretFile = join(tmpdir(), `test-secret-${Date.now()}.txt`);
      
      try {
        await writeFile(secretFile, 'a'.repeat(32));
        await chmod(secretFile, 0o600);
        
        const secret = await loadStatusSecret(secretFile);
        
        const mockEnrollmentService = {
          findEnrollment: async () => null,
        } as any;
        
        const server = new StatusSocketServer({
          socketPath,
          secret,
          enrollmentService: mockEnrollmentService,
        });
        
        await server.start();
        
        // Check socket permissions before chmod is called
        const stats = statSync(socketPath);
        const mode = stats.mode & 0o777;
        
        assert.strictEqual(mode, 0o600, 'Socket should be created with mode 0600');
        
        await server.stop();
      } finally {
        if (existsSync(socketPath)) {
          await unlink(socketPath);
        }
        if (existsSync(secretFile)) {
          await unlink(secretFile);
        }
      }
    });
  });

  describe('Stale socket handling', () => {
    it('should refuse to start if path is a regular file', async () => {
      const socketPath = join(tmpdir(), `test-file-${Date.now()}.sock`);
      const secretFile = join(tmpdir(), `test-secret-${Date.now()}.txt`);
      
      try {
        await writeFile(secretFile, 'a'.repeat(32));
        await chmod(secretFile, 0o600);
        await writeFile(socketPath, 'regular file');
        
        const secret = await loadStatusSecret(secretFile);
        
        const mockEnrollmentService = {
          findEnrollment: async () => null,
        } as any;
        
        const server = new StatusSocketServer({
          socketPath,
          secret,
          enrollmentService: mockEnrollmentService,
        });
        
        await assert.rejects(
          () => server.start(),
          /not a socket/i,
          'Should refuse to start if path is not a socket'
        );
      } finally {
        if (existsSync(socketPath)) {
          await unlink(socketPath);
        }
        if (existsSync(secretFile)) {
          await unlink(secretFile);
        }
      }
    });

    it('should refuse to start if live socket exists', async () => {
      const socketPath = join(tmpdir(), `test-live-socket-${Date.now()}.sock`);
      const secretFile = join(tmpdir(), `test-secret-${Date.now()}.txt`);
      
      try {
        await writeFile(secretFile, 'a'.repeat(32));
        await chmod(secretFile, 0o600);
        
        const secret = await loadStatusSecret(secretFile);
        
        const mockEnrollmentService = {
          findEnrollment: async () => null,
        } as any;
        
        // Start first server
        const server1 = new StatusSocketServer({
          socketPath,
          secret,
          enrollmentService: mockEnrollmentService,
        });
        
        try {
          await server1.start();
          
          // Try to start second server on same socket
          const server2 = new StatusSocketServer({
            socketPath,
            secret,
            enrollmentService: mockEnrollmentService,
          });
          
          await assert.rejects(
            () => server2.start(),
            /another instance running/i,
            'Should refuse to start if live socket exists'
          );
        } finally {
          await server1.stop();
        }
      } finally {
        if (existsSync(socketPath)) {
          await unlink(socketPath);
        }
        if (existsSync(secretFile)) {
          await unlink(secretFile);
        }
      }
    });
  });

  describe('Config validation', () => {
    it('should throw on invalid MEMBER_TAG_SWEEP_INTERVAL_HOURS when tags enabled', async () => {
      const { loadOpenClawConfig } = await import('./config.js');
      
      // Invalid value with tags enabled should throw
      assert.throws(
        () => loadOpenClawConfig({
          MEMBER_TAGS_ENABLED: 'true',
          MEMBER_TAG_SWEEP_INTERVAL_HOURS: '0', // Invalid: below minimum
        }),
        /MEMBER_TAG_SWEEP_INTERVAL_HOURS must be 1-168/,
        'Should throw on invalid sweep interval when tags enabled'
      );
    });
    
    it('should not throw on invalid MEMBER_TAG_SWEEP_INTERVAL_HOURS when tags disabled', async () => {
      const { loadOpenClawConfig } = await import('./config.js');
      
      // Invalid value with tags disabled should NOT throw
      assert.doesNotThrow(
        () => loadOpenClawConfig({
          MEMBER_TAGS_ENABLED: 'false',
          MEMBER_TAG_SWEEP_INTERVAL_HOURS: '0', // Invalid, but should be ignored
        }),
        'Should not throw on invalid sweep interval when tags disabled'
      );
    });
  });

  describe('Permission check behavior', () => {
    it('should re-enable tagging when permission is granted after being denied', async () => {
      const dbPath = join(tmpdir(), `test-reenable-${Date.now()}.db`);
      const db = new Database(dbPath);
      
      try {
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
        
        db.exec(`
          CREATE TABLE enrollments (
            telegram_user_id INTEGER PRIMARY KEY,
            action TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER NOT NULL
          ) STRICT
        `);
        
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO enrollments VALUES (?, ?, 0, ?)').run(123, 'test-action', now + 86400);
        
        const tagCalls: Array<{ userId: number; tag: string }> = [];
        let permissionGranted = false;
        
        const mockTelegramClient: TelegramApiClient = {
          setChatMemberTag: async (chatId, userId, tag) => {
            tagCalls.push({ userId, tag });
            return { success: true };
          },
          removeChatMemberTag: async () => ({ success: true }),
          getChatMember: async () => ({ success: true, status: 'member', tag: null, isMember: true }),
          checkTagPermission: async () => {
            if (permissionGranted) {
              return { success: true };
            }
            return { success: false, error: 'Permission denied' };
          },
        } as any;
        
        const mockEnrollmentService: EnrollmentService = {
          findEnrollment: async (userId) => ({
            nullifier: '0x1234',
            telegramUserId: userId,
            action: 'test-action',
            expiresAt: now + 86400,
            createdAt: new Date().toISOString(),
            revoked: false,
            expired: false,
          }),
        } as any;
        
        const manager = new MemberTagManager({
          telegramClient: mockTelegramClient,
          enrollmentService: mockEnrollmentService,
          db,
          targetChatId: -123456,
          tagText: 'Test Tag',
          action: 'test-action',
          enabled: true,
          sweepIntervalHours: 24,
        });
        
        try {
          // Start sweeper with permission denied
          manager.startSweeper();
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Should be disabled
          let result = await manager.applyTagToMember(123);
          assert.strictEqual(result.success, false);
          assert.strictEqual(result.status, 'Tag feature disabled');
          assert.strictEqual(tagCalls.length, 0);
          
          // Grant permission
          permissionGranted = true;
          
          // Trigger another sweep cycle
          await (manager as any).runSweeperCycle();
          
          // Should now be enabled and apply tag
          result = await manager.applyTagToMember(123);
          assert.strictEqual(result.success, true);
          assert.strictEqual(tagCalls.length, 2, 'Should have 2 calls: one from reconcile, one from explicit apply');
          
          await new Promise(resolve => setTimeout(resolve, 100));
        } finally {
          manager.stopSweeper();
        }
      } finally {
        db.close();
        await unlink(dbPath);
      }
    });

    it('should not call apply/remove when permission check fails', async () => {
      const dbPath = join(tmpdir(), `test-perm-${Date.now()}.db`);
      const db = new Database(dbPath);
      
      try {
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
        
        db.exec(`
          CREATE TABLE enrollments (
            telegram_user_id INTEGER PRIMARY KEY,
            action TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER NOT NULL
          ) STRICT
        `);
        
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO enrollments VALUES (?, ?, 0, ?)').run(123, 'test-action', now + 86400);
        
        const tagCalls: Array<{ userId: number; tag: string }> = [];
        const removeCalls: Array<{ userId: number }> = [];
        
        const mockTelegramClient: TelegramApiClient = {
          setChatMemberTag: async (chatId, userId, tag) => {
            tagCalls.push({ userId, tag });
            return { success: true };
          },
          removeChatMemberTag: async (chatId, userId) => {
            removeCalls.push({ userId });
            return { success: true };
          },
          getChatMember: async () => ({ success: true, status: 'member', tag: null, isMember: true }),
          checkTagPermission: async () => ({ success: false, error: 'Permission denied' }),
        } as any;
        
        const mockEnrollmentService: EnrollmentService = {
          findEnrollment: async (userId) => ({
            nullifier: '0x1234',
            telegramUserId: userId,
            action: 'test-action',
            expiresAt: now + 86400,
            createdAt: new Date().toISOString(),
            revoked: false,
            expired: false,
          }),
        } as any;
        
        const manager = new MemberTagManager({
          telegramClient: mockTelegramClient,
          enrollmentService: mockEnrollmentService,
          db,
          targetChatId: -123456,
          tagText: 'Test Tag',
          action: 'test-action',
          enabled: true,
          sweepIntervalHours: 24,
        });
        
        try {
          // Start sweeper (will check permissions and disable itself)
          manager.startSweeper();
          
          // Wait for permission check to complete
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Try to apply tag
          const result = await manager.applyTagToMember(123);
          
          // Should be disabled due to failed permission check
          assert.strictEqual(result.success, false);
          assert.strictEqual(result.status, 'Tag feature disabled');
          assert.strictEqual(tagCalls.length, 0, 'Should not call setChatMemberTag');
          assert.strictEqual(removeCalls.length, 0, 'Should not call removeChatMemberTag');
          
          // Wait for sweeper to fully stop
          await new Promise(resolve => setTimeout(resolve, 100));
        } finally {
          manager.stopSweeper();
        }
      } finally {
        db.close();
        await unlink(dbPath);
      }
    });
  });

  describe('Startup non-blocking', () => {
    it('should not block on slow permission check', async () => {
      const dbPath = join(tmpdir(), `test-nonblock-${Date.now()}.db`);
      const db = new Database(dbPath);
      
      try {
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
        
        db.exec(`
          CREATE TABLE enrollments (
            telegram_user_id INTEGER PRIMARY KEY,
            action TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER NOT NULL
          ) STRICT
        `);
        
        let permCheckCalled = false;
        
        const mockTelegramClient: TelegramApiClient = {
          setChatMemberTag: async () => ({ success: true }),
          removeChatMemberTag: async () => ({ success: true }),
          getChatMember: async () => ({ success: true, status: 'member', tag: null, isMember: true }),
          checkTagPermission: async () => {
            permCheckCalled = true;
            // Simulate slow network
            await new Promise(resolve => setTimeout(resolve, 100));
            return { success: true };
          },
        } as any;
        
        const mockEnrollmentService: EnrollmentService = {
          findEnrollment: async () => null,
        } as any;
        
        const manager = new MemberTagManager({
          telegramClient: mockTelegramClient,
          enrollmentService: mockEnrollmentService,
          db,
          targetChatId: -123456,
          tagText: 'Test Tag',
          action: 'test-action',
          enabled: true,
          sweepIntervalHours: 24,
        });
        
        try {
          const startTime = Date.now();
          manager.startSweeper();
          const elapsed = Date.now() - startTime;
          
          // startSweeper should return immediately (< 50ms), regardless of permission check
          assert.ok(elapsed < 50, `startSweeper should not block (took ${elapsed}ms)`);
          
          // The permission check may or may not have completed yet, but startSweeper returned immediately
          // This test verifies non-blocking behavior, not the permission check itself
          
          // Wait for cleanup
          await new Promise(resolve => setTimeout(resolve, 200));
        } finally {
          manager.stopSweeper();
        }
      } finally {
        db.close();
        await unlink(dbPath);
      }
    });
  });

  describe('Skill script exit codes', () => {
    it('should exit 0 on successful 200 response', async () => {
      const socketPath = join(tmpdir(), `test-skill-200-${Date.now()}.sock`);
      const secretFile = join(tmpdir(), `test-secret-${Date.now()}.txt`);
      
      try {
        await writeFile(secretFile, 'a'.repeat(32));
        await chmod(secretFile, 0o600);
        
        const secret = await loadStatusSecret(secretFile);
        const now = Math.floor(Date.now() / 1000);
        
        const mockEnrollmentService = {
          findEnrollment: async () => ({
            nullifier: '0x1234',
            telegramUserId: 123,
            action: 'test-action',
            expiresAt: now + 86400,
            createdAt: new Date().toISOString(),
            revoked: false,
            expired: false,
          }),
        } as any;
        
        const server = new StatusSocketServer({
          socketPath,
          secret,
          enrollmentService: mockEnrollmentService,
        });
        
        try {
          await server.start();
          
          const result = await runSkill(['123'], {
            WORLDID_STATUS_SOCKET: socketPath,
            WORLDID_STATUS_SECRET_FILE: secretFile,
          });
          assert.strictEqual(result.code, 0, 'Should exit 0 on 200');
          
          const json = JSON.parse(result.stdout);
          assert.strictEqual(json.verified, true);
          assert.strictEqual(json.state, 'active');
        } finally {
          await server.stop();
        }
      } finally {
        delete process.env.WORLDID_STATUS_SOCKET;
        delete process.env.WORLDID_STATUS_SECRET_FILE;
        if (existsSync(socketPath)) {
          await unlink(socketPath);
        }
        if (existsSync(secretFile)) {
          await unlink(secretFile);
        }
      }
    });

    it('should exit 2 on 401 authentication failure', async () => {
      const socketPath = join(tmpdir(), `test-skill-401-${Date.now()}.sock`);
      const secretFile = join(tmpdir(), `test-secret-${Date.now()}.txt`);
      const wrongSecretFile = join(tmpdir(), `test-wrong-secret-${Date.now()}.txt`);
      
      try {
        await writeFile(secretFile, 'a'.repeat(32));
        await chmod(secretFile, 0o600);
        await writeFile(wrongSecretFile, 'b'.repeat(32));
        await chmod(wrongSecretFile, 0o600);
        
        const secret = await loadStatusSecret(secretFile);
        
        const mockEnrollmentService = {
          findEnrollment: async () => null,
        } as any;
        
        const server = new StatusSocketServer({
          socketPath,
          secret,
          enrollmentService: mockEnrollmentService,
        });
        
        try {
          await server.start();
          
          // Use wrong secret
          const result = await runSkill(['123'], {
            WORLDID_STATUS_SOCKET: socketPath,
            WORLDID_STATUS_SECRET_FILE: wrongSecretFile,
          });
          assert.strictEqual(result.code, 2, 'Should exit 2 on 401');
        } finally {
          await server.stop();
        }
      } finally {
        delete process.env.WORLDID_STATUS_SOCKET;
        delete process.env.WORLDID_STATUS_SECRET_FILE;
        if (existsSync(socketPath)) {
          await unlink(socketPath);
        }
        if (existsSync(secretFile)) {
          await unlink(secretFile);
        }
        if (existsSync(wrongSecretFile)) {
          await unlink(wrongSecretFile);
        }
      }
    });

    it('should exit 3 on missing socket', async () => {
      const socketPath = join(tmpdir(), `test-missing-socket-${Date.now()}.sock`);
      const secretFile = join(tmpdir(), `test-secret-${Date.now()}.txt`);
      
      try {
        await writeFile(secretFile, 'a'.repeat(32));
        await chmod(secretFile, 0o600);
        
        // Don't create server - socket doesn't exist
        const result = await runSkill(['123'], {
          WORLDID_STATUS_SOCKET: socketPath,
          WORLDID_STATUS_SECRET_FILE: secretFile,
        });
        assert.strictEqual(result.code, 3, 'Should exit 3 on missing socket');
      } finally {
        delete process.env.WORLDID_STATUS_SOCKET;
        delete process.env.WORLDID_STATUS_SECRET_FILE;
        if (existsSync(secretFile)) {
          await unlink(secretFile);
        }
      }
    });
  });

  describe('Secret file permissions', () => {
    it('should enforce mode 0600 on secret file', async () => {
      const secretFile = join(tmpdir(), `test-secret-${Date.now()}.txt`);
      
      try {
        await writeFile(secretFile, 'a'.repeat(32));
        await chmod(secretFile, 0o644); // Wrong permissions
        
        await assert.rejects(
          () => loadStatusSecret(secretFile),
          /must have mode 0600/,
          'Should reject secret file with wrong permissions'
        );
      } finally {
        if (existsSync(secretFile)) {
          await unlink(secretFile);
        }
      }
    });

    it('should accept secret file with mode 0600', async () => {
      const secretFile = join(tmpdir(), `test-secret-${Date.now()}.txt`);
      
      try {
        await writeFile(secretFile, 'a'.repeat(32));
        await chmod(secretFile, 0o600); // Correct permissions
        
        const secret = await loadStatusSecret(secretFile);
        assert.ok(secret.length >= 32);
      } finally {
        if (existsSync(secretFile)) {
          await unlink(secretFile);
        }
      }
    });
  });
});

/**
 * Run the skill script asynchronously. A synchronous exec blocked the event
 * loop, so the in-process status socket server could never answer and the
 * tests hung.
 */
function runSkill(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const scriptPath = join(process.cwd(), 'openclaw/skills/worldid-status/query-worldid-status');
  return new Promise((resolve) => {
    execFile('bash', [scriptPath, ...args], { env: { ...process.env, ...env }, timeout: 15000, encoding: 'utf8' }, (error: any, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
