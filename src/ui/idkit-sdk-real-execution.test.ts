/**
 * IDKit SDK real execution tests with proper RP context generation.
 * 
 * Uses actual WorldIdChallengeAdapter to generate valid signed RP contexts.
 * Tests SDK with transport interception (no live API calls).
 */

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorldIdChallengeAdapter } from '../worldid-challenge-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(__dirname, '../../dist/ui/idkit-bundle.js');

// Test signing key (throwaway, never used in production)
const TEST_SIGNING_KEY = '0000000000000000000000000000000000000000000000000000000000000001';

// Create test adapter to generate valid RP contexts
function createTestAdapter() {
  return new WorldIdChallengeAdapter({
    appId: 'app_0000000000000000000000000000000000000000000000000000000000000001',
    rpId: 'rp_0000000000000001',
    signingKeyHex: TEST_SIGNING_KEY,
    challengeTtlSeconds: 300,
    environment: 'staging',
  });
}

describe('IDKit SDK execution with valid RP context', () => {
  let originalFetch: typeof global.fetch;
  let IDKit: any;
  let proofOfHuman: any;
  
  beforeEach(async () => {
    originalFetch = global.fetch;
    const module = await import(bundlePath + '?t=' + Date.now());
    IDKit = module.IDKit;
    proofOfHuman = module.proofOfHuman;
  });
  
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('SDK generates connectorURI with adapter-signed RP context', async () => {
    // Generate valid signed RP challenge using actual adapter
    const adapter = createTestAdapter();
    const { signedChallenge } = adapter.createChallenge('test-action', 'test-signal');
    
    // Verify challenge has required fields with correct formats
    assert.ok(signedChallenge.rpId, 'Challenge must have rpId');
    assert.ok(signedChallenge.rpId.startsWith('rp_'), 'rpId must start with rp_');
    assert.strictEqual(signedChallenge.rpId.length, 19, 'rpId must be rp_ + 16 hex chars');
    assert.ok(signedChallenge.appId.startsWith('app_'), 'appId must start with app_');
    assert.ok(signedChallenge.nonce.startsWith('0x'), 'nonce must be 0x-prefixed hex');
    assert.ok(signedChallenge.signature.startsWith('0x'), 'signature must be 0x-prefixed hex');
    
    // Mock bridge creation
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ request_id: 'bridge_req_12345' }),
    })) as typeof global.fetch;
    
    // Execute SDK with adapter-signed context
    const request = await IDKit.request({
      app_id: signedChallenge.appId,
      action: signedChallenge.action,
      rp_context: {
        rp_id: signedChallenge.rpId,
        nonce: signedChallenge.nonce,
        created_at: signedChallenge.createdAt,
        expires_at: signedChallenge.expiresAt,
        signature: signedChallenge.signature,
      },
      allow_legacy_proofs: true,
    }).preset(proofOfHuman({ signal: 'test-signal' }));
    
    // Verify connectorURI exists BEFORE polling
    assert.ok(request, 'Request must be returned');
    assert.ok(request.connectorURI, 'connectorURI must exist');
    assert.strictEqual(typeof request.connectorURI, 'string', 'connectorURI must be string');
    assert.ok(request.connectorURI.length > 0, 'connectorURI must not be empty');
    assert.ok(
      request.connectorURI.startsWith('worldcoin://') || request.connectorURI.startsWith('http'),
      'connectorURI must be valid World App launch URI'
    );
    
    // Verify polling methods exist
    assert.ok(typeof request.pollOnce === 'function', 'pollOnce must exist');
    assert.ok(typeof request.pollUntilCompletion === 'function', 'pollUntilCompletion must exist');
  });

  test('Missing app_id must refuse', async () => {
    const adapter = createTestAdapter();
    const { signedChallenge } = adapter.createChallenge('test', 'signal');
    
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ request_id: 'test' }),
    })) as typeof global.fetch;
    
    await assert.rejects(
      async () => {
        await (IDKit.request as any)({
          // app_id missing
          action: signedChallenge.action,
          rp_context: {
            rp_id: signedChallenge.rpId,
            nonce: signedChallenge.nonce,
            created_at: signedChallenge.createdAt,
            expires_at: signedChallenge.expiresAt,
            signature: signedChallenge.signature,
          },
          allow_legacy_proofs: true,
        }).preset(proofOfHuman());
      },
      /app_id/i,
      'Missing app_id must be rejected'
    );
  });

  test('Invalid app_id format must refuse', async () => {
    const adapter = createTestAdapter();
    const { signedChallenge } = adapter.createChallenge('test', 'signal');
    
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ request_id: 'test' }),
    })) as typeof global.fetch;
    
    await assert.rejects(
      async () => {
        await (IDKit.request as any)({
          app_id: 'not_an_app_id',
          action: signedChallenge.action,
          rp_context: {
            rp_id: signedChallenge.rpId,
            nonce: signedChallenge.nonce,
            created_at: signedChallenge.createdAt,
            expires_at: signedChallenge.expiresAt,
            signature: signedChallenge.signature,
          },
          allow_legacy_proofs: true,
        }).preset(proofOfHuman());
      },
      /app_id/i,
      'Invalid app_id format must be rejected'
    );
  });

  test('Missing rp_id must refuse', async () => {
    const adapter = createTestAdapter();
    const { signedChallenge } = adapter.createChallenge('test', 'signal');
    
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ request_id: 'test' }),
    })) as typeof global.fetch;
    
    await assert.rejects(
      async () => {
        await IDKit.request({
          app_id: signedChallenge.appId,
          action: signedChallenge.action,
          rp_context: {
            // rp_id missing
            nonce: signedChallenge.nonce,
            created_at: signedChallenge.createdAt,
            expires_at: signedChallenge.expiresAt,
            signature: signedChallenge.signature,
          } as any,
          allow_legacy_proofs: true,
        }).preset(proofOfHuman());
      },
      /rp_id|RP ID/i,
      'Missing rp_id must be rejected'
    );
  });

  test('Missing nonce must refuse', async () => {
    const adapter = createTestAdapter();
    const { signedChallenge } = adapter.createChallenge('test', 'signal');
    
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ request_id: 'test' }),
    })) as typeof global.fetch;
    
    await assert.rejects(
      async () => {
        await IDKit.request({
          app_id: signedChallenge.appId,
          action: signedChallenge.action,
          rp_context: {
            rp_id: signedChallenge.rpId,
            // nonce missing
            created_at: signedChallenge.createdAt,
            expires_at: signedChallenge.expiresAt,
            signature: signedChallenge.signature,
          } as any,
          allow_legacy_proofs: true,
        }).preset(proofOfHuman());
      },
      /nonce/i,
      'Missing nonce must be rejected'
    );
  });

  test('Missing signature must refuse', async () => {
    const adapter = createTestAdapter();
    const { signedChallenge } = adapter.createChallenge('test', 'signal');
    
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ request_id: 'test' }),
    })) as typeof global.fetch;
    
    await assert.rejects(
      async () => {
        await IDKit.request({
          app_id: signedChallenge.appId,
          action: signedChallenge.action,
          rp_context: {
            rp_id: signedChallenge.rpId,
            nonce: signedChallenge.nonce,
            created_at: signedChallenge.createdAt,
            expires_at: signedChallenge.expiresAt,
            // signature missing
          } as any,
          allow_legacy_proofs: true,
        }).preset(proofOfHuman());
      },
      /signature/i,
      'Missing signature must be rejected'
    );
  });

  test('connectorURI available before polling', async () => {
    const adapter = createTestAdapter();
    const { signedChallenge } = adapter.createChallenge('uri-test', 'test-signal');
    
    // Mock bridge creation only
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ request_id: 'req_uri_test' }),
    })) as typeof global.fetch;
    
    const request = await IDKit.request({
      app_id: signedChallenge.appId,
      action: signedChallenge.action,
      rp_context: {
        rp_id: signedChallenge.rpId,
        nonce: signedChallenge.nonce,
        created_at: signedChallenge.createdAt,
        expires_at: signedChallenge.expiresAt,
        signature: signedChallenge.signature,
      },
      allow_legacy_proofs: true,
    }).preset(proofOfHuman({ signal: 'test-signal' }));
    
    // CRITICAL: connectorURI must exist BEFORE any poll call
    // This is the World App launch URI that user taps/scans
    assert.ok(request.connectorURI, 'connectorURI must exist immediately after request creation');
    assert.ok(request.connectorURI.length > 10, 'connectorURI must be substantial');
    
    // UI workflow: display connectorURI as QR/link, THEN poll
    // Polling methods exist but haven't been called yet
    assert.ok(typeof request.pollOnce === 'function', 'pollOnce available for later use');
    assert.ok(typeof request.pollUntilCompletion === 'function', 'pollUntilCompletion available for later use');
  });
});
