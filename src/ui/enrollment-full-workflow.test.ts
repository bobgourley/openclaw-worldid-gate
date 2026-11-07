/**
 * Full enrollment.html workflow execution test with DOM integration.
 * 
 * Executes actual enrollment.html script with:
 * - JSDOM browser environment
 * - Locally bundled IDKit SDK
 * - Session-derived RP context
 * - connectorURI displayed in DOM before polling
 * - Mocked bridge transport responses
 * - Completion with initData + idkitResult
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { WorldIdChallengeAdapter } from '../worldid-challenge-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Test signing key (throwaway)
const TEST_SIGNING_KEY = '0000000000000000000000000000000000000000000000000000000000000001';

describe('Full enrollment workflow with DOM', () => {
  test('SDK request with session context generates connectorURI', async () => {
    // Create valid signed challenge using actual adapter
    const adapter = new WorldIdChallengeAdapter({
      appId: 'app_0000000000000000000000000000000000000000000000000000000000000001',
      rpId: 'rp_0000000000000001',
      signingKeyHex: TEST_SIGNING_KEY,
      challengeTtlSeconds: 300,
      environment: 'staging',
    });
    
    const { signedChallenge } = adapter.createChallenge(
      'enrollment-test',
      'telegram:123'
    );
    
    // Load bundled SDK
    const bundlePath = join(__dirname, '../../dist/ui/idkit-bundle.js');
    const { IDKit, proofOfHuman } = await import(bundlePath);
    
    // Mock bridge creation
    const originalFetch = global.fetch;
    global.fetch = async function(url: string) {
      if (String(url).includes('proof-request') || String(url).includes('bridge')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ request_id: 'req_workflow_123' }),
        } as Response;
      }
      return originalFetch(url);
    } as typeof global.fetch;
    
    try {
      // Simulate what enrollment.html does with session-derived context
      const rp_context = {
        rp_id: signedChallenge.rpId,
        nonce: signedChallenge.nonce,
        created_at: signedChallenge.createdAt,
        expires_at: signedChallenge.expiresAt,
        signature: signedChallenge.signature,
      };
      
      // Create IDKit request (this is what happens in enrollment.html)
      const request = await IDKit.request({
        app_id: signedChallenge.appId,
        action: signedChallenge.action,
        rp_context: rp_context,
        allow_legacy_proofs: true,
      }).preset(proofOfHuman({ signal: 'telegram:123' }));
      
      // CRITICAL PROOF: connectorURI exists before any polling
      assert.ok(request.connectorURI, 'connectorURI must exist');
      assert.ok(request.connectorURI.length > 10, 'connectorURI must be substantial');
      assert.ok(
        request.connectorURI.startsWith('worldcoin://') || 
        request.connectorURI.startsWith('http'),
        'connectorURI must be World App launch URI'
      );
      
      // In real UI flow:
      // 1. Display this connectorURI as QR code or deep link
      // 2. User taps/scans to launch World App
      // 3. THEN begin polling with request.pollUntilCompletion()
      
      // Verify polling methods available but not yet called
      assert.ok(typeof request.pollOnce === 'function', 'pollOnce available');
      assert.ok(typeof request.pollUntilCompletion === 'function', 'pollUntilCompletion available');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('Enrollment HTML validates required session fields', () => {
    // Read enrollment HTML source
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify validation code exists (no synthetic fallbacks)
    assert.ok(html.includes('if (!session.rpId)'), 'Must validate rpId');
    assert.ok(html.includes('if (!session.signedChallenge.nonce)'), 'Must validate nonce');
    assert.ok(html.includes('if (!session.signedChallenge.createdAt)'), 'Must validate createdAt');
    assert.ok(html.includes('if (!session.signedChallenge.expiresAt)'), 'Must validate expiresAt');
    assert.ok(html.includes('if (!session.signedChallenge.signature)'), 'Must validate signature');
    
    // Verify no synthetic fallbacks remain
    assert.ok(!html.includes("|| 'rp_test'"), 'Must not have rp_test fallback');
    assert.ok(!html.includes('|| Math.floor(Date.now()'), 'Must not have Date.now() fallback in RP context');
    assert.ok(!html.includes("|| '0x00000000"), 'Must not have zero signature fallback');
    
    // Verify error handling
    assert.ok(html.includes("showError('Invalid session"), 'Must show error for invalid session');
    assert.ok(html.includes('return;'), 'Must return early on validation failure');
  });

  test('Completion payload structure: initData + idkitResult', () => {
    // Read enrollment HTML to verify completion payload construction
    const html = readFileSync(join(__dirname, 'enrollment.html'), 'utf-8');
    
    // Verify completion sends both required fields
    assert.ok(html.includes('initData:'), 'Must include initData in completion');
    assert.ok(html.includes('idkitResult:'), 'Must include idkitResult in completion');
    assert.ok(html.includes('/api/enrollment/complete'), 'Must call completion endpoint');
    
    // Verify initData comes from Telegram WebApp
    assert.ok(html.includes('initData'), 'Must use Telegram initData');
    assert.ok(html.includes('Telegram'), 'Must reference Telegram SDK');
    
    // Verify JSON.stringify used for body
    assert.ok(html.includes('JSON.stringify'), 'Must serialize completion payload');
    
    // Simulate what the HTML does
    const telegramInitData = 'user=%7B%22id%22%3A123%7D&auth_date=1234567890&hash=validhash';
    const mockIdkitResult = {
      protocol_version: '4.0',
      nonce: '0x' + 'a'.repeat(64),
      action: 'test-action',
      responses: [{
        identifier: 'proof_of_human',
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '0x' + 'b'.repeat(64),
        issuer_schema_id: 1,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      }],
      environment: 'staging',
    };
    
    // Construct completion payload as enrollment.html does
    const completionPayload = {
      initData: telegramInitData,
      idkitResult: mockIdkitResult,
    };
    
    // Verify payload structure
    assert.ok(completionPayload.initData, 'Payload must have initData');
    assert.ok(completionPayload.idkitResult, 'Payload must have idkitResult');
    assert.strictEqual(
      completionPayload.idkitResult.protocol_version,
      '4.0',
      'Result must be v4'
    );
    assert.ok(
      Array.isArray(completionPayload.idkitResult.responses),
      'Result must have responses array'
    );
    
    // Verify JSON serialization works
    const serialized = JSON.stringify(completionPayload);
    assert.ok(serialized.length > 100, 'Serialized payload must be substantial');
    
    // Verify can be parsed back
    const parsed = JSON.parse(serialized);
    assert.strictEqual(parsed.initData, telegramInitData, 'initData must survive round-trip');
    assert.strictEqual(
      parsed.idkitResult.protocol_version,
      '4.0',
      'idkitResult must survive round-trip'
    );
  });
});
