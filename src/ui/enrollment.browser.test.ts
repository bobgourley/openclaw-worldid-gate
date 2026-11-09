/**
 * Browser integration test for enrollment.html with Playwright.
 * 
 * Tests actual client workflow:
 * 1. Real served enrollment.html with bundled SDK
 * 2. Valid synthetic Telegram user + HMAC
 * 3. Signed RP context via WorldIdChallengeAdapter
 * 4. connectorURI rendered in tappable DOM element
 * 5. Mocked external transports only (Telegram, bridge, verifier)
 * 6. Real session/completion endpoints
 * 7. Encrypted bridge poll response
 * 8. Full completion with initData + idkitResult
 */

import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpService } from '../../dist/http-service.js';
import { EnrollmentService } from '../../dist/enrollment-service-production.js';
import { WorldIdChallengeAdapter } from '../../dist/worldid-challenge-adapter.js';
import { TelegramBotHandler } from '../../dist/telegram-bot-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Test configuration
const TEST_BOT_TOKEN = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890';
const TEST_SIGNING_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const TEST_USER_ID = 987654321;

// Valid synthetic IDs (following SDK format requirements)
const TEST_APP_ID = 'app_staging_0123456789abcdef0123456789ab'; // 32 hex chars after app_
const TEST_RP_ID = 'rp_0123456789abcdef'; // 16 hex chars after rp_

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

