/**
 * Client diagnostics: official IDKit error codes and coarse context fields.
 *
 * Regression for a real failure where World App returned generic_error and the
 * server dropped the code because it was missing from the allowlist.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IDKitErrorCodes } from '@worldcoin/idkit-core';
import { HttpService, CLIENT_DIAGNOSTIC_ERROR_CODES, CLIENT_DIAGNOSTIC_UPSTREAM_CODES } from './http-service.js';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';

const TEST_BOT_TOKEN = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890';
const TEST_SIGNING_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const TEST_APP_ID = 'app_staging_0123456789abcdef0123456789ab';
const TEST_RP_ID = 'rp_0123456789abcdef';

async function startService(): Promise<{ service: HttpService; url: string }> {
  const adapter = new WorldIdChallengeAdapter({
    appId: TEST_APP_ID, rpId: TEST_RP_ID, signingKeyHex: TEST_SIGNING_KEY,
    challengeTtlSeconds: 300, environment: 'staging',
  });
  const verifier = new WorldIdHttpVerifier({
    appId: TEST_APP_ID, rpId: TEST_RP_ID, environment: 'staging', baseUrlOverride: 'http://localhost:9999',
  });
  const enrollmentService = new EnrollmentService({
    telegramBotToken: TEST_BOT_TOKEN, challengeAdapter: adapter, verificationClient: verifier,
    action: 'test-action', dbPath: ':memory:',
  });
  const service = new HttpService({ enrollmentService, port: 0, host: '127.0.0.1' });
  await service.start();
  return { service, url: `http://127.0.0.1:${service.getActualPort()}/api/diagnostics/client` };
}

/** Post bodies and capture the "[Client Diagnostics]" lines the server logs. */
async function postAndCapture(bodies: object[]): Promise<{ statuses: number[]; logged: any[]; raw: string[] }> {
  const { service, url } = await startService();
  const originalLog = console.log;
  const logged: any[] = [];
  const raw: string[] = [];
  console.log = (...args: any[]) => {
    if (args[0] === '[Client Diagnostics]') {
      raw.push(String(args[1]));
      logged.push(JSON.parse(args[1]));
    }
  };
  const statuses: number[] = [];
  try {
    for (const body of bodies) {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      statuses.push(res.status);
      assert.equal(await res.text(), '', 'endpoint never echoes input');
    }
  } finally {
    console.log = originalLog;
    await service.stop();
  }
  return { statuses, logged, raw };
}

test('allowlist covers every official IDKitErrorCodes value in the installed SDK', () => {
  const official = Object.values(IDKitErrorCodes) as string[];
  assert.ok(official.includes('generic_error'));
  for (const code of official) {
    assert.ok(CLIENT_DIAGNOSTIC_ERROR_CODES.includes(code), `missing official code ${code}`);
  }
});

test('every official IDKit error code is logged verbatim (generic_error regression)', async () => {
  const official = Object.values(IDKitErrorCodes) as string[];
  // Rate limit is 30/min per IP per service; split across two services.
  const half = Math.ceil(official.length / 2);
  for (const batch of [official.slice(0, half), official.slice(half)]) {
    const { statuses, logged } = await postAndCapture(batch.map((errorCode) => ({
      event: 'poll_complete', pollCount: 9, durationMs: 16129, finalStatus: 'failure',
      lastStatusClass: 'failed', errorCode, timestamp: Date.now(),
    })));
    assert.deepEqual(statuses, batch.map(() => 204));
    assert.deepEqual(logged.map((l) => l.errorCode), batch);
  }
});

test('coarse context fields are logged when they are allowlisted values', async () => {
  const { logged } = await postAndCapture([{
    event: 'poll_complete', pollCount: 9, finalStatus: 'failure', errorCode: 'generic_error',
    transport: 'bridge', deviceClass: 'tablet', tgPlatform: 'ios', entryPath: 'qr', flow: 'enroll',
  }, {
    event: 'poll_complete', pollCount: 3, finalStatus: 'success',
    transport: 'mini_app', deviceClass: 'phone', tgPlatform: 'android', entryPath: 'link', flow: 'renewal',
  }]);
  assert.equal(logged.length, 2);
  assert.equal(logged[0].errorCode, 'generic_error');
  assert.equal(logged[0].transport, 'bridge');
  assert.equal(logged[0].deviceClass, 'tablet');
  assert.equal(logged[0].tgPlatform, 'ios');
  assert.equal(logged[0].entryPath, 'qr');
  assert.equal(logged[0].flow, 'enroll');
  assert.equal(logged[1].transport, 'mini_app');
  assert.equal(logged[1].entryPath, 'link');
  assert.equal(logged[1].flow, 'renewal');
});

test('non-allowlisted context values and free-text codes are dropped, never logged', async () => {
  const { logged, raw } = await postAndCapture([{
    event: 'poll_complete', pollCount: 1,
    errorCode: 'generic_error: user 123456789 at 0xdeadbeef',
    transport: 'bridge?id=abc', deviceClass: 'iPhone15,2', tgPlatform: 'ios 17.4.1',
    entryPath: 'https://world.org/verify?t=secret', flow: 'telegram:123456789',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X)',
  }]);
  assert.equal(logged.length, 1);
  for (const key of ['errorCode', 'transport', 'deviceClass', 'tgPlatform', 'entryPath', 'flow', 'userAgent']) {
    assert.equal(logged[0][key], undefined, `${key} must be dropped`);
  }
  assert.ok(!/123456789|iPhone|Mozilla|secret|deadbeef/.test(raw[0]));
});

test('nullifier_replayed client event is accepted (code only)', async () => {
  const { logged } = await postAndCapture([{ event: 'nullifier_replayed', errorCode: 'nullifier_replayed' }]);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'nullifier_replayed');
  assert.equal(logged[0].errorCode, 'nullifier_replayed');
});

test('raw upstream code and reason are logged only from fixed vocabularies', async () => {
  const { statuses, logged, raw } = await postAndCapture([
    { event: 'poll_complete', errorCode: 'generic_error', upstreamCode: 'challenge_failed', upstreamReason: 'face_challenge_mismatch' },
    { event: 'poll_complete', errorCode: 'generic_error', upstreamCode: 'other', upstreamReason: 'other' },
    { event: 'poll_complete', errorCode: 'generic_error', upstreamCode: '0x' + 'ab'.repeat(32), upstreamReason: 'free text here' },
  ]);
  assert.deepEqual(statuses, [204, 204, 204]);
  assert.equal(logged.length, 3);
  assert.equal(logged[0].upstreamCode, 'challenge_failed');
  assert.equal(logged[0].upstreamReason, 'face_challenge_mismatch');
  assert.equal(logged[1].upstreamCode, 'other');
  assert.equal(logged[2].upstreamCode, undefined);
  assert.equal(logged[2].upstreamReason, undefined);
  assert.ok(!raw.join('').includes('free text'));
  assert.ok(CLIENT_DIAGNOSTIC_UPSTREAM_CODES.includes('challenge_failed'));
  assert.ok(!CLIENT_DIAGNOSTIC_UPSTREAM_CODES.includes('unknown_poll_type'));
});
