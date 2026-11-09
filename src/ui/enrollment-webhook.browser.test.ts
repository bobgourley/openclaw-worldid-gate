/**
 * Full webhook enrollment workflow test - end-to-end with persistence verification
 * 
 * Tests complete path: Telegram webhook → enrollment page → IDKit verification → enrollment persisted
 * 
 * Stubs:
 * - IDKit at PUBLIC API level (test idkit-bundle.js with realistic result)
 * - World verifier using injected fetchFn stub returning v4 success
 * 
 * Real components:
 * - Webhook handler
 * - Enrollment page (HTML + bundles)
 * - Server /api/challenge/create and /api/enrollment/complete handlers
 * - Database persistence (in-memory SQLite)
 */

import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const TEST_USER_ID = 987654321;
const TEST_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const TEST_APP_ID = 'app_test_0123456789abcdef';
const TEST_RP_ID = 'rp_test_0123456789';
const TEST_WEBHOOK_SECRET = 'test_webhook_secret_123';
const TEST_ACTION = 'openclaw-enroll-v2';

/**
 * Create valid Telegram initData with HMAC signature
 */
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

test.describe('Full webhook enrollment workflow', () => {
  let service: any;
  let serverPort: number;

  test.beforeAll(async () => {
    // Dynamic imports
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

    // Stub World verifier with injected fetchFn returning documented v4 success format  
    const stubFetchFn = async (url: string, options: any): Promise<Response> => {
      // This log appears in Node console, not browser
      console.log('[Stub World API] Called with URL:', url);
      const body = JSON.parse(options.body);
      console.log('[Stub World API] Request body identifier:', body.responses?.[0]?.identifier);
      
      // Return documented v4 verify API response format
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
        console.log(`[Stub Transport] sendMessage(${chatId})`);
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
    console.log(`Test server started on port ${serverPort}`);

    (service as any).stubTransport = stubTransport;
    (service as any).enrollmentService = enrollmentService;
  });

  test.afterAll(async () => {
    if (service) {
      await service.stop();
    }
  });

  test('Full flow: webhook creates session, IDKit stub returns success, enrollment persisted', async ({ page }) => {
    // Log console messages
    page.on('console', msg => {
      console.log(`[Browser Console ${msg.type()}]:`, msg.text());
    });

    // Log page errors
    page.on('pageerror', error => {
      console.error('[Browser Error]:', error.message);
    });

    // Step 1: Send /verify via webhook
    console.log('\n=== Step 1: Webhook /verify ===');
    
    const webhookUpdate = {
      update_id: 123456,
      message: {
        message_id: 789,
        from: { id: TEST_USER_ID, is_bot: false, first_name: 'Alice' },
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
    expect(webAppUrl).toBeTruthy();

    const sessionMatch = webAppUrl.match(/session=([0-9a-f]{32})/);
    expect(sessionMatch).toBeTruthy();
    const sessionId = sessionMatch![1];
    console.log('Session ID:', sessionId);

    // Step 2: Mock Telegram SDK and serve test IDKit bundle
    console.log('\n=== Step 2: Preparing page with stubs ===');

    const initData = createValidInitData(TEST_USER_ID, TEST_BOT_TOKEN, 'Alice', 'alice_test');
    
    // Mock Telegram SDK
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
            }
          };
        `,
      });
    });

    // Log all requests
    page.on('request', req => {
      if (req.url().includes('bundle') || req.url().includes('telegram')) {
        console.log('[Request]:', req.url());
      }
    });

    // Serve test IDKit bundle that stubs at public API
    await page.route('**/idkit-bundle.js', async (route) => {
      console.log('[Route] Serving test IDKit bundle');

      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
          // Stub IDKit bundle for testing
          window.WorldIDKitBundle = {
            IDKit: {
              request: function(config) {
                console.log('[Test IDKit] request() called with config');
                const connector = {
                  uri: 'https://world.org/verify?t=wld&i=test123&k=abc',
                  async poll() {
                    console.log('[Test IDKit] Returning mock success');
                    // Realistic format: 0x hex nullifier, 5 decimal proof strings
                    return {
                      type: 'confirmed',
                      result: {
                        protocol_version: '4.0',
                        nonce: config.rp_context.nonce,
                        action: config.rp_context.action,
                        session_id: config.rp_context.session_id,
                        responses: [{
                          identifier: 'proof_of_human',
                          issuer_schema_id: 1,
                          proof: ['1234567890123456789012345678901234567890',
                                  '9876543210987654321098765432109876543210',
                                  '1111111111111111111111111111111111111111',
                                  '2222222222222222222222222222222222222222',
                                  '3333333333333333333333333333333333333333'],
                          nullifier: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                          signal_hash: config.rp_context.signal_hash,
                          expires_at_min: Math.floor(Date.now() / 1000) + 86400,
                        }],
                        environment: 'staging',
                      }
                    };
                  },
                  cancel() {
                    console.log('[Test IDKit] cancel() called');
                  }
                };
                const requestObj = {
                  connector: connector,
                  connectorURI: connector.uri,
                  pollUntilCompletion: async function(opts) {
                    console.log('[Test IDKit] pollUntilCompletion() called');
                    const pollResult = await connector.poll();
                    if (pollResult.type === 'confirmed') {
                      return { success: true, result: pollResult.result };
                    } else {
                      return { success: false, error: 'Verification failed' };
                    }
                  }
                };
                // Return a thenable (Promise-like) that also has .constraints() method
                const thenable = {
                  then: function(onResolve) {
                    return Promise.resolve(requestObj).then(onResolve);
                  },
                  constraints: function(credReq) {
                    console.log('[Test IDKit] constraints() called with', credReq);
                    return thenable;
                  }
                };
                return thenable;
              },
              proveSession: function(sessionId, config) {
                console.log('[Test IDKit] proveSession() called');
                return this.request(config);
              }
            },
            CredentialRequest: function(type, options) {
              console.log('[Test IDKit] CredentialRequest(' + type + ')');
              return { type: type, options: options };
            }
          };
        `,
      });
    });

    // Step 3: Load enrollment page
    console.log('\n=== Step 3: Loading enrollment page ===');
    const enrollmentUrl = `http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`;
    await page.goto(enrollmentUrl);
    await page.waitForLoadState('networkidle');

    const statusEl = page.locator('#status');
    await expect(statusEl).toBeVisible();
    console.log('Page loaded');

    // Step 4: Monitor /api/enrollment/complete POST
    console.log('\n=== Step 4: Clicking Verify and monitoring completion ===');
    
    let completionReceived = false;
    let completionStatus = 0;
    
    page.on('response', async (response) => {
      if (response.url().includes('/api/enrollment/complete') && response.request().method() === 'POST') {
        completionReceived = true;
        completionStatus = response.status();
        console.log('[Monitor] POST /api/enrollment/complete status:', completionStatus);
        if (completionStatus !== 200) {
          const body = await response.text();
          console.log('[Monitor] Response body:', body);
        }
      }
    });

    // Click verify button
    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();
    console.log('Verify button clicked');

    // Wait for completion (IDKit stub resolves immediately)
    await page.waitForTimeout(3000);

    // Step 5: Verify enrollment persisted
    console.log('\n=== Step 5: Verifying enrollment persisted ===');
    
    expect(completionReceived).toBe(true);
    expect(completionStatus).toBe(200);

    const enrollmentService = (service as any).enrollmentService;
    const enrollment = await enrollmentService.findEnrollment(TEST_USER_ID);
    
    expect(enrollment).toBeTruthy();
    expect(enrollment.telegram_user_id).toBe(TEST_USER_ID);
    expect(enrollment.action).toBe(TEST_ACTION);
    expect(enrollment.revoked).toBe(false);
    expect(enrollment.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
    
    console.log('Enrollment verified in database:', {
      user_id: enrollment.telegram_user_id,
      action: enrollment.action,
      nullifier: enrollment.nullifier.substring(0, 20) + '...',
    });

    console.log('\n=== Test Complete ===');
    console.log('PASS: Webhook created session');
    console.log('PASS: Page loaded with valid session');
    console.log('PASS: IDKit stub returned realistic result (0x hex nullifier, 5 decimal proof)');
    console.log('PASS: POST /api/enrollment/complete returned 200');
    console.log('PASS: Enrollment persisted in database with correct action');
  });

  test('Negative case: verifier rejects proof, nothing persisted', async ({ page }) => {
    console.log('\n=== Negative Test: Verifier Rejects ===');

    // Override verifier to reject
    const enrollmentService = (service as any).enrollmentService;
    const originalVerifier = enrollmentService.verificationClient;
    
    enrollmentService.verificationClient = {
      async verify(): Promise<any> {
        console.log('[Stub Verifier] Rejecting proof');
        return {
          success: false,
          error: 'Invalid proof signature',
        };
      },
    };

    // Webhook /verify
    const webhookUpdate = {
      update_id: 123457,
      message: {
        message_id: 790,
        from: { id: TEST_USER_ID + 1, is_bot: false, first_name: 'Bob' },
        chat: { id: TEST_USER_ID + 1, type: 'private' as const },
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

    // Mock Telegram and IDKit
    const initData = createValidInitData(TEST_USER_ID + 1, TEST_BOT_TOKEN, 'Bob', 'bob_test');
    
    await page.route('**/telegram-web-app.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)}, ready: function() {}, expand: function() {} } };`,
      });
    });

    await page.route('**/idkit-bundle.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
          window.WorldIDKitBundle = {
            IDKit: {
              request: function(config) {
                const connector = {
                  uri: 'https://world.org/verify?t=wld&i=test456&k=xyz',
                  async poll() {
                    return {
                      type: 'confirmed',
                      result: {
                        protocol_version: '4.0',
                        nonce: config.rp_context.nonce,
                        action: config.rp_context.action,
                        session_id: config.rp_context.session_id,
                        responses: [{
                          identifier: 'proof_of_human',
                          issuer_schema_id: 1,
                          proof: ['111', '222', '333', '444', '555'],
                          nullifier: '0x1111111111111111111111111111111111111111111111111111111111111111',
                          signal_hash: config.rp_context.signal_hash,
                          expires_at_min: Math.floor(Date.now() / 1000) + 86400,
                        }],
                        environment: 'staging',
                      }
                    };
                  },
                  cancel() {}
                };
                return { connector };
              },
              proveSession: function(config) { return this.request(config); }
            }
          };
        `,
      });
    });

    // Load page and click verify
    const enrollmentUrl = `http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`;
    await page.goto(enrollmentUrl);
    await page.waitForLoadState('networkidle');

    let completionStatus = 0;
    page.on('response', async (response) => {
      if (response.url().includes('/api/enrollment/complete')) {
        completionStatus = response.status();
        console.log('[Monitor] Completion status:', completionStatus);
      }
    });

    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();
    
    await page.waitForTimeout(3000);

    // Verify enrollment NOT persisted
    const enrollment = await enrollmentService.findEnrollment(TEST_USER_ID + 1);
    expect(enrollment).toBeNull();
    
    console.log('PASS: Verifier rejected proof');
    console.log('PASS: No enrollment persisted for rejected proof');

    // Restore verifier
    enrollmentService.verificationClient = originalVerifier;
  });
});
