/**
 * Pins two SDK facts the enrollment page relies on (installed @worldcoin/idkit-core 4.6.0):
 *
 * 1. The documented hashSignal() export returns the same value IDKit puts in
 *    proof_request.action, so the diagnostics panel can show a real Action Match.
 * 2. A session-creating uniqueness request (our enrollment) cannot accept legacy
 *    World ID 3.0 proofs: the SDK rejects allow_legacy_proofs: true with session_id: 'create'.
 *
 * No network: fetch is stubbed to answer the bridge request creation only.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IDKit, CredentialRequest } from '@worldcoin/idkit-core';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { signRequest } from '@worldcoin/idkit-core/signing';

const ACTION = 'openclaw-enroll-v3';

async function withStubbedBridge<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ request_id: '00000000-0000-4000-8000-000000000000' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function rpContext() {
  const sig = signRequest({ signingKeyHex: '0'.repeat(63) + '1', action: ACTION });
  return { rp_id: 'rp_0123456789abcdef', nonce: sig.nonce, created_at: sig.createdAt, expires_at: sig.expiresAt, signature: sig.sig };
}

test('hashSignal(action) equals proof_request.action in the IDKit debug report', async () => {
  const report: any = await withStubbedBridge(async () => {
    const req = await IDKit.request({
      app_id: 'app_0123456789abcdef0123456789abcdef', action: ACTION, rp_context: rpContext(),
      session_id: 'create', allow_legacy_proofs: false,
    }).constraints(CredentialRequest('proof_of_human', { signal: 'telegram:test' }));
    return req.getDebugReport();
  });
  assert.equal(report.transport, 'bridge');
  assert.equal(report.request_payload.proof_request.action, hashSignal(ACTION));
});

test('SDK refuses legacy proofs on a session-creating enrollment request', async () => {
  await withStubbedBridge(async () => {
    await assert.rejects(
      async () => {
        await IDKit.request({
          app_id: 'app_0123456789abcdef0123456789abcdef', action: ACTION, rp_context: rpContext(),
          session_id: 'create', allow_legacy_proofs: true,
        }).constraints(CredentialRequest('proof_of_human', { signal: 'telegram:test' }));
      },
      /Session-bound uniqueness requires allow_legacy_proofs: false/,
    );
  });
});
