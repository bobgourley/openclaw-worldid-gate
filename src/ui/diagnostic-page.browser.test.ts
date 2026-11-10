/**
 * Diagnostic A/B page: real served page and real IDKit bundle, with IDKit.request and
 * IDKit.createSession wrapped. Test A succeeds (proof must never leave the page),
 * Test B fails with a nested app reply. No enrollment is written.
 */
import { test, expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

const BOT = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890';
const KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const APP = 'app_staging_0123456789abcdef0123456789ab';
const RP = 'rp_0123456789abcdef';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const SECRET_NULLIFIER = '0x' + 'ab'.repeat(32);

function initDataFor(userId: number): string {
  const user = JSON.stringify({ id: userId, first_name: 'T' });
  const authDate = Math.floor(Date.now() / 1000);
  const k = createHmac('sha256', 'WebAppData').update(BOT).digest();
  const hash = createHmac('sha256', k).update(`auth_date=${authDate}\nuser=${user}`).digest('hex');
  return `user=${encodeURIComponent(user)}&auth_date=${authDate}&hash=${hash}`;
}

const SHIM = `
;(function(){
  var B = window.WorldIDKitBundle;
  window.__calls = [];
  function fake(kind, cfg, outcome){
    return { constraints: async function(){
      window.__calls.push({ kind: kind, action: cfg.action, session_id: cfg.session_id, legacy: cfg.allow_legacy_proofs, rup: cfg.require_user_presence });
      return {
        connectorURI: 'https://world.org/verify?t=test',
        pollOnce: async function(){
          return outcome === 'ok'
            ? { type: 'confirmed', result: { responses: [{ nullifier: '${SECRET_NULLIFIER}', proof: '${SECRET_NULLIFIER}' }] } }
            : { type: 'failed', error: 'generic_error' };
        },
        getDebugReport: function(){ return { transport: 'bridge', request_id: '3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8',
          response_payload: outcome === 'ok' ? undefined : JSON.stringify({ proof_response: { error: 'challenge_failed', reason: 'pcp_missing' } }) }; }
      };
    } };
  }
  B.IDKit.request = function(cfg){ return fake('request', cfg, 'ok'); };
  B.IDKit.createSession = function(cfg){ return fake('createSession', cfg, 'fail'); };
})();`;

test.describe('Diagnostic A/B page', () => {
  let service: any; let base = ''; let bot: any; let enrollmentService: any;
  const sent: any[] = [];
  const consoleLines: string[] = [];
  const originalLog = console.log;

  test.beforeAll(async () => {
    const { WorldIdChallengeAdapter } = await import('../../dist/worldid-challenge-adapter.js');
    const { WorldIdHttpVerifier } = await import('../../dist/worldid-verifier-http.js');
    const { EnrollmentService } = await import('../../dist/enrollment-service-production.js');
    const { HttpService } = await import('../../dist/http-service.js');
    const { TelegramBotHandler } = await import('../../dist/telegram-bot-handler.js');
    const { DiagnosticTokenStore } = await import('../../dist/diagnostic-ab.js');
    const { validateTelegramInitData } = await import('../../dist/telegram-initdata.js');
    const adapter = new WorldIdChallengeAdapter({ appId: APP, rpId: RP, signingKeyHex: KEY, challengeTtlSeconds: 300, environment: 'staging' });
    const verifier = new WorldIdHttpVerifier({ appId: APP, rpId: RP, environment: 'staging', baseUrlOverride: 'http://localhost:9999' });
    enrollmentService = new EnrollmentService({ telegramBotToken: BOT, challengeAdapter: adapter, verificationClient: verifier, action: 'openclaw-enroll-v3', dbPath: ':memory:' });
    const store = new DiagnosticTokenStore();
    bot = new TelegramBotHandler({ botToken: BOT, enrollmentService, enrollmentBaseUrl: 'http://placeholder', diagnosticTokens: store,
      transport: { async sendMessage(chatId: number, text: string, options?: any) { sent.push({ chatId, text, options }); } } as any });
    service = new HttpService({ enrollmentService, telegramBotHandler: bot, port: 0, host: '127.0.0.1', diagnosticAb: {
      store, adapter, actionA: 'openclaw-diag-a',
      verifyInitDataUserId: (d: unknown) => { if (typeof d !== 'string') return null; const r = validateTelegramInitData(d, { botToken: BOT }); return r.valid && r.user ? r.user.id : null; },
    } });
    await service.start();
    base = `http://127.0.0.1:${service.getActualPort()}`;
    console.log = (...a: any[]) => { consoleLines.push(a.map(String).join(' ')); originalLog(...a); };
  });
  test.afterAll(async () => { console.log = originalLog; if (service) await service.stop(); });

  async function openFor(page: Page, userId: number, withToken = true) {
    await bot.handleUpdate({ update_id: userId, message: { message_id: 1, date: 0, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'T' }, text: '/diagtest' } });
    const url: string = sent[sent.length - 1].options.reply_markup.inline_keyboard[0][0].web_app.url;
    const token = url.split('t=')[1];
    const initData = initDataFor(userId);
    await page.route('**/telegram-web-app.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
      body: `window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)}, platform: 'ios', ready(){}, expand(){} } };` }));
    await page.route('**/idkit-bundle.js', async (r) => { const res = await r.fetch(); await r.fulfill({ status: 200, contentType: 'application/javascript', body: (await res.text()) + SHIM }); });
    const bodies: any[] = [];
    page.on('request', (req) => { if (req.url().includes('/api/diagnostic/')) bodies.push({ url: req.url(), body: req.postData() || '' }); });
    await page.goto(`${base}/diagnostic${withToken ? '?t=' + token : ''}`);
    return bodies;
  }

  test.use({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 } });

  test('Test A (no session) and Test B (session only) run with the right request shapes and report safely', async ({ page }) => {
    const userId = 888000111;
    const bodies = await openFor(page, userId);
    expect(page.url()).not.toContain('t=');

    await page.locator('#runA').click();
    await expect(page.locator('#resultA')).toHaveText('Test 1 worked.', { timeout: 15000 });
    await page.locator('#runB').click();
    await expect(page.locator('#resultB')).toContainText('Test 2 failed (challenge_failed, pcp_missing)', { timeout: 15000 });

    const calls = await page.evaluate(() => (window as any).__calls);
    expect(calls[0]).toEqual({ kind: 'request', action: 'openclaw-diag-a', legacy: false, rup: false });
    expect(calls[1]).toEqual({ kind: 'createSession', rup: false });

    const all = bodies.map((b) => b.body).join('\n');
    expect(all).not.toContain(SECRET_NULLIFIER.slice(2));
    const results = bodies.filter((b) => b.url.endsWith('/result')).map((b) => JSON.parse(b.body));
    expect(results[0]).toMatchObject({ test: 'A', outcome: 'success' });
    expect(results[0].requestId).toBeUndefined();
    expect(results[1]).toMatchObject({ test: 'B', outcome: 'failure', upstreamCode: 'challenge_failed', upstreamReason: 'pcp_missing',
      payloadKeys: 'proof_response,proof_response.error,proof_response.reason', requestId: '3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8' });
    await expect.poll(() => consoleLines.filter((l) => l.startsWith('[Diagnostic Test]')).length).toBeGreaterThanOrEqual(2);
    expect(consoleLines.join('\n')).not.toContain('3f2a9c1e-8b7d');
    expect(await enrollmentService.findEnrollment(userId)).toBeNull();

    // Each test is one-time: running A again on the same link is refused
    await page.reload();
    // token was removed from the URL, so the page asks to reopen from the bot
    await expect(page.locator('#pageStatus')).toContainText('open this test from the button the bot sent you');
  });

  test('page without a token does nothing', async ({ page }) => {
    await openFor(page, 888000222, false);
    await expect(page.locator('#pageStatus')).toContainText('open this test from the button the bot sent you');
    await expect(page.locator('#runA')).toBeDisabled();
  });
});
