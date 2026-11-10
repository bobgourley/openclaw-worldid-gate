/**
 * Diagnostic A/B tests and failed-poll request id capture.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import {
  DiagnosticTokenStore, assertSafeDiagAction, buildDiagChallenge, DIAG_TOKEN_TTL_MS, DIAG_LINK_COOLDOWN_MS, DIAG_SIGNAL,
} from './diagnostic-ab.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import { EnrollmentService } from './enrollment-service-production.js';
import { HttpService } from './http-service.js';
import { TelegramBotHandler } from './telegram-bot-handler.js';
import { createDiagnosticLogger } from './diagnostic-logger.js';
import { validateTelegramInitData } from './telegram-initdata.js';

const BOT = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890';
const KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const APP = 'app_staging_0123456789abcdef0123456789ab';
const RP = 'rp_0123456789abcdef';
const UUID = '3f2a9c1e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';

function adapter() {
  return new WorldIdChallengeAdapter({ appId: APP, rpId: RP, signingKeyHex: KEY, challengeTtlSeconds: 300, environment: 'staging' });
}
function initDataFor(userId: number): string {
  const user = JSON.stringify({ id: userId, first_name: 'T' });
  const authDate = Math.floor(Date.now() / 1000);
  const dcs = `auth_date=${authDate}\nuser=${user}`;
  const k = createHmac('sha256', 'WebAppData').update(BOT).digest();
  const hash = createHmac('sha256', k).update(dcs).digest('hex');
  return `user=${encodeURIComponent(user)}&auth_date=${authDate}&hash=${hash}`;
}

test('token store: one-time per test, bound to user, cooldown and expiry', () => {
  let now = 1_000_000;
  const store = new DiagnosticTokenStore(() => now);
  const t = store.issue(42)!;
  assert.match(t, /^[0-9a-f]{32}$/);
  assert.equal(store.issue(42), null, 'cooldown blocks a second link');
  assert.equal(store.start(t, 'A', 43), false, 'other user cannot use the token');
  assert.equal(store.start(t, 'A', 42), true);
  assert.equal(store.start(t, 'A', 42), false, 'Test A only once');
  assert.equal(store.start(t, 'B', 42), true);
  assert.equal(store.start(t, 'C', 42), false);
  assert.equal(store.wasStarted(t, 'A', 42), true);
  now += DIAG_LINK_COOLDOWN_MS;
  const t2 = store.issue(42)!;
  assert.equal(store.isLive(t), false, 'new link replaces the old one');
  now += DIAG_TOKEN_TTL_MS;
  assert.equal(store.start(t2, 'A', 42), false, 'expired');
});

test('throwaway action can never be an enrollment action', () => {
  const protectedActions = ['openclaw-enroll-v3', 'openclaw-verify', 'openclaw-enroll-v2'];
  assert.throws(() => assertSafeDiagAction('openclaw-enroll-v3', protectedActions));
  assert.throws(() => assertSafeDiagAction('openclaw-test-a', protectedActions), /diag/);
  assert.throws(() => assertSafeDiagAction('Bad Action', protectedActions));
  assert.doesNotThrow(() => assertSafeDiagAction('openclaw-diag-a', protectedActions));
});

test('challenges: A carries the throwaway action and fixed signal; B is session-only', () => {
  const cfg = { store: new DiagnosticTokenStore(), adapter: adapter(), actionA: 'openclaw-diag-a', verifyInitDataUserId: () => 1 };
  const a = buildDiagChallenge(cfg, 'A');
  assert.equal(a.action, 'openclaw-diag-a');
  assert.equal(a.signal, DIAG_SIGNAL);
  assert.ok(!/telegram/.test(JSON.stringify(a)));
  const b = buildDiagChallenge(cfg, 'B');
  assert.equal(b.action, undefined);
  assert.equal(b.signal, undefined);
  assert.equal(b.rpContext.rp_id, RP);
});

async function startAll() {
  const logDir = mkdtempSync(join(tmpdir(), 'diagab-'));
  chmodSync(logDir, 0o700);
  const diagnosticLogger = createDiagnosticLogger({ logDir, enabled: true });
  const ad = adapter();
  const verifier = new WorldIdHttpVerifier({ appId: APP, rpId: RP, environment: 'staging', baseUrlOverride: 'http://localhost:9999' });
  const enrollmentService = new EnrollmentService({ telegramBotToken: BOT, challengeAdapter: ad, verificationClient: verifier, action: 'openclaw-enroll-v3', dbPath: ':memory:' });
  const store = new DiagnosticTokenStore();
  const sent: any[] = [];
  const bot = new TelegramBotHandler({
    botToken: BOT, enrollmentService, enrollmentBaseUrl: 'https://example.test', diagnosticTokens: store,
    transport: { async sendMessage(chatId: number, text: string, options?: any) { sent.push({ chatId, text, options }); } } as any,
  });
  const diagnosticAb = {
    store, adapter: ad, actionA: 'openclaw-diag-a',
    verifyInitDataUserId: (d: unknown) => {
      if (typeof d !== 'string') return null;
      const r = validateTelegramInitData(d, { botToken: BOT });
      return r.valid && r.user ? r.user.id : null;
    },
  };
  const service = new HttpService({ enrollmentService, telegramBotHandler: bot, diagnosticLogger, diagnosticAb, port: 0, host: '127.0.0.1' });
  await service.start();
  const base = `http://127.0.0.1:${service.getActualPort()}`;
  const fileText = () => readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
  return { service, base, bot, sent, enrollmentService, fileText };
}

async function post(url: string, body: object) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('end to end: /diagtest link, one-time challenges, result logged, no enrollment written', async () => {
  const { service, base, bot, sent, enrollmentService, fileText } = await startAll();
  const origLog = console.log; const lines: string[] = [];
  console.log = (...a: any[]) => { lines.push(a.map(String).join(' ')); };
  try {
    const userId = 777000111;
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'T' }, text: '/diagtest' } } as any);
    assert.equal(sent.length, 1);
    const url: string = sent[0].options.reply_markup.inline_keyboard[0][0].web_app.url;
    assert.match(url, /^https:\/\/example\.test\/diagnostic\?t=[0-9a-f]{32}$/);
    assert.ok(!sent[0].text.includes(String(userId)));
    const token = url.split('t=')[1];
    const initData = initDataFor(userId);

    assert.equal((await post(`${base}/api/diagnostic/challenge`, { token, test: 'A', initData: initDataFor(userId + 1) })).status, 403, 'wrong user');
    assert.equal((await post(`${base}/api/diagnostic/challenge`, { token: 'f'.repeat(32), test: 'A', initData })).status, 403, 'unknown token');
    const ra = await post(`${base}/api/diagnostic/challenge`, { token, test: 'A', initData });
    assert.equal(ra.status, 200);
    const ca = await ra.json();
    assert.equal(ca.action, 'openclaw-diag-a');
    assert.equal((await post(`${base}/api/diagnostic/challenge`, { token, test: 'A', initData })).status, 403, 'A only once');
    const cb = await (await post(`${base}/api/diagnostic/challenge`, { token, test: 'B', initData })).json();
    assert.equal(cb.action, undefined);

    assert.equal((await post(`${base}/api/diagnostic/result`, {
      token, test: 'A', initData, outcome: 'failure', errorCode: 'generic_error', upstreamCode: 'other', upstreamCodeRaw: 'brand_new_code',
      upstreamReason: 'pcp_missing', payloadKeys: 'proof_response.error,proof_response.reason', requestId: UUID, durationMs: 8700, pollCount: 4,
      proof: '0x' + 'ab'.repeat(32), nullifier: '0x' + 'cd'.repeat(32),
    })).status, 204);
    await post(`${base}/api/diagnostic/result`, { token, test: 'B', initData, outcome: 'success', durationMs: 20000, pollCount: 9 });

    const file = fileText();
    assert.match(file, /"stage":"diag_result"/);
    assert.match(file, /"upstreamCodeRaw":"brand_new_code"/);
    assert.match(file, /"upstreamReason":"pcp_missing"/);
    assert.match(file, new RegExp(UUID));
    assert.match(file, /"flow":"diag_b","outcome":"success"/);
    assert.ok(!/0x[0-9a-f]{64}|777000111|telegram:/.test(file), 'no proof, nullifier, or Telegram id in file');
    const consoleText = lines.join('\n');
    assert.ok(consoleText.includes('[Diagnostic Test]'));
    assert.ok(!consoleText.includes(UUID), 'request id stays out of the console log');
    assert.equal(await enrollmentService.findEnrollment(userId), null, 'no enrollment written');

    // Diagnostic page is served without caching
    const page = await fetch(`${base}/diagnostic?t=${token}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
  } finally {
    console.log = origLog;
    await service.stop();
  }
});

test('failed enrollment poll: request id and nested reply detail go only to the private file', async () => {
  const { service, base, fileText } = await startAll();
  const origLog = console.log; const lines: string[] = [];
  console.log = (...a: any[]) => { lines.push(a.map(String).join(' ')); };
  try {
    assert.equal((await post(`${base}/api/diagnostics/client`, {
      event: 'poll_complete', pollCount: 4, durationMs: 8725, finalStatus: 'failure', errorCode: 'generic_error',
      upstreamCode: 'challenge_failed', upstreamReason: 'face_auth_unavailable', payloadKeys: 'proof_response.error,proof_response.reason',
      requestId: UUID, transport: 'bridge', flow: 'enroll',
    })).status, 204);
    await post(`${base}/api/diagnostics/client`, {
      event: 'poll_complete', finalStatus: 'failure', errorCode: 'generic_error', upstreamCode: 'other',
      upstreamCodeRaw: '0x' + 'ab'.repeat(32), requestId: 'not-a-uuid', payloadKeys: 'Bad Keys!',
    });
  } finally {
    console.log = origLog;
    await service.stop();
  }
  const file = fileText();
  assert.match(file, /"stage":"client_poll_failed"/);
  assert.match(file, new RegExp(`"bridgeRequestId":"${UUID}"`));
  assert.match(file, /"upstreamCode":"challenge_failed"/);
  assert.match(file, /"payloadKeys":"proof_response.error,proof_response.reason"/);
  assert.ok(!/0x[0-9a-f]{64}|not-a-uuid|Bad Keys/.test(file));
  const consoleText = lines.join('\n');
  assert.ok(consoleText.includes('"payloadKeys":"proof_response.error,proof_response.reason"'));
  assert.ok(!consoleText.includes(UUID), 'request id not in console line');
});
