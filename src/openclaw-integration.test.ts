/**
 * OpenClaw integration tests
 * 
 * Tests the full path from HTTP webhook to CLI dispatch to Telegram response.
 * Uses local fixtures, mock Telegram transport, and fake CLI executable.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import type { Server } from 'node:http';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { TelegramBotHandler } from './telegram-bot-handler.js';
import type { TelegramBotTransport } from './telegram-bot-handler.js';
import { mkdir, writeFile, unlink, chmod, readFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Mock Telegram transport for testing
 */
class MockTelegramTransport implements TelegramBotTransport {
  public sentMessages: Array<{ chatId: number; text: string; options?: any }> = [];

  async sendMessage(chatId: number, text: string, options?: any): Promise<void> {
    this.sentMessages.push({ chatId, text, options });
  }

  reset(): void {
    this.sentMessages = [];
  }

  getLastMessage(): { chatId: number; text: string; options?: any } | undefined {
    return this.sentMessages[this.sentMessages.length - 1];
  }
}

/**
 * Stub World ID verifier for testing
 */
class StubVerifier {
  async verify(idkitResult: any, expectedContext: any): Promise<any> {
    return {
      success: true,
      credential_type: 'proof_of_human',
      nullifier: 'test_nullifier_' + randomBytes(16).toString('hex'),
    };
  }
}

