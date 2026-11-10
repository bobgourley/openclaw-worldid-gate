/**
 * Success state UI test - clean success state after verification
 * 
 * Tests that after successful verification:
 * - QR code is hidden
 * - 'Scan QR code' label and 'Or tap to open' button are hidden
 * - Success message is shown with check mark
 * - Expiry date is shown in plain words
 * - Return to Telegram button is shown
 * - Return button calls Telegram.WebApp.close()
 */

import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const TEST_USER_ID = 888888888;
const TEST_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const TEST_APP_ID = 'app_test_0123456789abcdef';
const TEST_RP_ID = 'rp_test_0123456789';
const TEST_WEBHOOK_SECRET = 'test_webhook_secret_123';
const TEST_ACTION = 'openclaw-session-v1';

function createValidInitData(userId: number, botToken: string, firstName: string, username: string): string {
  const authDate = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({
    id: userId,
    first_name: firstName,
    username,
    language_code: 'en',
  });

  const dataCheckString = [
    `auth_date=${authDate}`,
    `user=${user}`,
  ].sort().join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return `auth_date=${authDate}&user=${encodeURIComponent(user)}&hash=${hash}`;
}

test.describe('Success state UI after verification', () => {
  let service: any;
  let serverPort: number;

  test.beforeAll(async () => {
    const { WorldIdChallengeAdapter } = await import('../../dist/worldid-challenge-adapter.js');
    const { EnrollmentService } = await import('../../dist/enrollment-service-production.js');
    const { HttpService } = await import('../../dist/http-service.js');
    const { TelegramBotHandler } = await import('../../dist/telegram-bot-handler.js');

    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      challengeTtlSeconds: 300,
      environment: 'staging',
    });

    const stubFetchFn = async (url: string, options: any): Promise<Response> => {
      const body = JSON.parse(options.body);
      return new Response(JSON.stringify({
        success: true,
        environment: 'staging',
        results: [{
          identifier: body.responses[0].identifier,
          success: true,
          nullifier: body.responses[0].nullifier,
          issuer_schema_id: body.responses[0].issuer_schema_id,
          expires_at_min: body.responses[0].expires_at_min,
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { WorldIdHttpVerifier } = await import('../../dist/worldid-verifier-http.js');
    const verifier = new WorldIdHttpVerifier({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      environment: 'staging',
      baseUrlOverride: 'http://localhost:9999',
      fetchFn: stubFetchFn,
    });

    const enrollmentService = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: verifier,
      action: TEST_ACTION,
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

    const botHandler = new TelegramBotHandler({
      botToken: TEST_BOT_TOKEN,
      enrollmentService,
      transport: stubTransport as any,
      enrollmentBaseUrl: 'http://localhost:3000',
      webhookSecret: TEST_WEBHOOK_SECRET,
    });

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
    (service as any).enrollmentService = enrollmentService;
  });

  test.afterAll(async () => {
    if (service) {
      await service.stop();
    }
  });

  test('Success state: QR and buttons hidden, success message and Return button shown, Return calls close()', async ({ page }) => {
    // Expose hashSignal for dynamic computation
    const { hashSignal } = await import('@worldcoin/idkit-core');
    await page.exposeFunction('__testHashSignal', (signal: string) => hashSignal(signal));

    // Track Telegram.WebApp.close() calls
    let closeWasCalled = false;
    await page.exposeFunction('__trackTelegramClose', () => {
      closeWasCalled = true;
    });

    // Send webhook /verify
    const webhookUpdate = {
      update_id: 999001,
      message: {
        message_id: 999,
        from: { id: TEST_USER_ID, is_bot: false, first_name: 'Success' },
        chat: { id: TEST_USER_ID, type: 'private' as const },
        date: Math.floor(Date.now() / 1000),
        text: '/verify',
      },
    };

    const webhookResponse = await page.request.post(`http://127.0.0.1:${serverPort}/telegram/webhook`, {
      data: webhookUpdate,
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': TEST_WEBHOOK_SECRET,
      },
    });

    expect(webhookResponse.ok()).toBe(true);

    const stubTransport = (service as any).stubTransport;
    const webAppUrl = stubTransport.lastWebAppUrl;
    const sessionMatch = webAppUrl.match(/session=([0-9a-f]{32})/);
    const sessionId = sessionMatch![1];

    const initData = createValidInitData(TEST_USER_ID, TEST_BOT_TOKEN, 'Success', 'success_test');

    // Mock Telegram SDK with close() tracking
    await page.route('**/telegram-web-app.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
          window.Telegram = {
            WebApp: {
              initData: ${JSON.stringify(initData)},
              ready: function() {},
              expand: function() {},
              close: function() {
                console.log('[Telegram SDK] close() called');
                window.__trackTelegramClose();
              }
            }
          };
        `,
      });
    });

    // Mock IDKit bundle
    await page.route('**/idkit-bundle.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
          window.WorldIDKitBundle = {
            IDKit: {
              request: function(config) {
                let capturedSignal = null;
                const connector = {
                  uri: 'https://world.org/verify?t=wld&i=test123&k=abc',
                  async poll() {
                    let signal_hash;
                    if (capturedSignal && window.__testHashSignal) {
                      signal_hash = await window.__testHashSignal(capturedSignal);
                    } else {
                      throw new Error('No signal captured');
                    }
                    return {
                      type: 'confirmed',
                      result: {
                        protocol_version: '4.0',
                        nonce: config.rp_context.nonce,
                        action: config.action,
                        session_id: config.session_id === 'create' ? 'session_' + '0'.repeat(128) : config.session_id,
                        responses: [{
                          identifier: 'proof_of_human',
                          issuer_schema_id: 1,
                          proof: ['1111', '2222', '3333', '4444', '5555'],
                          nullifier: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                          signal_hash: signal_hash,
                          expires_at_min: Math.floor(Date.now() / 1000) + 2592000,
                        }],
                        environment: 'staging',
                      }
                    };
                  },
                  cancel() {
                    console.log('[IDKit] cancel() called');
                  }
                };
                const requestObj = {
                  connector: connector,
                  connectorURI: connector.uri,
                  pollOnce: async function() {
                    const pollResult = await connector.poll();
                    return pollResult;
                  },
                  pollUntilCompletion: async function() {
                    const pollResult = await connector.poll();
                    return pollResult.type === 'confirmed' 
                      ? { success: true, result: pollResult.result }
                      : { success: false, error: 'Verification failed' };
                  },
                  getDebugReport: function() {
                    return {
                      transport: 'bridge',
                      package_version: '4.6.0',
                      request_payload: {}
                    };
                  },
                  cancel: function() {
                    console.log('[IDKit request] cancel() called');
                  }
                };
                const thenable = {
                  then: function(onResolve) {
                    return Promise.resolve(requestObj).then(onResolve);
                  },
                  constraints: function(credReq) {
                    if (credReq && credReq.options && credReq.options.signal) {
                      capturedSignal = credReq.options.signal;
                    }
                    return thenable;
                  }
                };
                return thenable;
              },
              proveSession: function(sessionId, config) {
                return this.request(config);
              }
            },
            CredentialRequest: function(type, options) {
              return { type: type, options: options };
            }
          };
        `,
      });
    });

    // Load enrollment page
    const enrollmentUrl = `http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`;
    await page.goto(enrollmentUrl);
    await page.waitForLoadState('networkidle');

    const qrCodeEl = page.locator('#qrCode');
    const connectorDisplayEl = page.locator('#connectorDisplay');

    // Click verify button
    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();

    // Wait for completion (IDKit stub resolves immediately, so success state appears quickly)
    await page.waitForTimeout(3000);

    // Verify success state
    // 1. QR code div should be hidden (display: none)
    await expect(qrCodeEl).not.toBeVisible();

    // 2. Connector display (label + button) should be hidden
    await expect(connectorDisplayEl).not.toBeVisible();

    // 3. Success message should be visible with check mark
    const statusEl = page.locator('#status');
    await expect(statusEl).toHaveClass(/success/);
    const statusText = await statusEl.textContent();
    expect(statusText).toContain('✓');
    expect(statusText).toContain("You're verified");

    // 4. Expiry date should be in plain words
    expect(statusText).toMatch(/Your verification is valid until .+ \d{1,2}:\d{2}\s[AP]M .+ \(\d+ days?, \d+ hours? left\)/);

    // 5. Return to Telegram button should be visible
    const returnButton = page.locator('#returnButton');
    await expect(returnButton).toBeVisible();
    expect(await returnButton.textContent()).toContain('Return to Telegram');

    // 6. Privacy note should be visible
    expect(statusText).toContain('Your enrollment status is stored encrypted');

    // 7. Click Return button and verify close() was called
    await returnButton.click();
    await page.waitForTimeout(500);
    expect(closeWasCalled).toBe(true);

    console.log('PASS: QR code and connector display hidden after success');
    console.log('PASS: Success message with check mark and plain-words expiry shown');
    console.log('PASS: Return to Telegram button shown and calls Telegram.WebApp.close()');
  });
});