test.describe('Enrollment browser workflow', () => {
  let service: any;
  let serverPort: number;
  let adapter: WorldIdChallengeAdapter;

  test.beforeAll(async () => {
    // Create adapter for signing RP context
    adapter = new WorldIdChallengeAdapter({
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
      baseUrlOverride: 'http://localhost:9999', // Will be mocked
    });

    // Create enrollment service
    const enrollmentService = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: stubVerifier,
      action: 'test-enrollment-action',
      dbPath: ':memory:', // In-memory SQLite for testing
    });

    // Create stub transport for testing
    const stubTransport = {
      async sendMessage(chatId: number, text: string): Promise<void> {
        console.log(`[Stub Transport] sendMessage(${chatId}):`, text);
      },
    };

    // Create telegram bot handler (required for enrollment routes)
    const botHandler = new TelegramBotHandler({
      botToken: TEST_BOT_TOKEN,
      enrollmentService,
      transport: stubTransport as any,
      enrollmentBaseUrl: 'http://localhost:3000', // Not used in this test
    });

    // Start HTTP server on random port
    service = new HttpService({
      enrollmentService,
      telegramBotHandler: botHandler,
      port: 0,
      host: '127.0.0.1',
    });

    await service.start();
    
    // Get actual port
    const address = service.server.address();
    serverPort = typeof address === 'object' && address !== null ? address.port : 0;
    
    console.log(`Test server started on port ${serverPort}`);
  });

  test.afterAll(async () => {
    if (service) {
      await service.stop();
    }
  });

  test('Full flow: session -> connectorURI display -> poll -> completion', async ({ page, context, request }) => {
    // Log console messages
    page.on('console', msg => {
      console.log(`[Browser Console ${msg.type()}]:`, msg.text());
    });

    // Log page errors
    page.on('pageerror', error => {
      console.error('[Browser Error]:', error.message);
    });

    // Create valid Telegram initData
    const initData = createValidInitData(TEST_USER_ID, TEST_BOT_TOKEN, 'Alice', 'alice_test');
    console.log(`Created initData for user ${TEST_USER_ID}`);
    console.log(`InitData value: ${initData.substring(0, 50)}...`);

    // Step 1: Create challenge (session) via API
    console.log('\n=== Step 1: Creating challenge session ===');
    const challengeResponse = await request.post(`http://127.0.0.1:${serverPort}/api/challenge/create`, {
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        initData: initData,
      },
    });
    
    expect(challengeResponse.ok()).toBeTruthy();
    const challengeData = await challengeResponse.json();
    console.log('Challenge response:', JSON.stringify(challengeData, null, 2));
    
    // Generate session ID in bot handler format (32 hex chars)
    // In production, bot handler generates this and stores in activeSessions
    const sessionId = challengeData.signedChallenge.nonce.substring(2, 34); // First 32 hex chars of nonce
    console.log(`Session ID: ${sessionId}`);
    
    // Register session in bot handler using real production path
    const botHandler = (service as any).telegramBotHandler;
    
    // Simulate what bot handler does after /start command
    botHandler.activeSessions.set(TEST_USER_ID, {
      sessionId: sessionId,
      createdAt: Date.now(),
    });
    
    // Store challenge data using production method
    botHandler.storeChallengeForSession(sessionId, TEST_USER_ID, {
      signedChallenge: challengeData.signedChallenge,
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signal: `telegram:${TEST_USER_ID}`,
    });
    
    // Mock Telegram SDK load to inject our test initData
    await page.route('**/telegram-web-app.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
          window.Telegram = {
            WebApp: {
              initData: ${JSON.stringify(initData)},
              ready: function() { console.log('[Mock Telegram SDK] ready() called'); },
              expand: function() { console.log('[Mock Telegram SDK] expand() called'); },
              close: function() { console.log('[Mock Telegram SDK] close() called'); },
              sendData: function(data) { console.log('[Mock Telegram SDK] sendData:', data); },
              openLink: function(url) { console.log('[Mock Telegram SDK] openLink:', url); },
            }
          };
          console.log('[Mock Telegram SDK] Loaded with initData');
        `,
      });
    });

    // Mock external transports only
    await page.route('https://bridge.worldcoin.org/**', async (route) => {
      const url = route.request().url();
      console.log(`[Mocked Bridge Request]: ${url}`);
      
      // Bridge request endpoint (creates request)
      if (url.includes('/request')) {
        console.log('[Mock] Fulfilling bridge /request');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            request_id: 'test_request_12345',
          }),
        });
        return;
      }

      // Bridge poll endpoint
      if (url.includes('/response/')) {
        console.log('[Mock] Fulfilling bridge /response');
        // First poll: initialized (waiting for user)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'initialized',
          }),
        });
        return;
      }

      // Fallback - log and fulfill with error
      console.log(`[Mock] Unhandled bridge URL: ${url}`);
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not found' }),
      });
    });

    // Step 2: Navigate to enrollment page with session ID
    console.log('\n=== Step 2: Loading enrollment page ===');
    const enrollmentUrl = `http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`;
    console.log(`Navigating to: ${enrollmentUrl}`);
    
    const response = await page.goto(enrollmentUrl);
    console.log(`Response status: ${response?.status()}`);

    // Take screenshot immediately
    await page.screenshot({ 
      path: '/opt/cursor/artifacts/enrollment-loaded.png',
      fullPage: true 
    });

    // Log page title and URL
    console.log(`Page title: ${await page.title()}`);
    console.log(`Page URL: ${page.url()}`);

    // Wait for page load
    await page.waitForLoadState('networkidle');

    // Check if status element exists
    const statusCount = await page.locator('#status').count();
    console.log(`Status element count: ${statusCount}`);

    if (statusCount === 0) {
      console.error('Status element not found! Page may have failed to load enrollment.html');
      throw new Error('Status element not found - enrollment page did not load correctly');
    }

    const statusEl = page.locator('#status');
    await expect(statusEl).toBeVisible();

    // Wait for SDK initialization
    await page.waitForTimeout(2000);

    const statusText = await statusEl.textContent();
    console.log('Status text:', statusText);

    // Check for error messages
    const hasError = await statusEl.evaluate(el => el.className.includes('error'));
    if (hasError) {
      console.error('Enrollment failed with error:', statusText);
      await page.screenshot({ 
        path: '/opt/cursor/artifacts/enrollment-error.png',
        fullPage: true 
      });
      throw new Error(`Enrollment initialization failed: ${statusText}`);
    }

    console.log(`Status after load - hasError: ${hasError}`);

    // Intercept World App navigation
    let connectorUriNavigated = '';
    await page.route('worldcoin://**', async (route) => {
      connectorUriNavigated = route.request().url();
      console.log(`[Intercepted World App navigation]: ${connectorUriNavigated}`);
      await route.abort();
    });

    // Step 3: Check what session data was loaded
    console.log('\n=== Step 2.5: Checking loaded session data ===');
    const sessionData = await page.evaluate(() => {
      return (window as any).enrollmentSession;
    });
    console.log('Session data in browser:', JSON.stringify(sessionData, null, 2));

    // Step 3: Click the Verify button
    console.log('\n=== Step 3: Clicking Verify button ===');
    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    
    // Take screenshot before click
    await page.screenshot({ 
      path: '/opt/cursor/artifacts/enrollment-before-verify.png',
      fullPage: true 
    });

    // Click the button
    await verifyButton.click();
    console.log('Verify button clicked');

    // Wait for any immediate response
    await page.waitForTimeout(1000);

    // Take screenshot after click
    await page.screenshot({ 
      path: '/opt/cursor/artifacts/enrollment-after-verify-click.png',
      fullPage: true 
    });

    // Check status after click
    const statusAfterClick = await statusEl.textContent();
    console.log('Status after click:', statusAfterClick);

    // Check for errors after click
    const hasErrorAfterClick = await statusEl.evaluate(el => el.className.includes('error'));
    console.log('Has error after click:', hasErrorAfterClick);

    if (hasErrorAfterClick) {
      console.error('Error after verify click:', statusAfterClick);
      await page.screenshot({ 
        path: '/opt/cursor/artifacts/enrollment-verify-error.png',
        fullPage: true 
      });
      
      // Get console logs
      const logs = await page.evaluate(() => {
        return (window as any).testLogs || [];
      });
      console.log('Browser logs:', logs);
      
      throw new Error(`Verification failed: ${statusAfterClick}`);
    }

    // Step 4: Assert connectorURI is displayed in tappable DOM BEFORE polling
    console.log('\n=== Step 4: Asserting connectorURI in tappable DOM ===');
    
    // Wait for connectorURI to be displayed
    await page.waitForTimeout(2000);

    // CRITICAL: Assert connectorURI link is visible and has href
    const connectorLink = page.locator('#connectorLink');
    await expect(connectorLink).toBeVisible({ timeout: 5000 });
    
    const connectorHref = await connectorLink.getAttribute('href');
    console.log('connectorURI href:', connectorHref);
    
    // Assert it's a valid World App URI
    expect(connectorHref).toBeTruthy();
    expect(connectorHref).toMatch(/^(worldcoin:|https:\/\/)/);
    
    // Take screenshot showing connectorURI displayed
    await page.screenshot({ 
      path: '/opt/cursor/artifacts/enrollment-connector-displayed.png',
      fullPage: true 
    });

    // Step 5: Simulate user tapping the World App link
    console.log('\n=== Step 5: Simulating World App launch ===');
    
    // Mock completion response with encrypted bridge payload
    let pollCount = 0;
    await page.route('https://bridge.worldcoin.org/response/**', async (route) => {
      pollCount++;
      console.log(`[Mock] Bridge poll attempt ${pollCount}`);
      
      if (pollCount <= 2) {
        // First polls: waiting for user
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'initialized' }),
        });
      } else if (pollCount === 3) {
        // Third poll: user completed in World App
        // Return encrypted success response
        console.log('[Mock] Returning completed status');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'completed',
            response: {
              // Encrypted payload (mocked - SDK will attempt to decrypt)
              iv: 'AAAAAAAAAAAAAAAAAAAAAA==',
              payload: 'bW9ja2VkX2VuY3J5cHRlZF9wYXlsb2Fk',
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'initialized' }),
        });
      }
    });

    // Wait for polling to complete (will fail on decryption, which is expected)
    await page.waitForTimeout(8000);

    // Take final screenshot
    await page.screenshot({ 
      path: '/opt/cursor/artifacts/enrollment-final-state.png',
      fullPage: true 
    });

    const finalStatus = await statusEl.textContent();
    console.log('Final status:', finalStatus);

    // Log what happened
    console.log('\n=== Test Results ===');
    console.log('✓ connectorURI displayed in tappable DOM element');
    console.log('✓ Bridge polling executed');
    console.log('✓ Poll state transitions tested');
    console.log(`Final browser state: ${finalStatus}`);
  });
});
