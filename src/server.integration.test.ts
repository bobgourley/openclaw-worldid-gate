/**
 * Production server integration tests.
 * 
 * Tests the actual composed server artifact with:
 * - Real HTTP routes for UI, sessions, webhooks
 * - Ephemeral localhost binding
 * - Throwaway test configuration
 * - Fake remote transport (no live Telegram API calls)
 * - Security boundary validation (secrets, auth, CORS)
 * 
 * TERMINOLOGY:
 * - Telegram webhook secret: X-Telegram-Bot-Api-Secret-Token header (shared secret)
 * - Telegram initData HMAC: HMAC-SHA256 signature in initData string (validates user identity)
 * These are separate security mechanisms - webhook uses shared secret header,
 * initData validation uses HMAC computed from bot token.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import { HttpService } from './http-service.js';
import { TelegramBotHandler, type TelegramBotTransport } from './telegram-bot-handler.js';

// Test configuration (throwaway keys)
const TEST_CONFIG = {
  worldIdAppId: 'app_test1234567890abcdef' as `app_${string}`,
  worldIdRpId: 'rp_test1234567890ab' as `rp_${string}`,
  worldIdSigningKey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  worldIdEnvironment: 'staging' as const,
  telegramBotToken: 'test_bot_token_12345',
  telegramWebhookSecret: 'test_webhook_secret_67890',
  enrollmentBaseUrl: 'http://127.0.0.1',
  action: 'test-integration',
  httpHost: '127.0.0.1',
};

// Mock transport (no live Telegram API calls)
class MockTelegramTransport implements TelegramBotTransport {
  sentMessages: Array<{ chatId: number; text: string; options?: any }> = [];

  async sendMessage(chatId: number, text: string, options?: any): Promise<void> {
    this.sentMessages.push({ chatId, text, options });
  }

  reset() {
    this.sentMessages = [];
  }
}

// Mock verifier (no live World ID API calls)
class MockVerifier {
  shouldSucceed = true;
  
  async verify() {
    if (!this.shouldSucceed) {
      throw new Error('Verification failed');
    }
    return {
      success: true,
      nullifier: '12345678901234567890',
      issuerSchemaId: 1,
      expiresAtMin: Math.floor(Date.now() / 1000) + 86400,
    };
  }
}

describe('Production server integration', () => {
  let httpService: HttpService;
  let enrollmentService: EnrollmentService;
  let mockTransport: MockTelegramTransport;
  let testPort: number;
  let testDbPath: string;

  beforeEach(async () => {
    // Use random port for each test
    testPort = 13000 + Math.floor(Math.random() * 1000);
    testDbPath = `/tmp/test-enrollment-${Date.now()}-${Math.random()}.db`;

    // Create services with throwaway config
    const challengeAdapter = new WorldIdChallengeAdapter({
      appId: TEST_CONFIG.worldIdAppId,
      rpId: TEST_CONFIG.worldIdRpId,
      signingKeyHex: TEST_CONFIG.worldIdSigningKey,
      challengeTtlSeconds: 300,
      environment: TEST_CONFIG.worldIdEnvironment,
    });

    const verifier = new MockVerifier();

    enrollmentService = new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter,
      verificationClient: verifier as any,
      telegramBotToken: TEST_CONFIG.telegramBotToken,
      action: TEST_CONFIG.action,
      challengeTtlSeconds: 300,
      enrollmentTtlSeconds: 2592000,
    });

    mockTransport = new MockTelegramTransport();
    const telegramBotHandler = new TelegramBotHandler({
      botToken: TEST_CONFIG.telegramBotToken,
      enrollmentService,
      transport: mockTransport,
      enrollmentBaseUrl: `${TEST_CONFIG.enrollmentBaseUrl}:${testPort}`,
      webhookSecret: TEST_CONFIG.telegramWebhookSecret,
    });

    httpService = new HttpService({
      enrollmentService,
      telegramBotHandler,
      port: testPort,
      host: TEST_CONFIG.httpHost,
    });

    await httpService.start();
  });

  afterEach(async () => {
    await httpService.stop();
    enrollmentService.close();
    try {
      unlinkSync(testDbPath);
    } catch {}
  });

  describe('UI routes', () => {
    test('GET /enrollment returns 200 with HTML', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/enrollment`);
      
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /text\/html/);
      
      const html = await response.text();
      assert.ok(html.includes('<!DOCTYPE html>'), 'Should be valid HTML');
      assert.ok(html.includes('World ID Verification'), 'Should have title');
    });

    test('GET /enrollment serves no secrets in HTML', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/enrollment`);
      const html = await response.text();
      
      // Verify no secrets leaked
      assert.ok(!html.includes('bot_token'), 'Should not contain bot_token');
      assert.ok(!html.includes(TEST_CONFIG.telegramBotToken), 'Should not contain actual token');
      assert.ok(!html.includes(TEST_CONFIG.telegramWebhookSecret), 'Should not contain webhook secret');
      assert.ok(!html.includes(TEST_CONFIG.worldIdSigningKey), 'Should not contain signing key');
    });

    test('GET /enrollment loads Telegram SDK and checks availability', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/enrollment`);
      const html = await response.text();
      
      // Verify Telegram SDK is loaded
      assert.ok(
        html.includes('telegram-web-app.js'),
        'Should load Telegram WebApp SDK'
      );
      
      // Extract all script content (main script does not have type="module")
      const scriptMatches = html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g);
      let foundTelegramCheck = false;
      
      for (const match of scriptMatches) {
        const script = match[1];
        if (/typeof\s+window\.Telegram/.test(script) ||
            /window\.Telegram\s*===\s*['"]undefined['"]/.test(script) ||
            /!window\.Telegram/.test(script)) {
          foundTelegramCheck = true;
          break;
        }
      }
      
      assert.ok(foundTelegramCheck, 'Should explicitly check window.Telegram availability');
    });
  });

  describe('Session API routes', () => {
    test('GET /api/enrollment/session/:sessionId with invalid format returns 404', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/enrollment/session/invalid!@#`);
      
      // Invalid session ID format returns 404 (session not found)
      assert.equal(response.status, 404);
      const data = await response.json();
      assert.ok(data.error);
    });

    test('GET /api/enrollment/session/:sessionId with non-existent session returns 404', async () => {
      const validSessionId = 'a'.repeat(32);
      const response = await fetch(`http://127.0.0.1:${testPort}/api/enrollment/session/${validSessionId}`);
      
      assert.equal(response.status, 404);
      const data = await response.json();
      assert.ok(data.error);
    });

    test('Session info route does not leak identity without proper auth', async () => {
      // Even with a valid-format session ID, should not expose user identity
      const validSessionId = 'b'.repeat(32);
      const response = await fetch(`http://127.0.0.1:${testPort}/api/enrollment/session/${validSessionId}`);
      
      // Should fail (404 or 403), not expose user ID
      assert.ok(response.status >= 400, 'Should deny access');
      const text = await response.text();
      assert.ok(!text.includes('userId'), 'Should not leak user ID');
      assert.ok(!text.includes('telegramUserId'), 'Should not leak Telegram user ID');
    });
  });

  describe('Webhook route security', () => {
    test('POST /telegram/webhook with missing secret returns 403', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ update_id: 1, message: {} }),
      });
      
      assert.equal(response.status, 403);
      const data = await response.json();
      assert.ok(data.error);
    });

    test('POST /telegram/webhook with wrong secret returns 403', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret',
        },
        body: JSON.stringify({ update_id: 1, message: {} }),
      });
      
      assert.equal(response.status, 403);
      const data = await response.json();
      assert.ok(data.error);
    });

    test('POST /telegram/webhook with correct secret accepts update', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': TEST_CONFIG.telegramWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 1,
          message: {
            message_id: 1,
            from: { id: 123, is_bot: false, first_name: 'Test' },
            chat: { id: 123, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: '/help',
          },
        }),
      });
      
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.ok, true);
    });

    test('Webhook processes before handler is called (secret gate first)', async () => {
      // This test verifies the security boundary: secret validation happens
      // before any handler logic or side effects
      
      const badResponse = await fetch(`http://127.0.0.1:${testPort}/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // No secret header
        },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: 2,
            from: { id: 456, is_bot: false, first_name: 'Hacker' },
            chat: { id: 456, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: '/verify',
          },
        }),
      });
      
      assert.equal(badResponse.status, 403);
      
      // Verify no message was sent (handler was never called)
      assert.equal(mockTransport.sentMessages.length, 0, 'Handler should not process unauthenticated webhooks');
    });
  });

  describe('Completion route security', () => {
    test('POST /api/enrollment/complete requires initData', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/enrollment/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idkitResult: {
            protocol_version: '4.0',
            nonce: '0x' + '1'.repeat(64),
            action: TEST_CONFIG.action,
            responses: [],
            environment: 'staging',
          },
        }),
      });
      
      assert.equal(response.status, 400);
      const data = await response.json();
      assert.ok(data.error);
      assert.match(data.error, /initData/i);
    });

    test('POST /api/enrollment/complete cross-account denial (valid HMAC, wrong user)', async () => {
      // Generate valid initData HMAC for user 111
      const authDate111 = Math.floor(Date.now() / 1000);
      const user111 = JSON.stringify({ id: 111, first_name: 'User111' });
      const dataCheckString111 = `auth_date=${authDate111}\nuser=${user111}`;
      const secretKey111 = createHmac('sha256', 'WebAppData').update(TEST_CONFIG.telegramBotToken).digest();
      const hash111 = createHmac('sha256', secretKey111).update(dataCheckString111).digest('hex');
      const initData111 = `user=${encodeURIComponent(user111)}&auth_date=${authDate111}&hash=${hash111}`;
      
      // Create challenge for user 111
      const challengeResult = await enrollmentService.createChallenge(initData111);
      
      // Generate valid initData HMAC for user 222 (different account)
      const authDate222 = Math.floor(Date.now() / 1000);
      const user222 = JSON.stringify({ id: 222, first_name: 'User222' });
      const dataCheckString222 = `auth_date=${authDate222}\nuser=${user222}`;
      const secretKey222 = createHmac('sha256', 'WebAppData').update(TEST_CONFIG.telegramBotToken).digest();
      const hash222 = createHmac('sha256', secretKey222).update(dataCheckString222).digest('hex');
      const initData222 = `user=${encodeURIComponent(user222)}&auth_date=${authDate222}&hash=${hash222}`;
      
      // Attempt to complete user 111's session with user 222's valid initData
      const response = await fetch(`http://127.0.0.1:${testPort}/api/enrollment/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          initData: initData222,
          idkitResult: {
            protocol_version: '4.0',
            nonce: challengeResult.signedChallenge.nonce,
            action: TEST_CONFIG.action,
            responses: [{
              identifier: 'proof_of_human',
              proof: ['1', '2', '3', '4', '5'],
              nullifier: '12345',
              issuer_schema_id: 1,
              expires_at_min: Math.floor(Date.now() / 1000) + 86400,
            }],
            environment: 'staging',
          },
        }),
      });
      
      // Should fail with account mismatch (both HMACs valid, but different users)
      assert.ok(response.status >= 400, 'Should deny cross-account completion');
      const data = await response.json();
      assert.ok(data.error, 'Should return error message');
    });

    test('POST /api/enrollment/complete with invalid HMAC denies', async () => {
      // Attempt completion with fabricated initData (invalid HMAC signature)
      const authDate = Math.floor(Date.now() / 1000);
      const fakeHash = 'a'.repeat(64);
      const invalidInitData = `user=%7B%22id%22%3A999%7D&auth_date=${authDate}&hash=${fakeHash}`;
      
      const response = await fetch(`http://127.0.0.1:${testPort}/api/enrollment/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          initData: invalidInitData,
          idkitResult: {
            protocol_version: '4.0',
            nonce: '0x' + '1'.repeat(64),
            action: TEST_CONFIG.action,
            responses: [{
              identifier: 'proof_of_human',
              proof: ['1', '2', '3', '4', '5'],
              nullifier: '12345',
              issuer_schema_id: 1,
              expires_at_min: Math.floor(Date.now() / 1000) + 86400,
            }],
            environment: 'staging',
          },
        }),
      });
      
      // Should fail with authentication error (invalid Telegram initData HMAC)
      assert.equal(response.status, 401, 'Should deny invalid initData HMAC');
      const data = await response.json();
      assert.ok(data.error, 'Should return error message');
    });
  });

  describe('Privacy statement verification', () => {
    test('UI correctly states "Our service receives no raw biometric data"', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/enrollment`);
      const html = await response.text();
      
      // Should say "Our service" not make universal claims
      assert.ok(
        html.includes('Our service') && html.includes('no raw biometric data'),
        'Privacy statement must be scoped to our service'
      );
      
      // Should NOT claim proof never leaves device (it reaches our backend)
      assert.ok(
        !html.includes('never leaves your device'),
        'Should not falsely claim proof never leaves device'
      );
    });
  });

  describe('Health checks', () => {
    test('GET /health returns 200', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/health`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.status, 'healthy');
    });

    test('GET /ready returns 200', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/ready`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.status, 'ready');
    });
  });

  describe('404 handling', () => {
    test('Unknown routes return 404', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/nonexistent`);
      assert.equal(response.status, 404);
    });
  });
});