describe('OpenClaw Integration', () => {
  let dbPath: string;
  let enrollmentService: EnrollmentService;
  let challengeAdapter: WorldIdChallengeAdapter;
  let mockTransport: MockTelegramTransport;
  let botHandler: TelegramBotHandler;
  let testServer: Server;
  let testPort: number;
  let fakeCliPath: string;

  before(async () => {
    // Create temporary database
    dbPath = join(tmpdir(), `test-openclaw-${randomBytes(8).toString('hex')}.db`);

    // Create challenge adapter
    challengeAdapter = new WorldIdChallengeAdapter({
      appId: 'app_test' as `app_${string}`,
      rpId: 'rp_test' as `rp_${string}`,
      signingKeyHex: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      challengeTtlSeconds: 300,
      environment: 'staging',
    });

    // Create enrollment service
    enrollmentService = new EnrollmentService({
      dbPath,
      challengeAdapter,
      verificationClient: new StubVerifier() as any,
      telegramBotToken: 'test_bot_token',
      action: 'openclaw-test-action',
      challengeTtlSeconds: 300,
      enrollmentTtlSeconds: 2592000,
    });

    // Create fake CLI executable that returns actual OpenClaw JSON schema
    // Schema from fc23bc864e4553c2d215e479eeec47b67a0bf943:
    // src/commands/agent-via-gateway.ts:81-96
    fakeCliPath = join(tmpdir(), `fake-openclaw-${randomBytes(8).toString('hex')}.sh`);
    await writeFile(
      fakeCliPath,
      '#!/bin/bash\necho \'{"status":"ok","result":{"payloads":[{"text":"Hello from OpenClaw"}]}}\'\nexit 0\n',
      { mode: 0o755 }
    );
    await chmod(fakeCliPath, 0o755);

    // Create mock transport
    mockTransport = new MockTelegramTransport();

    // Create bot handler with OpenClaw config
    botHandler = new TelegramBotHandler({
      botToken: 'test_bot_token',
      enrollmentService,
      transport: mockTransport,
      enrollmentBaseUrl: 'http://localhost:3000',
      webhookSecret: 'test_webhook_secret',
      openclawConfig: {
        openclawBin: fakeCliPath,
        agentId: 'test-agent',
        telegramAccountId: 'test-account',
        timeoutSeconds: 5,
        maxOutputBytes: 1024 * 1024,
      },
      allowedGroupId: -1001234567890,
    });

    // Create test HTTP server
    const app = express();
    app.post('/telegram/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
      const rawBody = req.body?.toString('utf-8') || '';
      const secretToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;

      if (!botHandler.validateWebhook(rawBody, secretToken)) {
        res.status(403).json({ error: 'Invalid webhook request' });
        return;
      }

      try {
        const update = JSON.parse(rawBody);
        await botHandler.handleUpdate(update);
        res.status(200).json({ ok: true });
      } catch {
        res.status(400).json({ error: 'Invalid JSON' });
      }
    });

    testServer = app.listen(0);
    const address = testServer.address();
    testPort = typeof address === 'object' && address ? address.port : 0;
  });

  after(async () => {
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
    enrollmentService.close();
    await unlink(dbPath).catch(() => {});
    await unlink(fakeCliPath).catch(() => {});
  });

  describe('Webhook authentication', () => {
    test('rejects webhook without secret header', async () => {
      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 12345, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 403);
      const data = await response.json() as any;
      assert.strictEqual(data.error, 'Invalid webhook request');
      assert.strictEqual(mockTransport.sentMessages.length, 0);
    });

    test('rejects webhook with wrong secret', async () => {
      const update = {
        update_id: 2,
        message: {
          message_id: 2,
          from: { id: 12345, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret',
        },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 403);
      assert.strictEqual(mockTransport.sentMessages.length, 0);
    });

    test('accepts webhook with correct secret', async () => {
      const update = {
        update_id: 3,
        message: {
          message_id: 3,
          from: { id: 12345, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: 'hello',
        },
      };

      mockTransport.reset();
      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 200);
      const data = await response.json() as any;
      assert.strictEqual(data.ok, true);
    });
  });

  describe('Group filtering', () => {
    test('ignores messages in unauthorized group', async () => {
      const update = {
        update_id: 4,
        message: {
          message_id: 4,
          from: { id: 12345, is_bot: false, first_name: 'Test' },
          chat: { id: -1009876543210, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();
      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 200);
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Should send error message
      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.ok(mockTransport.sentMessages[0].text.includes('private chat'));
    });

    test('processes messages in allowed group', async () => {
      // First, enroll the user
      await enrollmentService.directEnroll({
        telegramUserId: 12345,
        nullifier: 'test_nullifier_12345',
        credential: { credential_type: 'proof_of_human' } as any,
      });

      const update = {
        update_id: 5,
        message: {
          message_id: 5,
          from: { id: 12345, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask test question',
        },
      };

      mockTransport.reset();
      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 200);
      
      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Should dispatch and respond
      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.strictEqual(mockTransport.sentMessages[0].chatId, -1001234567890);
      assert.strictEqual(mockTransport.sentMessages[0].text, 'Hello from OpenClaw');
    });
  });

  describe('Sender validation', () => {
    test('rejects bot sender', async () => {
      const update = {
        update_id: 6,
        message: {
          message_id: 6,
          from: { id: 99999, is_bot: true, first_name: 'Bot' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();
      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 200);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.strictEqual(mockTransport.sentMessages.length, 0);
    });
  });

  describe('Enrollment gating', () => {
    test('rejects unenrolled user', async () => {
      const update = {
        update_id: 7,
        message: {
          message_id: 7,
          from: { id: 99998, is_bot: false, first_name: 'Unenrolled' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();
      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 200);
      await new Promise(resolve => setTimeout(resolve, 100));
      
      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.ok(mockTransport.sentMessages[0].text.includes('verification required'));
    });

    test('rejects revoked enrollment', async () => {
      // Enroll and revoke
      await enrollmentService.directEnroll({
        telegramUserId: 88888,
        nullifier: 'test_nullifier_88888',
        credential: { credential_type: 'proof_of_human' } as any,
      });
      await enrollmentService.revokeEnrollment(88888);

      const update = {
        update_id: 8,
        message: {
          message_id: 8,
          from: { id: 88888, is_bot: false, first_name: 'Revoked' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();
      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 200);
      await new Promise(resolve => setTimeout(resolve, 100));
      
      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.ok(mockTransport.sentMessages[0].text.includes('revoked'));
    });

    test('accepts valid enrollment', async () => {
      // Enroll user
      await enrollmentService.directEnroll({
        telegramUserId: 77777,
        nullifier: 'test_nullifier_77777',
        credential: { credential_type: 'proof_of_human' } as any,
      });

      const update = {
        update_id: 9,
        message: {
          message_id: 9,
          from: { id: 77777, is_bot: false, first_name: 'Enrolled' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask test',
        },
      };

      mockTransport.reset();
      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 200);
      await new Promise(resolve => setTimeout(resolve, 200));
      
      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.strictEqual(mockTransport.sentMessages[0].chatId, -1001234567890);
      assert.strictEqual(mockTransport.sentMessages[0].text, 'Hello from OpenClaw');
    });
  });

  describe('Duplicate suppression', () => {
    test('suppresses duplicate update_id within window', async () => {
      await enrollmentService.directEnroll({
        telegramUserId: 66666,
        nullifier: 'test_nullifier_66666',
        credential: { credential_type: 'proof_of_human' } as any,
      });

      const update = {
        update_id: 10,
        message: {
          message_id: 10,
          from: { id: 66666, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();

      // First request
      await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      await new Promise(resolve => setTimeout(resolve, 200));
      assert.strictEqual(mockTransport.sentMessages.length, 1);

      // Second request with same update_id
      mockTransport.reset();
      await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      await new Promise(resolve => setTimeout(resolve, 200));
      assert.strictEqual(mockTransport.sentMessages.length, 0);
    });

    test('prevents concurrent duplicate invocations', async () => {
      // Create CLI with counter to track invocations
      const counterFile = join(tmpdir(), `counter-${randomBytes(8).toString('hex')}.txt`);
      await writeFile(counterFile, '0', 'utf8');

      const counterCliPath = join(tmpdir(), `counter-openclaw-${randomBytes(8).toString('hex')}.sh`);
      await writeFile(
        counterCliPath,
        `#!/bin/bash
count=$(cat ${counterFile})
count=$((count + 1))
echo $count > ${counterFile}
sleep 0.1
echo '{"status":"ok","result":{"payloads":[{"text":"Response $count"}]}}'
exit 0
`,
        { mode: 0o755 }
      );
      await chmod(counterCliPath, 0o755);

      const counterBotHandler = new TelegramBotHandler({
        botToken: 'test_bot_token',
        enrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'http://localhost:3000',
        webhookSecret: 'test_webhook_secret',
        openclawConfig: {
          openclawBin: counterCliPath,
          agentId: 'test-agent',
          telegramAccountId: 'test-account',
          timeoutSeconds: 5,
          maxOutputBytes: 1024 * 1024,
        },
        allowedGroupId: -1001234567890,
      });

      // Create test server with counter handler
      const counterApp = express();
      counterApp.post('/telegram/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
        const rawBody = req.body?.toString('utf-8') || '';
        const secretToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;

        if (!counterBotHandler.validateWebhook(rawBody, secretToken)) {
          res.status(403).json({ error: 'Invalid webhook request' });
          return;
        }

        try {
          const update = JSON.parse(rawBody);
          await counterBotHandler.handleUpdate(update);
          res.status(200).json({ ok: true });
        } catch {
          res.status(400).json({ error: 'Invalid JSON' });
        }
      });

      const counterServer = counterApp.listen(0);
      const counterAddress = counterServer.address();
      const counterPort = typeof counterAddress === 'object' && counterAddress ? counterAddress.port : 0;

      try {
        await enrollmentService.directEnroll({
          telegramUserId: 99999,
          nullifier: 'test_nullifier_99999',
          credential: { credential_type: 'proof_of_human' } as any,
        });

        const update = {
          update_id: 999,
          message: {
            message_id: 999,
            from: { id: 99999, is_bot: false, first_name: 'Test' },
            chat: { id: -1001234567890, type: 'group' as const },
            date: Math.floor(Date.now() / 1000),
            text: '/ask concurrent test',
          },
        };

        mockTransport.reset();

        // Send two concurrent requests
        const [response1, response2] = await Promise.all([
          fetch(`http://localhost:${counterPort}/telegram/webhook`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
            },
            body: JSON.stringify(update),
          }),
          fetch(`http://localhost:${counterPort}/telegram/webhook`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
            },
            body: JSON.stringify(update),
          }),
        ]);

        assert.strictEqual(response1.status, 200);
        assert.strictEqual(response2.status, 200);

        // Wait for async processing
        await new Promise(resolve => setTimeout(resolve, 300));

        // Read counter file
        const finalCount = parseInt(await fs.readFile(counterFile, 'utf8'), 10);

        // Assert CLI was invoked exactly once despite concurrent requests
        assert.strictEqual(finalCount, 1, 'CLI should be invoked exactly once for concurrent duplicate requests');

        // Should have exactly one response
        assert.strictEqual(mockTransport.sentMessages.length, 1);

      } finally {
        await new Promise<void>((resolve) => counterServer.close(() => resolve()));
        await unlink(counterFile).catch(() => {});
        await unlink(counterCliPath).catch(() => {});
      }
    });
  });

  describe('CLI error handling', () => {
    test('handles missing CLI binary', async () => {
      const missingBotHandler = new TelegramBotHandler({
        botToken: 'test_bot_token',
        enrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'http://localhost:3000',
        webhookSecret: 'test_webhook_secret',
        openclawConfig: {
          openclawBin: '/nonexistent/openclaw',
          agentId: 'test-agent',
          telegramAccountId: 'test-account',
          timeoutSeconds: 5,
          maxOutputBytes: 1024 * 1024,
        },
        allowedGroupId: -1001234567890,
      });

      await enrollmentService.directEnroll({
        telegramUserId: 11111,
        nullifier: 'test_nullifier_11111',
        credential: { credential_type: 'proof_of_human' } as any,
      });

      const update = {
        update_id: 111,
        message: {
          message_id: 111,
          from: { id: 11111, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();
      await missingBotHandler.handleUpdate(update);
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.ok(mockTransport.sentMessages[0].text.includes('failed'));
    });

    test('handles CLI timeout', async () => {
      // Create slow CLI that exceeds timeout
      const slowCliPath = join(tmpdir(), `slow-openclaw-${randomBytes(8).toString('hex')}.sh`);
      await writeFile(
        slowCliPath,
        '#!/bin/bash\nsleep 10\necho \'{"text":"Too slow"}\'\nexit 0\n',
        { mode: 0o755 }
      );
      await chmod(slowCliPath, 0o755);

      const slowBotHandler = new TelegramBotHandler({
        botToken: 'test_bot_token',
        enrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'http://localhost:3000',
        webhookSecret: 'test_webhook_secret',
        openclawConfig: {
          openclawBin: slowCliPath,
          agentId: 'test-agent',
          telegramAccountId: 'test-account',
          timeoutSeconds: 1,
          maxOutputBytes: 1024 * 1024,
        },
        allowedGroupId: -1001234567890,
      });

      await enrollmentService.directEnroll({
        telegramUserId: 55555,
        nullifier: 'test_nullifier_55555',
        credential: { credential_type: 'proof_of_human' } as any,
      });

      const update = {
        update_id: 11,
        message: {
          message_id: 11,
          from: { id: 55555, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();
      await slowBotHandler.handleUpdate(update);
      await new Promise(resolve => setTimeout(resolve, 2000));

      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.ok(mockTransport.sentMessages[0].text.includes('timed out'));

      await unlink(slowCliPath).catch(() => {});
    });

    test('handles CLI non-zero exit', async () => {
      const errorCliPath = join(tmpdir(), `error-openclaw-${randomBytes(8).toString('hex')}.sh`);
      await writeFile(
        errorCliPath,
        '#!/bin/bash\necho \'error message\' >&2\nexit 1\n',
        { mode: 0o755 }
      );
      await chmod(errorCliPath, 0o755);

      const errorBotHandler = new TelegramBotHandler({
        botToken: 'test_bot_token',
        enrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'http://localhost:3000',
        webhookSecret: 'test_webhook_secret',
        openclawConfig: {
          openclawBin: errorCliPath,
          agentId: 'test-agent',
          telegramAccountId: 'test-account',
          timeoutSeconds: 5,
          maxOutputBytes: 1024 * 1024,
        },
        allowedGroupId: -1001234567890,
      });

      await enrollmentService.directEnroll({
        telegramUserId: 44444,
        nullifier: 'test_nullifier_44444',
        credential: { credential_type: 'proof_of_human' } as any,
      });

      const update = {
        update_id: 12,
        message: {
          message_id: 12,
          from: { id: 44444, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();
      await errorBotHandler.handleUpdate(update);
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.ok(mockTransport.sentMessages[0].text.includes('failed'));

      await unlink(errorCliPath).catch(() => {});
    });

    test('handles invalid JSON response (fail closed)', async () => {
      const invalidJsonCliPath = join(tmpdir(), `invalid-json-openclaw-${randomBytes(8).toString('hex')}.sh`);
      await writeFile(
        invalidJsonCliPath,
        '#!/bin/bash\necho \'not valid json\'\nexit 0\n',
        { mode: 0o755 }
      );
      await chmod(invalidJsonCliPath, 0o755);

      const invalidJsonBotHandler = new TelegramBotHandler({
        botToken: 'test_bot_token',
        enrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'http://localhost:3000',
        webhookSecret: 'test_webhook_secret',
        openclawConfig: {
          openclawBin: invalidJsonCliPath,
          agentId: 'test-agent',
          telegramAccountId: 'test-account',
          timeoutSeconds: 5,
          maxOutputBytes: 1024 * 1024,
        },
        allowedGroupId: -1001234567890,
      });

      await enrollmentService.directEnroll({
        telegramUserId: 22222,
        nullifier: 'test_nullifier_22222',
        credential: { credential_type: 'proof_of_human' } as any,
      });

      const update = {
        update_id: 222,
        message: {
          message_id: 222,
          from: { id: 22222, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();
      await invalidJsonBotHandler.handleUpdate(update);
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.ok(mockTransport.sentMessages[0].text.includes('failed'));

      await unlink(invalidJsonCliPath).catch(() => {});
    });

    test('handles missing result.payloads (fail closed)', async () => {
      const missingPayloadsCliPath = join(tmpdir(), `missing-payloads-openclaw-${randomBytes(8).toString('hex')}.sh`);
      await writeFile(
        missingPayloadsCliPath,
        '#!/bin/bash\necho \'{"status":"ok","result":{}}\'\nexit 0\n',
        { mode: 0o755 }
      );
      await chmod(missingPayloadsCliPath, 0o755);

      const missingPayloadsBotHandler = new TelegramBotHandler({
        botToken: 'test_bot_token',
        enrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'http://localhost:3000',
        webhookSecret: 'test_webhook_secret',
        openclawConfig: {
          openclawBin: missingPayloadsCliPath,
          agentId: 'test-agent',
          telegramAccountId: 'test-account',
          timeoutSeconds: 5,
          maxOutputBytes: 1024 * 1024,
        },
        allowedGroupId: -1001234567890,
      });

      await enrollmentService.directEnroll({
        telegramUserId: 33334,
        nullifier: 'test_nullifier_33334',
        credential: { credential_type: 'proof_of_human' } as any,
      });

      const update = {
        update_id: 333,
        message: {
          message_id: 333,
          from: { id: 33334, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask hello',
        },
      };

      mockTransport.reset();
      await missingPayloadsBotHandler.handleUpdate(update);
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.ok(mockTransport.sentMessages[0].text.includes('failed'));

      await unlink(missingPayloadsCliPath).catch(() => {});
    });
  });

  describe('Response delivery', () => {
    test('delivers CLI response to same chat', async () => {
      await enrollmentService.directEnroll({
        telegramUserId: 33333,
        nullifier: 'test_nullifier_33333',
        credential: { credential_type: 'proof_of_human' } as any,
      });

      const update = {
        update_id: 13,
        message: {
          message_id: 13,
          from: { id: 33333, is_bot: false, first_name: 'Test' },
          chat: { id: -1001234567890, type: 'group' as const },
          date: Math.floor(Date.now() / 1000),
          text: '/ask my question',
        },
      };

      mockTransport.reset();
      const response = await fetch(`http://localhost:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'test_webhook_secret',
        },
        body: JSON.stringify(update),
      });

      assert.strictEqual(response.status, 200);
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(mockTransport.sentMessages.length, 1);
      assert.strictEqual(mockTransport.sentMessages[0].chatId, -1001234567890);
      assert.strictEqual(mockTransport.sentMessages[0].text, 'Hello from OpenClaw');
    });
  });
});
