/**
 * Renewal (session) challenges log the privacy-safe challenge_issued stage,
 * the same as initial enrollment challenges.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';

const TEST_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const TEST_ACTION = 'test-renewal-logging';

function initDataFor(userId: number): string {
  const authDate = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: userId, first_name: 'Test' });
  const dcs = [`auth_date=${authDate}`, `user=${user}`].sort().join('\n');
  const key = createHmac('sha256', 'WebAppData').update(TEST_BOT_TOKEN).digest();
  const hash = createHmac('sha256', key).update(dcs).digest('hex');
  return `auth_date=${authDate}&user=${encodeURIComponent(user)}&hash=${hash}`;
}

test('createSessionChallenge logs challenge_issued with the challenge TTL', async () => {
  const issued: Array<{ correlationId: string; ttl: number }> = [];
  const fakeLogger: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'generateCorrelationId') return () => 'corr-' + (issued.length + 1);
      if (prop === 'logChallengeIssued') return (correlationId: string, ttl: number) => issued.push({ correlationId, ttl });
      return () => undefined;
    },
  });

  const adapter = new WorldIdChallengeAdapter({
    appId: 'app_test_0123456789abcdef', rpId: 'rp_test_0123456789',
    signingKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    challengeTtlSeconds: 300, environment: 'staging',
  });
  const stubVerifier = {
    async verify(proof: any) {
      return { success: true, nullifier: proof.responses[0].nullifier, environment: 'staging' };
    },
  };
  const service = new EnrollmentService({
    telegramBotToken: TEST_BOT_TOKEN, challengeAdapter: adapter, verificationClient: stubVerifier as any,
    action: TEST_ACTION, dbPath: ':memory:', enrollmentTtlSeconds: 432000, diagnosticLogger: fakeLogger,
  });

  const initData = initDataFor(200001);
  const first = await service.createChallenge(initData);
  assert.equal(issued.length, 1, 'enrollment challenge logs challenge_issued');

  const result = await service.completeEnrollment({
    initData,
    idkitResult: {
      protocol_version: '4.0', nonce: first.signedChallenge.nonce, action: TEST_ACTION,
      session_id: 'session_' + '1'.repeat(128),
      responses: [{
        identifier: 'proof_of_human', issuer_schema_id: 1, proof: ['1', '2', '3', '4', '5'],
        nullifier: '0x' + '2'.repeat(64), signal_hash: first.signedChallenge.signalHash,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging',
    } as any,
  });
  assert.equal(result.success, true, 'enrollment completes');

  await service.createSessionChallenge(initData);
  assert.equal(issued.length, 2, 'renewal challenge also logs challenge_issued');
  assert.equal(issued[1].ttl, 300);
  assert.match(issued[1].correlationId, /^corr-/);
});
