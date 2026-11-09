/**
 * Security regression tests for HTTP verifier.
 *
 * Focused adversarial tests for boundary conditions and attack vectors.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import type { IDKitResult, ExpectedVerificationContext } from './worldid-types.js';

const TEST_APP_ID = 'app_test1234567890abcdef1234567890';
const TEST_RP_ID = 'rp_test1234567890abcdef';

describe('WorldIdHttpVerifier Security Regressions', () => {
  describe('HTTP status validation', () => {
    it('rejects non-2xx response with success: true body', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ success: true, results: [], environment: 'production' }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /HTTP 400/i);
    });

    it('rejects 500 error', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /HTTP 500/i);
    });
  });

  describe('Response environment validation', () => {
    it('rejects response with missing environment field', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [{
            identifier: 'proof_of_human',
            success: true,
            nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          }],
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /missing environment/i);
    });

    it('rejects staging response when expecting production', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [{
            identifier: 'proof_of_human',
            success: true,
            nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          }],
          environment: 'staging',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /environment mismatch.*production.*staging/i);
    });
  });

  describe('Timeout coverage', () => {
    it('times out slow response body streaming', async () => {
      const mockFetch = mock.fn(async (_url: string, options: any) => {
        // Simulate slow body streaming that respects abort signal
        return {
          ok: true,
          status: 200,
          text: async () => {
            return new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                resolve(JSON.stringify({ success: true, results: [], environment: 'production' }));
              }, 200);

              if (options?.signal) {
                options.signal.addEventListener('abort', () => {
                  clearTimeout(timeout);
                  const error = new Error('The operation was aborted');
                  error.name = 'AbortError';
                  reject(error);
                });
              }
            });
          },
        };
      });

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
        timeoutMs: 100, // Short timeout
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /timeout/i);
    });
  });

  describe('Malformed input validation', () => {
    it('rejects null credential result item', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [null],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /result item 0.*not a valid object/i);
    });

    it('rejects array as credential result item', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [['identifier', 'success', 'nullifier']],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /result item 0.*not a valid object/i);
    });

    it('rejects missing identifier in result', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [{
            success: true,
            nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          }],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /result item 0.*invalid identifier/i);
    });

    it('rejects response as array instead of object', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ success: true }]),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /invalid response/i);
    });
  });

  describe('Hex nullifier validation', () => {
    it('rejects nullifier with only 0x prefix (no hex digits)', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [{
            identifier: 'proof_of_human',
            success: true,
            nullifier: '0x',
          }],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /256-bit/i);
    });

    it('rejects nullifier with wrong length (32 hex chars instead of 64)', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [{
            identifier: 'proof_of_human',
            success: true,
            nullifier: '0x1234567890abcdef1234567890abcdef',
          }],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /64 hex characters.*256-bit/i);
    });

    it('rejects nil_ wire format (not 0x)', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [{
            identifier: 'proof_of_human',
            success: true,
            nullifier: 'nil_0000000000000000000000000000000000000000000000000000000000000123',
          }],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /must start with 0x/i);
    });

    it('rejects nullifier with non-hex characters', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [{
            identifier: 'proof_of_human',
            success: true,
            nullifier: '0x123456789GABCDEF123456789GABCDEF123456789GABCDEF123456789GABCDEF',
          }],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /64 hex characters/i);
    });
  });

  describe('Duplicate result detection', () => {
    it('rejects response with duplicate credential identifiers', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [
            {
              identifier: 'proof_of_human',
              success: true,
              nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
            },
            {
              identifier: 'proof_of_human',
              success: false,
              nullifier: '0x0000000000000000000000000000000000000000000000000000000000000456',
            },
          ],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /ambiguous.*duplicate/i);
    });
  });

  describe('Expected context validation', () => {
    it('rejects null expectedContext', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const result = await verifier.verify(idkitResult, null as any);

      assert.equal(result.success, false);
      assert.match(result.error!, /invalid expectedContext/i);
    });

    it('rejects empty signalHash (required server-trusted binding)', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const result = await verifier.verify(idkitResult, {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '',
        expectedMode: 'uniqueness' as const,      } as any);

      assert.equal(result.success, false);
      assert.match(result.error!, /signalHash.*required for uniqueness proofs/i);
    });
  });

  describe('Credential result validation', () => {
    it('rejects when required proof_of_human result has success: false', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [{
            identifier: 'proof_of_human',
            success: false,
            nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
            code: 'invalid_proof',
            detail: 'Proof verification failed',
          }],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /proof verification failed/i);
    });
  });

  describe('Valid v4 fixture', () => {
    it('accepts valid v4 response per documented schema', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          results: [{
            identifier: 'proof_of_human',
            success: true,
            nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          }],
          environment: 'production',
        }),
      }));

      global.fetch = mockFetch as any;

      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        action: 'test-action',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '0x0000000000000000000000000000000000000000000000000000000000000123',
          issuer_schema_id: 1,
          expires_at_min: 9999999999,
        }],
        environment: 'production',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test-action',
        nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        expectedMode: 'uniqueness' as const,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, true);
      assert.equal(result.nullifier, '0x0000000000000000000000000000000000000000000000000000000000000123');
      assert.equal(result.issuerSchemaId, 1);
      assert.equal(result.expiresAtMin, 9999999999);
    });
  });
});
