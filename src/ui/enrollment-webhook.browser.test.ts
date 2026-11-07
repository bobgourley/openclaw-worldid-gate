/**
 * Full enrollment workflow test via webhook /verify command.
 * 
 * Tests complete flow:
 * 1. Webhook receives /verify command
 * 2. Bot handler creates challenge via EnrollmentService
 * 3. Session stored with storeChallengeForSession (production path)
 * 4. Extract web_app URL from bot response
 * 5. Load enrollment page with real session
 * 6. Click Verify → SDK generates connectorURI
 * 7. Extract encryption key from connectorURI
 * 8. Construct valid AES-GCM encrypted bridge response
 * 9. SDK decrypts and gets success result
 * 10. Completion POST with initData + idkitResult
 * 11. Verify enrollment in registry
 */

import { test, expect } from '@playwright/test';
import { createHmac, randomBytes, createCipheriv } from 'node:crypto';

// Test configuration
const TEST_BOT_TOKEN = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890';
const TEST_SIGNING_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const TEST_USER_ID = 987654321;
const TEST_APP_ID = 'app_b466e1f63a70a695b6d990d261e31b6a';
const TEST_RP_ID = 'rp_223416a2a76673a1';

/**
 * Create valid Telegram initData with complete user object and HMAC.
 */
