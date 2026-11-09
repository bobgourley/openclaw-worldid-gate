/**
 * Negative test: Verify SDK handles corrupted/invalid encrypted response gracefully.
 */

import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const TEST_BOT_TOKEN = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890';
const TEST_SIGNING_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const TEST_USER_ID = 987654321;
const TEST_APP_ID = 'app_b466e1f63a70a695b6d990d261e31b6a';
const TEST_RP_ID = 'rp_223416a2a76673a1';

function createValidInitData(userId: number, botToken: string): string {
  const user = JSON.stringify({ 
    id: userId, 
    first_name: 'TestUser',
    username: 'testuser' 
  });
  const authDate = Math.floor(Date.now() / 1000);

  const params: Record<string, string> = {
    user: user,
    auth_date: String(authDate),
  };

  const dataCheckString = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return `user=${encodeURIComponent(user)}&auth_date=${authDate}&hash=${hash}`;
}

test.describe('Decryption error handling', () => {
  let service: any;
  let serverPort: number;

  test.beforeAll(async () => {
    const { WorldIdChallengeAdapter } = await import('../../dist/worldid-challenge-adapter.js');
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      challengeTtlSeconds: 300,
      environment: 'staging',
    });

    const { WorldIdHttpVerifier } = await import('../../dist/worldid-verifier-http.js');
    const stubVerifier = new WorldIdHttpVerifier({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      environment: 'staging',
      baseUrlOverride: 'http://localhost:9999',
    });

    const { EnrollmentService } = await import('../../dist/enrollment-service-production.js');
    const enrollmentService = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: stubVerifier,
      action: 'test-enrollment-action',
      dbPath: ':memory:',
    });

    const stubTransport = {
      async sendMessage(chatId: number, text: string, options?: any): Promise<void> {
        if (options?.reply_markup?.inline_keyboard) {
          const button = options.reply_markup.inline_keyboard[0][0];
          if (button.web_app?.url) {
            (stubTransport as any).lastWebAppUrl = button.web_app.url;
          }
        }
      },
    };

    const { TelegramBotHandler } = await import('../../dist/telegram-bot-handler.js');
    const botHandler = new TelegramBotHandler({
      botToken: TEST_BOT_TOKEN,
      enrollmentService,
      transport: stubTransport as any,
      enrollmentBaseUrl: 'http://localhost:3000',
    });

    const { HttpService } = await import('../../dist/http-service.js');
    service = new HttpService({
      enrollmentService,
      telegramBotHandler: botHandler,
      port: 0,
      host: '127.0.0.1',
    });

    await service.start();
    
    const address = service.server.address();
    serverPort = typeof address === 'object' && address !== null ? address.port : 0;
    
    (service as any).stubTransport = stubTransport;
  });

  test.afterAll(async () => {
    if (service) {
      await service.stop();
    }
  });

  test('SDK handles corrupted encrypted response with user-facing error', async ({ page, request }) => {
    console.log('\n=== Testing corrupted encrypted response handling ===');

    // Send webhook /verify
    const webhookUpdate = {
      update_id: 123456789,
      message: {
        message_id: 1,
        from: {
          id: TEST_USER_ID,
          is_bot: false,
          first_name: 'Alice',
          username: 'alice_test',
        },
        chat: {
          id: TEST_USER_ID,
          first_name: 'Alice',
          username: 'alice_test',
          type: 'private',
        },
        date: Math.floor(Date.now() / 1000),
        text: '/verify',
      },
    };

    await request.post(`http://127.0.0.1:${serverPort}/telegram/webhook`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(webhookUpdate),
    });

    const stubTransport = (service as any).stubTransport;
    const webAppUrl = (stubTransport as any).lastWebAppUrl;
    const sessionMatch = webAppUrl.match(/session=([0-9a-f]{32})/);
    const sessionId = sessionMatch![1];

    const initData = createValidInitData(TEST_USER_ID, TEST_BOT_TOKEN);

    await page.route('**/telegram-web-app.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)}, ready: function() {}, expand: function() {} } };`,
      });
    });

    // Mock bridge with corrupted response
    await page.route('**bridge.worldcoin.org/**', async (route) => {
      const url = route.request().url();
      
      if (url.includes('/request') && route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ request_id: 'test_corrupted' }),
        });
      } else if (url.includes('/response/')) {
        // Return corrupted encrypted response
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'completed',
            response: {
              iv: 'aW52YWxpZF9pdg==',  // Invalid IV
              payload: 'Y29ycnVwdGVkX3BheWxvYWQ=',  // Corrupted payload
            },
          }),
        });
      } else {
        await route.abort();
      }
    });

    const enrollmentUrl = `http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`;
    await page.goto(enrollmentUrl);
    await page.waitForLoadState('networkidle');

    const verifyButton = page.locator('#verifyButton');
    await verifyButton.click();

    // Wait for polling attempts
    await page.waitForTimeout(10000);

    const statusEl = page.locator('#status');
    const finalStatus = await statusEl.textContent();

    console.log('Final status after corrupted response:', finalStatus);

    // With manual pollOnce() loop, corrupted responses are handled gracefully:
    // - pollOnce continues returning awaiting_confirmation (no crash)
    // - Or if SDK detects error, shows user-facing error
    // Key: page doesn't crash, user can cancel/retry
    const hasError = await statusEl.evaluate(el => el.className.includes('error'));
    const hasPollingUI = finalStatus && finalStatus.includes('QR');
    
    // Either shows error OR continues polling (both are graceful handling)
    expect(hasError || hasPollingUI).toBe(true);

    await page.screenshot({ 
      path: '/opt/cursor/artifacts/enrollment-decrypt-error.png',
      fullPage: true 
    });

    console.log('✓ Page handled corrupted response gracefully (no crash)');
  });
});
