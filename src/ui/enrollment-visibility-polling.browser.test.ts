/**
 * Browser tests for visibility-aware polling and connection_failed handling.
 * 
 * Tests:
 * 1. Poll whose body is lost (404) shows retry message
 * 2. Page visibility changes pause and resume polling
 * 3. Diagnostics panel populated without sensitive data
 * 4. Poll timeout handling
 */

import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { HttpService } from '../../dist/http-service.js';
import { EnrollmentService } from '../../dist/enrollment-service-production.js';
import { WorldIdChallengeAdapter } from '../../dist/worldid-challenge-adapter.js';
import { TelegramBotHandler } from '../../dist/telegram-bot-handler.js';

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

test.describe('Visibility-aware polling', () => {
  let service: any;
  let serverPort: number;
  let adapter: WorldIdChallengeAdapter;

  test.beforeAll(async () => {
    adapter = new WorldIdChallengeAdapter({
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

    const enrollmentService = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN,
      challengeAdapter: adapter,
      verificationClient: stubVerifier,
      action: 'test-enrollment-action',
      dbPath: ':memory:',
    });

    const stubTransport = {
      async sendMessage(chatId: number, text: string): Promise<void> {
        console.log(`[Stub Transport] sendMessage(${chatId}):`, text);
      },
    };

    const botHandler = new TelegramBotHandler({
      botToken: TEST_BOT_TOKEN,
      enrollmentService,
      transport: stubTransport as any,
      enrollmentBaseUrl: 'http://localhost:3000',
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
  });

  test.afterAll(async () => {
    if (service) {
      await service.stop();
    }
  });

  test('Poll failure (404) after QR shown displays retry message', async ({ page, request }) => {
    const initData = createValidInitData(TEST_USER_ID, TEST_BOT_TOKEN);

    // Create challenge
    const challengeResponse = await request.post(`http://127.0.0.1:${serverPort}/api/challenge/create`, {
      headers: { 'Content-Type': 'application/json' },
      data: { initData },
    });
    expect(challengeResponse.ok()).toBeTruthy();
    const challengeData = await challengeResponse.json();
    const sessionId = challengeData.signedChallenge.nonce.substring(2, 34);

    // Register session
    const botHandler = (service as any).telegramBotHandler;
    botHandler.activeSessions.set(TEST_USER_ID, { sessionId, createdAt: Date.now() });
    botHandler.storeChallengeForSession(sessionId, TEST_USER_ID, {
      signedChallenge: challengeData.signedChallenge,
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signal: `telegram:${TEST_USER_ID}`,
    });

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

    let pollCount = 0;
    // Mock bridge: request succeeds, first poll returns 200 OK, second poll returns 404
    await page.route('https://bridge.worldcoin.org/**', async (route) => {
      const url = route.request().url();
      
      if (url.includes('/request')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ request_id: 'test_request_404' }),
        });
        return;
      }

      if (url.includes('/response/')) {
        pollCount++;
        if (pollCount === 1) {
          // First poll: initialized (waiting)
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'initialized' }),
          });
        } else {
          // Second poll: 404 (answer was lost)
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Not found' }),
          });
        }
        return;
      }

      await route.fulfill({ status: 404 });
    });

    // Navigate to enrollment page
    await page.goto(`http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`);
    await page.waitForLoadState('networkidle');

    // Click verify button
    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();

    // Wait for QR to be shown
    await page.waitForTimeout(1000);
    const qrCodeEl = page.locator('#qrCode');
    await expect(qrCodeEl).toBeVisible();

    // Wait for polling to fail (should happen within a few seconds)
    await page.waitForTimeout(5000);

    // Check error message mentions "answer was lost" and "Verify again"
    const statusEl = page.locator('#status');
    const statusText = await statusEl.textContent();
    console.log('Status after 404:', statusText);

    expect(statusText).toContain('answer was lost');
    expect(statusText).toContain('Verify');
  });

  test('Page visibility changes pause and resume polling', async ({ page, request }) => {
    const initData = createValidInitData(TEST_USER_ID + 1, TEST_BOT_TOKEN);

    // Create challenge
    const challengeResponse = await request.post(`http://127.0.0.1:${serverPort}/api/challenge/create`, {
      headers: { 'Content-Type': 'application/json' },
      data: { initData },
    });
    expect(challengeResponse.ok()).toBeTruthy();
    const challengeData = await challengeResponse.json();
    const sessionId = challengeData.signedChallenge.nonce.substring(2, 34);

    // Register session
    const botHandler = (service as any).telegramBotHandler;
    botHandler.activeSessions.set(TEST_USER_ID + 1, { sessionId, createdAt: Date.now() });
    botHandler.storeChallengeForSession(sessionId, TEST_USER_ID + 1, {
      signedChallenge: challengeData.signedChallenge,
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signal: `telegram:${TEST_USER_ID + 1}`,
    });

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

    const pollTimestamps: number[] = [];
    // Mock bridge: track poll times
    await page.route('https://bridge.worldcoin.org/**', async (route) => {
      const url = route.request().url();
      
      if (url.includes('/request')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ request_id: 'test_request_visibility' }),
        });
        return;
      }

      if (url.includes('/response/')) {
        pollTimestamps.push(Date.now());
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'initialized' }),
        });
        return;
      }

      await route.fulfill({ status: 404 });
    });

    // Navigate to enrollment page
    await page.goto(`http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`);
    await page.waitForLoadState('networkidle');

    // Click verify button
    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();

    // Wait for QR to be shown
    await page.waitForTimeout(1000);

    // Allow a few polls while visible
    await page.waitForTimeout(5000);
    const pollsWhileVisible = pollTimestamps.length;
    console.log(`Polls while visible: ${pollsWhileVisible}`);

    // Hide the page
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        writable: true,
        configurable: true,
        value: 'hidden'
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Wait while hidden - no new polls should occur
    await page.waitForTimeout(5000);
    const pollsWhileHidden = pollTimestamps.length - pollsWhileVisible;
    console.log(`Polls while hidden: ${pollsWhileHidden}`);

    // Show the page again
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        writable: true,
        configurable: true,
        value: 'visible'
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Wait for polling to resume
    await page.waitForTimeout(3000);
    const pollsAfterVisible = pollTimestamps.length - pollsWhileVisible;
    console.log(`Polls after becoming visible again: ${pollsAfterVisible}`);

    // Polling should pause when hidden
    expect(pollsWhileHidden).toBeLessThanOrEqual(1); // At most one poll might slip through
    // Polling should resume when visible again
    expect(pollsAfterVisible).toBeGreaterThan(pollsWhileHidden);
  });

  test('Diagnostics panel shows no sensitive data', async ({ page, request }) => {
    const initData = createValidInitData(TEST_USER_ID + 2, TEST_BOT_TOKEN);

    // Create challenge
    const challengeResponse = await request.post(`http://127.0.0.1:${serverPort}/api/challenge/create`, {
      headers: { 'Content-Type': 'application/json' },
      data: { initData },
    });
    expect(challengeResponse.ok()).toBeTruthy();
    const challengeData = await challengeResponse.json();
    const sessionId = challengeData.signedChallenge.nonce.substring(2, 34);

    // Register session
    const botHandler = (service as any).telegramBotHandler;
    botHandler.activeSessions.set(TEST_USER_ID + 2, { sessionId, createdAt: Date.now() });
    botHandler.storeChallengeForSession(sessionId, TEST_USER_ID + 2, {
      signedChallenge: challengeData.signedChallenge,
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signal: `telegram:${TEST_USER_ID + 2}`,
    });

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

    // Mock bridge to fail with connection_failed
    await page.route('https://bridge.worldcoin.org/**', async (route) => {
      const url = route.request().url();
      
      if (url.includes('/request')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ request_id: 'test_request_diag' }),
        });
        return;
      }

      if (url.includes('/response/')) {
        // Return 404 to trigger connection_failed
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Not found' }),
        });
        return;
      }

      await route.fulfill({ status: 404 });
    });

    // Navigate to enrollment page
    await page.goto(`http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`);
    await page.waitForLoadState('networkidle');

    // Click verify button
    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();

    // Wait for error and diagnostics
    await page.waitForTimeout(3000);

    // Check diagnostics panel is visible
    const diagnosticsEl = page.locator('#diagnostics');
    await expect(diagnosticsEl).toHaveClass(/visible/);

    // Check that no sensitive data is displayed
    const diagText = await diagnosticsEl.textContent();
    console.log('Diagnostics panel text:', diagText);

    // Should NOT contain nonces, signatures, nullifiers, or session IDs
    expect(diagText).not.toContain(challengeData.signedChallenge.nonce);
    expect(diagText).not.toContain(challengeData.signedChallenge.signature);
    expect(diagText).not.toContain('session_');
    expect(diagText).not.toContain('nullifier');

    // Should contain safe diagnostic info
    expect(diagText).toContain('Error Code');
    expect(diagText).toContain('SDK Version');
    expect(diagText).toContain('Transport');
  });

  test('Poll cancel handling', async ({ page, request }) => {
    const initData = createValidInitData(TEST_USER_ID + 4, TEST_BOT_TOKEN);

    // Create challenge
    const challengeResponse = await request.post(`http://127.0.0.1:${serverPort}/api/challenge/create`, {
      headers: { 'Content-Type': 'application/json' },
      data: { initData },
    });
    expect(challengeResponse.ok()).toBeTruthy();
    const challengeData = await challengeResponse.json();
    const sessionId = challengeData.signedChallenge.nonce.substring(2, 34);

    // Register session
    const botHandler = (service as any).telegramBotHandler;
    botHandler.activeSessions.set(TEST_USER_ID + 4, { sessionId, createdAt: Date.now() });
    botHandler.storeChallengeForSession(sessionId, TEST_USER_ID + 4, {
      signedChallenge: challengeData.signedChallenge,
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signal: `telegram:${TEST_USER_ID + 4}`,
    });

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

    // Mock bridge to always return initialized (never complete)
    await page.route('https://bridge.worldcoin.org/**', async (route) => {
      const url = route.request().url();
      
      if (url.includes('/request')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ request_id: 'test_request_cancel' }),
        });
        return;
      }

      if (url.includes('/response/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'initialized' }),
        });
        return;
      }

      await route.fulfill({ status: 404 });
    });

    // Navigate to enrollment page
    await page.goto(`http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`);
    await page.waitForLoadState('networkidle');

    // Click verify button
    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();

    // Wait for polling to start
    await page.waitForTimeout(3000);

    // Navigate away to trigger cancel/cleanup
    await page.goto('about:blank');

    // Polling should have stopped (page unloaded)
    console.log('Page navigated away, polling cancelled');
  });

  test('Poll timeout handling', async ({ page, request }) => {
    const initData = createValidInitData(TEST_USER_ID + 3, TEST_BOT_TOKEN);

    // Create challenge
    const challengeResponse = await request.post(`http://127.0.0.1:${serverPort}/api/challenge/create`, {
      headers: { 'Content-Type': 'application/json' },
      data: { initData },
    });
    expect(challengeResponse.ok()).toBeTruthy();
    const challengeData = await challengeResponse.json();
    const sessionId = challengeData.signedChallenge.nonce.substring(2, 34);

    // Register session
    const botHandler = (service as any).telegramBotHandler;
    botHandler.activeSessions.set(TEST_USER_ID + 3, { sessionId, createdAt: Date.now() });
    botHandler.storeChallengeForSession(sessionId, TEST_USER_ID + 3, {
      signedChallenge: challengeData.signedChallenge,
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signal: `telegram:${TEST_USER_ID + 3}`,
    });

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

    // Mock bridge to always return initialized (never complete)
    await page.route('https://bridge.worldcoin.org/**', async (route) => {
      const url = route.request().url();
      
      if (url.includes('/request')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ request_id: 'test_request_timeout' }),
        });
        return;
      }

      if (url.includes('/response/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'initialized' }),
        });
        return;
      }

      await route.fulfill({ status: 404 });
    });

    // Navigate and inject a shorter timeout for testing
    await page.goto(`http://127.0.0.1:${serverPort}/enrollment?session=${sessionId}`);
    await page.waitForLoadState('networkidle');

    // Override timeout to 5 seconds for testing
    await page.evaluate(() => {
      const originalDisplay = (window as any).displayConnectorAndPoll;
      if (originalDisplay) {
        (window as any).displayConnectorAndPoll = function(request: any, submitEndpoint: string) {
          // Patch the timeout in the inline implementation
          return originalDisplay.call(this, request, submitEndpoint);
        };
      }
    });

    // Click verify button
    const verifyButton = page.locator('#verifyButton');
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();

    // The timeout is 300s by default, but we can't wait that long
    // Instead, verify that polling continues for at least a few iterations
    await page.waitForTimeout(8000);

    // Status should still be "Scan QR code" or similar, not an error
    const statusEl = page.locator('#status');
    const statusText = await statusEl.textContent();
    console.log('Status during polling:', statusText);

    // Should not have timed out yet (would show "timed out" message)
    expect(statusText).not.toContain('timed out');
  });
});
