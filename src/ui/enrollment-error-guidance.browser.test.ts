/**
 * Error guidance, diagnostics and on-page instructions.
 *
 * Uses the real served page and the real IDKit bundle. Only IDKit.request is
 * wrapped so the poll returns a World App failure (generic_error), matching a
 * real failure seen in production where the server dropped the code.
 */

import { test, expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

const TEST_BOT_TOKEN = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890';
const TEST_SIGNING_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const TEST_APP_ID = 'app_staging_0123456789abcdef0123456789ab';
const TEST_RP_ID = 'rp_0123456789abcdef';
const TEST_ACTION = 'test-guidance-action';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

function initDataFor(userId: number): string {
  const user = JSON.stringify({ id: userId, first_name: 'TestUser' });
  const authDate = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = { user, auth_date: String(authDate) };
  const dcs = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(TEST_BOT_TOKEN).digest();
  const hash = createHmac('sha256', key).update(dcs).digest('hex');
  return `user=${encodeURIComponent(user)}&auth_date=${authDate}&hash=${hash}`;
}

/** Appended to the real bundle: wraps IDKit.request so polling fails with `errorCode`. */
function failingRequestShim(errorCode: string, actionOverride: string | null, responsePayload: string | null = null): string {
  return `
;(function(){
  var B = window.WorldIDKitBundle;
  var realHash = B.hashSignal;
  B.IDKit.request = function(cfg){
    window.__rup = cfg.require_user_presence;
    return { constraints: async function(){
      var action = ${actionOverride === null ? 'cfg.action' : JSON.stringify(actionOverride)};
      return {
        connectorURI: 'https://world.org/verify?t=test',
        requestId: 'test',
        pollOnce: async function(){
          if (${JSON.stringify(errorCode)} === '__pending__') return { type: 'awaiting_confirmation' };
          return { type: 'failed', error: ${JSON.stringify(errorCode)} };
        },
        getDebugReport: function(){ return {
          version: 1, package_version: '4.6.0', transport: 'bridge', generated_at: new Date().toISOString(), request_id: '3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8',
          request_payload: { environment: 'production', app_id: cfg.app_id, proof_request: {
            rp_id: cfg.rp_context.rp_id, nonce: cfg.rp_context.nonce, signature: cfg.rp_context.signature,
            created_at: cfg.rp_context.created_at, expires_at: cfg.rp_context.expires_at,
            action: realHash(action)
          } }${responsePayload === null ? '' : ', response_payload: ' + JSON.stringify(responsePayload)}
        }; }
      };
    } };
  };
})();`;
}

test.describe('Error guidance and diagnostics', () => {
  let service: any;
  let port: number;
  let userCounter = 555000001;
  const logged: any[] = [];
  const originalLog = console.log;

  test.beforeAll(async () => {
    const { WorldIdChallengeAdapter } = await import('../../dist/worldid-challenge-adapter.js');
    const { WorldIdHttpVerifier } = await import('../../dist/worldid-verifier-http.js');
    const { EnrollmentService } = await import('../../dist/enrollment-service-production.js');
    const { HttpService } = await import('../../dist/http-service.js');
    const { TelegramBotHandler } = await import('../../dist/telegram-bot-handler.js');
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID, rpId: TEST_RP_ID, signingKeyHex: TEST_SIGNING_KEY,
      challengeTtlSeconds: 300, environment: 'staging',
    });
    const verifier = new WorldIdHttpVerifier({
      appId: TEST_APP_ID, rpId: TEST_RP_ID, environment: 'staging', baseUrlOverride: 'http://localhost:9999',
    });
    const enrollmentService = new EnrollmentService({
      telegramBotToken: TEST_BOT_TOKEN, challengeAdapter: adapter, verificationClient: verifier,
      action: TEST_ACTION, dbPath: ':memory:',
    });
    const botHandler = new TelegramBotHandler({
      botToken: TEST_BOT_TOKEN, enrollmentService,
      transport: { async sendMessage() {} } as any,
      enrollmentBaseUrl: 'http://localhost:3000',
    });
    service = new HttpService({ enrollmentService, telegramBotHandler: botHandler, port: 0, host: '127.0.0.1' });
    await service.start();
    port = service.getActualPort();
    console.log = (...args: any[]) => {
      if (args[0] === '[Client Diagnostics]') logged.push(JSON.parse(args[1]));
      originalLog(...args);
    };
  });

  test.afterAll(async () => {
    console.log = originalLog;
    if (service) await service.stop();
  });

  async function openPage(page: Page, opts: { platform: string; errorCode: string; actionOverride?: string | null; responsePayload?: string | null }) {
    const initData = initDataFor(userCounter++);
    await page.route('**/telegram-web-app.js', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript',
      body: `window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)}, platform: ${JSON.stringify(opts.platform)}, ready(){}, expand(){} } };`,
    }));
    await page.route('**/idkit-bundle.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()) + failingRequestShim(opts.errorCode, opts.actionOverride ?? null, opts.responsePayload ?? null);
      await route.fulfill({ status: 200, contentType: 'application/javascript', body });
    });
    const diagBodies: any[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/diagnostics/client')) diagBodies.push(JSON.parse(req.postData() || '{}'));
    });
    await page.goto(`http://127.0.0.1:${port}/enrollment?session=${'a'.repeat(32)}`);
    await expect(page.locator('#verifyButton')).toBeVisible();
    await expect(page.locator('#verifyButton')).toHaveText(/Verify with World ID/);
    return diagBodies;
  }

  test.describe('phone', () => {
    test.use({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('generic_error shows clear steps, keeps diagnostics panel, Action Match passes, server logs code and context', async ({ page }) => {
      const diagBodies = await openPage(page, { platform: 'ios', errorCode: 'generic_error' });

      // Instructions and same-device button are present on a phone
      const steps = page.locator('#qrSteps li');
      await expect(steps).toHaveCount(3);
      await expect(steps.nth(0)).toHaveText('Open the World ID app (or World App) on your phone and scan this code.');
      await expect(steps.nth(1)).toHaveText('If the app is on this same phone, tap the button instead.');
      await expect(steps.nth(2)).toHaveText('Keep this page open until it finishes.');

      const before = logged.length;
      await page.locator('#verifyButton').click();

      const status = page.locator('#status');
      await expect(status).toHaveClass(/error/, { timeout: 15000 });
      await expect(status).toContainText('World ID could not complete this request.');
      await expect(status).toContainText('update the World ID app (or World App) to the latest version');
      await expect(status).toContainText('Orb verified');
      await expect(status).toContainText('keep this page open until it finishes');

      // Diagnostics panel kept, with the real code and a real action check
      await expect(page.locator('#diagnostics')).toHaveClass(/visible/);
      await expect(page.locator('#diagErrorCode')).toHaveText('generic_error');
      await expect(page.locator('#diagTransport')).toHaveText('bridge');
      await expect(page.locator('#diagActionMatch')).toHaveText(/PASS/);

      // QR steps/link were visible on phone before failure
      await expect(page.locator('#connectorLink')).toHaveText(/Open World ID on this phone/);
      await expect(page.locator('#connectorLink')).not.toHaveClass(/hidden/);
      await expect(page.locator('#qrStepSameDevice')).not.toHaveClass(/hidden/);

      // Client sent the code plus coarse context only
      await expect.poll(() => diagBodies.length).toBeGreaterThan(0);
      const sent = diagBodies[0];
      expect(sent.errorCode).toBe('generic_error');
      expect(sent.transport).toBe('bridge');
      expect(sent.deviceClass).toBe('phone');
      expect(sent.tgPlatform).toBe('ios');
      expect(sent.entryPath).toBe('qr');
      expect(sent.flow).toBe('enroll');
      expect(JSON.stringify(sent)).not.toMatch(/555\d{6}|nonce|signature|session_|0x[0-9a-f]{64}/i);

      // Server logged it (previously dropped)
      await expect.poll(() => logged.length).toBeGreaterThan(before);
      const entry = logged[logged.length - 1];
      expect(entry.errorCode).toBe('generic_error');
      expect(entry.deviceClass).toBe('phone');
      expect(entry.entryPath).toBe('qr');
    });

    test('Action Match shows FAIL when the debug report action differs', async ({ page }) => {
      await openPage(page, { platform: 'ios', errorCode: 'generic_error', actionOverride: 'some-other-action' });
      await page.locator('#verifyButton').click();
      await expect(page.locator('#diagnostics')).toHaveClass(/visible/, { timeout: 15000 });
      await expect(page.locator('#diagActionMatch')).toHaveText(/FAIL/);
    });

    test('raw app code hidden behind generic_error (challenge_failed) is shown, explained, and logged as fixed values', async ({ page }) => {
      const before = logged.length;
      const diagBodies = await openPage(page, {
        platform: 'ios', errorCode: 'generic_error',
        responsePayload: JSON.stringify({ error_code: 'challenge_failed', reason: 'pcp_missing' }),
      });
      await page.locator('#verifyButton').click();
      const status = page.locator('#status');
      await expect(status).toHaveClass(/error/, { timeout: 15000 });
      await expect(status).toContainText('could not complete a check it asked for, such as a face check');
      await expect(page.locator('#diagErrorCode')).toHaveText('generic_error');
      await expect(page.locator('#diagUpstream')).toHaveText('challenge_failed (pcp_missing)');
      await expect.poll(() => diagBodies.length).toBeGreaterThan(0);
      expect(diagBodies[0].upstreamCode).toBe('challenge_failed');
      expect(diagBodies[0].upstreamReason).toBe('pcp_missing');
      await expect.poll(() => logged.length).toBeGreaterThan(before);
      const entry = logged[logged.length - 1];
      expect(entry.errorCode).toBe('generic_error');
      expect(entry.upstreamCode).toBe('challenge_failed');
      expect(entry.upstreamReason).toBe('pcp_missing');
    });

    test('unrecognized raw app values become other and nothing else from the reply is sent', async ({ page }) => {
      const secretish = '0x' + 'ab'.repeat(32);
      const diagBodies = await openPage(page, {
        platform: 'ios', errorCode: 'generic_error',
        responsePayload: JSON.stringify({ error_code: secretish, reason: 'session_' + 'c'.repeat(128), nullifier: secretish }),
      });
      await page.locator('#verifyButton').click();
      await expect(page.locator('#status')).toHaveClass(/error/, { timeout: 15000 });
      await expect(page.locator('#diagUpstream')).toHaveText('other (other)');
      await expect.poll(() => diagBodies.length).toBeGreaterThan(0);
      expect(diagBodies[0].upstreamCode).toBe('other');
      expect(diagBodies[0].upstreamReason).toBe('other');
      expect(JSON.stringify(diagBodies)).not.toMatch(/0x[0-9a-f]{64}|session_c/i);
      await expect(page.locator('body')).not.toContainText(secretish);
    });

    test('nested proof_response error, unknown raw code, key names and request id are captured', async ({ page }) => {
      const before = logged.length;
      const diagBodies = await openPage(page, {
        platform: 'ios', errorCode: 'generic_error',
        responsePayload: JSON.stringify({ proof_response: { error: 'brand_new_code', reason: 'face_auth_unavailable' }, user_presence_completed: false }),
      });
      await page.locator('#verifyButton').click();
      await expect(page.locator('#status')).toHaveClass(/error/, { timeout: 15000 });
      await expect(page.locator('#diagUpstream')).toHaveText('brand_new_code (face_auth_unavailable)');
      expect(await page.evaluate(() => (window as any).__rup)).toBe(false);
      await expect(page.locator('body')).not.toContainText('3f2a9c1e');
      await expect.poll(() => diagBodies.length).toBeGreaterThan(0);
      const sent = diagBodies[0];
      expect(sent.upstreamCode).toBe('other');
      expect(sent.upstreamCodeRaw).toBe('brand_new_code');
      expect(sent.upstreamReason).toBe('face_auth_unavailable');
      expect(sent.payloadKeys).toBe('proof_response,user_presence_completed,proof_response.error,proof_response.reason');
      expect(sent.requestId).toBe('3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8');
      await expect.poll(() => logged.length).toBeGreaterThan(before);
      const entry = logged[logged.length - 1];
      expect(entry.upstreamCodeRaw).toBe('brand_new_code');
      expect(entry.requestId).toBeUndefined();
      expect(entry.bridgeRequestId).toBeUndefined();
    });

    test('world_id_4_not_available explains the upgrade', async ({ page }) => {
      await openPage(page, { platform: 'ios', errorCode: 'world_id_4_not_available' });
      await page.locator('#verifyButton').click();
      const status = page.locator('#status');
      await expect(status).toHaveClass(/error/, { timeout: 15000 });
      await expect(status).toContainText('has not been upgraded to the new World ID yet');
      await expect(page.locator('#diagErrorCode')).toHaveText('world_id_4_not_available');
    });
  });

  test.describe('stale page', () => {
    test.use({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 } });

    test('page is stamped with the served build id and reloads itself when a newer build is served', async ({ page, request }) => {
      const current = await (await request.get(`http://127.0.0.1:${port}/api/ui-build`)).json();
      expect(current.build).toMatch(/^[0-9a-f]{16}$/);
      const html = await (await request.get(`http://127.0.0.1:${port}/enrollment`)).text();
      expect(html).toContain(`const UI_BUILD = '${current.build}';`);
      expect(html).not.toContain('__UI_BUILD_ID__');

      let navigations = 0;
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
      await openPage(page, { platform: 'ios', errorCode: 'generic_error' });
      const before = navigations;
      // Simulate the server having moved on to a newer build while this page stayed open
      await page.route('**/api/ui-build', (route) => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ build: '0123456789abcdef' }),
      }));
      let challengeCalls = 0;
      page.on('request', (r) => { if (r.url().includes('/api/challenge/create') || r.url().includes('/api/enrollment/query')) challengeCalls++; });
      await page.locator('#verifyButton').click();
      await expect.poll(() => navigations).toBeGreaterThan(before);
      expect(challengeCalls).toBe(0);
    });
  });

  test.describe('desktop', () => {
    test.use({ userAgent: DESKTOP_UA, viewport: { width: 1024, height: 768 } });

    test('Telegram Desktop hides the same-device button and its step', async ({ page }) => {
      await openPage(page, { platform: 'tdesktop', errorCode: '__pending__' });
      await page.locator('#verifyButton').click();
      await expect(page.locator('#qrCode canvas, #qrCode img').first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator('#qrSteps')).toBeVisible();
      await expect(page.locator('#connectorLink')).toBeHidden();
      await expect(page.locator('#qrStepSameDevice')).toBeHidden();
      await expect(page.locator('#qrSteps li:visible')).toHaveCount(2);
      await expect(page.locator('#status')).toHaveText('Waiting for World ID. Keep this page open.');
    });

    test('desktop user agent without a Telegram desktop platform keeps the button (no guessing)', async ({ page }) => {
      const diagBodies = await openPage(page, { platform: 'unknown-client', errorCode: 'user_rejected' });
      await page.locator('#verifyButton').click();
      await expect(page.locator('#status')).toHaveClass(/error/, { timeout: 15000 });
      await expect(page.locator('#status')).toContainText('cancelled in World ID');
      await expect(page.locator('#connectorLink')).not.toHaveClass(/hidden/);
      await expect.poll(() => diagBodies.length).toBeGreaterThan(0);
      expect(diagBodies[0].deviceClass).toBe('desktop');
      expect(diagBodies[0].tgPlatform).toBe('unknown');
    });
  });
});