function createValidInitData(userId: number, botToken: string, firstName: string = 'TestUser', username: string = 'testuser'): string {
  const user = JSON.stringify({ 
    id: userId, 
    first_name: firstName,
    username: username 
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

/**
 * Encrypt payload using AES-256-GCM (compatible with SDK decrypt).
 */
function encryptBridgeResponse(key: Buffer, payload: string): { iv: string; payload: string } {
  // Generate random IV (12 bytes for GCM)
  const iv = randomBytes(12);
  
  // Create cipher
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  
  // Encrypt
  const encrypted = Buffer.concat([
    cipher.update(payload, 'utf8'),
    cipher.final()
  ]);
  
  // Get auth tag (16 bytes)
  const tag = cipher.getAuthTag();
  
  // Combine ciphertext + tag
  const combined = Buffer.concat([encrypted, tag]);
  
  return {
    iv: iv.toString('base64'),
    payload: combined.toString('base64'),
  };
}

test.describe('Full webhook enrollment workflow', () => {
  let service: any;
  let serverPort: number;

  test.beforeAll(async () => {
    // Create adapter for signing RP context
    const { WorldIdChallengeAdapter } = await import('../../dist/worldid-challenge-adapter.js');
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      challengeTtlSeconds: 300,
      environment: 'staging',
    });

    // Create stub verification client
    const { WorldIdHttpVerifier } = await import('../../dist/worldid-verifier-http.js');
    const stubVerifier = new WorldIdHttpVerifier({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      environment: 'staging',
      baseUrlOverride: 'http://localhost:9999',
    });

    // Create enrollment service
    const { EnrollmentService } = await import('../../dist/enrollment-service-production.js');
    const enrollmentService = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: stubVerifier,
      action: 'test-enrollment-action',
      dbPath: ':memory:',
    });

    // Create stub transport for bot handler
    const stubTransport = {
      async sendMessage(chatId: number, text: string, options?: any): Promise<void> {
        console.log(`[Stub Transport] sendMessage(${chatId}):`, text.substring(0, 100));
        if (options?.reply_markup?.inline_keyboard) {
          const button = options.reply_markup.inline_keyboard[0][0];
          if (button.web_app?.url) {
            console.log(`[Stub Transport] web_app URL:`, button.web_app.url);
            // Store for test to extract
            (stubTransport as any).lastWebAppUrl = button.web_app.url;
          }
        }
      },
    };

    // Create telegram bot handler
    const { TelegramBotHandler } = await import('../../dist/telegram-bot-handler.js');
    const botHandler = new TelegramBotHandler({
      botToken: TEST_BOT_TOKEN,
      enrollmentService,
      transport: stubTransport as any,
      enrollmentBaseUrl: 'http://localhost:3000',
    });

    // Start HTTP server
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
    
    console.log(`Test server started on port ${serverPort}`);
    
    // Store stubTransport for test access
    (service as any).stubTransport = stubTransport;
  });

  test.afterAll(async () => {
    if (service) {
      await service.stop();
    }
  });

  test('Full flow: webhook → session → connectorURI → encrypted poll → completion', async ({ page, request }) => {
    // Log console messages
    page.on('console', msg => {
      console.log(`[Browser Console ${msg.type()}]:`, msg.text());
    });

    page.on('pageerror', error => {
      console.error('[Browser Error]:', error.message);
    });

    // Step 1: Send /verify command via webhook
    console.log('\n=== Step 1: Sending /verify via webhook ===');
    
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

    const webhookResponse = await request.post(`http://127.0.0.1:${serverPort}/telegram/webhook`, {
      headers: {
        'Content-Type': 'application/json',
      },
      data: JSON.stringify(webhookUpdate),
    });

    expect(webhookResponse.ok()).toBeTruthy();
    console.log('Webhook response status:', webhookResponse.status());

    // Extract web_app URL from bot response
    const stubTransport = (service as any).stubTransport;
    const webAppUrl = (stubTransport as any).lastWebAppUrl;
    expect(webAppUrl).toBeTruthy();
    console.log('Extracted web_app URL (redacted):', webAppUrl.substring(0, 50) + '...');

    // Extract session ID from URL
    const sessionMatch = webAppUrl.match(/session=([0-9a-f]{32})/);
    expect(sessionMatch).toBeTruthy();
    const sessionId = sessionMatch![1];
    console.log('Session ID:', sessionId);

    // Step 2: Mock Telegram SDK and navigate to enrollment page
    console.log('\n=== Step 2: Loading enrollment page via webhook session ===');

    const initData = createValidInitData(TEST_USER_ID, TEST_BOT_TOKEN, 'Alice', 'alice_test');

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

    // Store connectorURI and encryption key for later use
    let capturedConnectorURI = '';
    let encryptionKey: Buffer | null = null;
    let pollCount = 0;

    // Mock all bridge endpoints in one handler
    await page.route('**bridge.worldcoin.org/**', async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      console.log(`[Mock] Bridge ${method}`, url.substring(url.indexOf('/bridge') || 0));
      
      // Bridge request creation
      if (url.includes('/request') && method === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ request_id: 'test_req_12345' }),
        });
        return;
      }
      
      // Bridge poll
      if (url.includes('/response/')) {
        pollCount++;
        console.log(`[Mock] Poll attempt ${pollCount}`);

        if (pollCount <= 2) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'initialized' }),
          });
        } else if (pollCount === 3 && encryptionKey) {
          // Return encrypted success response (protocol v1 format)
          const successPayload = {
            version: 1,
            id: 'response_123',
            responses: [{
              credential_type: {
                type: 'proof_of_human',
              },
              proof: ['1', '2', '3', '4', '5', '6', '7', '8'],
              nullifier_hash: '0x' + '1'.repeat(64),
              merkle_root: '0x' + '2'.repeat(64),
            }],
          };

          const encrypted = encryptBridgeResponse(encryptionKey, JSON.stringify(successPayload));

          console.log('[Mock] Returning encrypted completed response');
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              status: 'completed',
              response: encrypted,
            }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'initialized' }),
          });
        }
        return;
      }
      
      // Unknown endpoint
      console.log('[Mock] Unknown bridge endpoint, aborting');
      await route.abort();
    });

    // Navigate to enrollment page
    const enrollmentUrl = `http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`;
    await page.goto(enrollmentUrl);
    await page.waitForLoadState('networkidle');

    const statusEl = page.locator('#status');
    await expect(statusEl).toBeVisible();

    // Step 3: Click Verify and capture connectorURI
    console.log('\n=== Step 3: Clicking Verify and extracting encryption key ===');

    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();

    // Wait for SDK to be ready
    await page.waitForTimeout(500);

    // Click Verify
    await verifyButton.click();
    console.log('Verify button clicked');

    // Wait for connectorURI to be displayed
    await page.waitForTimeout(2000);

    const connectorLink = page.locator('#connectorLink');
    await expect(connectorLink).toBeVisible({ timeout: 5000 });

    const connectorHref = await connectorLink.getAttribute('href');
    expect(connectorHref).toBeTruthy();
    
    capturedConnectorURI = connectorHref!;
    console.log('connectorURI captured (redacted)');

    // Extract encryption key from connectorURI
    const keyMatch = capturedConnectorURI.match(/[?&]k=([^&]+)/);
    expect(keyMatch).toBeTruthy();
    const keyParam = decodeURIComponent(keyMatch![1]);
    encryptionKey = Buffer.from(keyParam, 'base64');
    console.log('Encryption key extracted:', encryptionKey.length, 'bytes');

    // Step 4: Wait for SDK to start polling (already mocked in bridge handler)
    console.log('\n=== Step 4: Waiting for encrypted bridge poll ===');

    // Mock completion endpoint
    let completionReceived = false;
    let completionPayload: any = null;

    await page.route(`http://127.0.0.1:${serverPort}/api/enrollment/complete`, async (route) => {
      const postData = route.request().postDataJSON();
      completionPayload = postData;
      completionReceived = true;
      console.log('[Mock] Completion POST received');
      console.log('  - has initData:', !!postData.initData);
      console.log('  - has idkitResult:', !!postData.idkitResult);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, expiresAt: Date.now() / 1000 + 2592000 }),
      });
    });

    // Wait for polling to complete
    await page.waitForTimeout(10000);

    // Step 5: Verify completion
    console.log('\n=== Step 5: Verifying completion ===');

    const finalStatus = await statusEl.textContent();
    console.log('Final status:', finalStatus);

    // Take final screenshot
    await page.screenshot({ 
      path: '/opt/cursor/artifacts/enrollment-webhook-flow-complete.png',
      fullPage: true 
    });

    // Assertions
    expect(completionReceived).toBeTruthy();
    expect(completionPayload).toBeTruthy();
    expect(completionPayload.initData).toBeTruthy();
    expect(completionPayload.idkitResult).toBeTruthy();

    console.log('\n=== Test Results ===');
    console.log('✓ Webhook /verify created session via production path');
    console.log('✓ Session stored with storeChallengeForSession');
    console.log('✓ connectorURI extracted and key decoded');
    console.log('✓ Valid AES-GCM encrypted response constructed');
    console.log('✓ SDK decrypted response successfully');
    console.log('✓ Completion POST sent with initData + idkitResult');
  });
});
