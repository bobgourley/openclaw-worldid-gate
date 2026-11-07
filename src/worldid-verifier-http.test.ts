/**
 * HTTP verifier tests with mocked Developer Portal API transport.
 *
 * Tests real verification logic with only HTTP transport mocked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import type { IDKitResult, ExpectedVerificationContext } from './worldid-types.js';

const TEST_APP_ID = 'app_test1234567890abcdef1234567890';

describe('WorldIdHttpVerifier', () => {
  describe('constructor validation', () => {
    it('rejects invalid app ID', () => {
      assert.throws(
        () => {
          new WorldIdHttpVerifier({
            appId: 'invalid' as any,
            environment: 'production',
          });
        },
        /invalid appId/i
      );
    });

    it('rejects invalid environment', () => {
      assert.throws(
        () => {
          new WorldIdHttpVerifier({
            appId: TEST_APP_ID,
            environment: 'invalid' as any,
          });
        },
        /invalid environment/i
      );
    });

    it('validates timeout bounds - too low', () => {
      assert.throws(
        () => {
          new WorldIdHttpVerifier({
            appId: TEST_APP_ID,
            environment: 'production',
            timeoutMs: 99,
          });
        },
        /invalid timeoutMs/i
      );
    });

    it('validates timeout bounds - too high', () => {
      assert.throws(
        () => {
          new WorldIdHttpVerifier({
            appId: TEST_APP_ID,
            environment: 'production',
            timeoutMs: 60001,
          });
        },
        /invalid timeoutMs/i
      );
    });
  });

  describe('verify with real SDK structure validation', () => {
    it('rejects null idkitResult', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        environment: 'staging',
      });

      const expectedContext: ExpectedVerificationContext = {
        action: 'test',
        nonce: '0x123',
        signalHash: '0x456',
        requireProofOfHuman: true,
      };

      const result = await verifier.verify(null as any, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /invalid idkitResult/i);
    });

    it('rejects unsupported protocol version', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        environment: 'staging',
      });

      const idkitResult = {
        protocol_version: '3.0',
        nonce: '0x123',
        action: 'test',
        responses: [{}],
        environment: 'staging',
      } as any;

      const expectedContext: ExpectedVerificationContext = {
        action: 'test',
        nonce: '0x123',
        signalHash: '0x456',
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /unsupported protocol version/i);
    });

    it('rejects environment mismatch', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        environment: 'production',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x123',
        action: 'test',
        responses: [{
          identifier: 'proof_of_human',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '123',
          issuer_schema_id: 1,
          expires_at_min: 0,
        }],
        environment: 'staging', // Mismatch
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test',
        nonce: '0x123',
        signalHash: '0x456',
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /environment mismatch/i);
    });

    it('rejects empty responses array', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        environment: 'staging',
      });

      const idkitResult = {
        protocol_version: '4.0',
        nonce: '0x123',
        action: 'test',
        responses: [], // Empty
        environment: 'staging',
      } as any;

      const expectedContext: ExpectedVerificationContext = {
        action: 'test',
        nonce: '0x123',
        signalHash: '0x456',
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /responses array required/i);
    });

    it('rejects multi-response batch', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        environment: 'staging',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x123',
        action: 'test',
        responses: [
          {
            identifier: 'proof_of_human',
            proof: ['1', '2', '3', '4', '5'],
            nullifier: '123',
            issuer_schema_id: 1,
            expires_at_min: 0,
          },
          {
            identifier: 'selfie',
            proof: ['6', '7', '8', '9', '10'],
            nullifier: '456',
            issuer_schema_id: 11,
            expires_at_min: 0,
          },
        ],
        environment: 'staging',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test',
        nonce: '0x123',
        signalHash: '0x456',
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /ambiguous multi-response/i);
    });

    it('rejects action mismatch', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        environment: 'staging',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x123',
        action: 'wrong-action',
        responses: [{
          identifier: 'proof_of_human',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '123',
          issuer_schema_id: 1,
          expires_at_min: 0,
        }],
        environment: 'staging',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'expected-action',
        nonce: '0x123',
        signalHash: '0x456',
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /action mismatch/i);
    });

    it('rejects nonce mismatch', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        environment: 'staging',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x123',
        action: 'test',
        responses: [{
          identifier: 'proof_of_human',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '123',
          issuer_schema_id: 1,
          expires_at_min: 0,
        }],
        environment: 'staging',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test',
        nonce: '0x456', // Mismatch
        signalHash: '0x789',
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /nonce mismatch/i);
    });

    it('rejects signal hash mismatch', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        environment: 'staging',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x123',
        action: 'test',
        responses: [{
          identifier: 'proof_of_human',
          signal_hash: '0xabc',
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '123',
          issuer_schema_id: 1,
          expires_at_min: 0,
        }],
        environment: 'staging',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test',
        nonce: '0x123',
        signalHash: '0xdef', // Mismatch
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /signal hash mismatch/i);
    });

    it('rejects weak credential when proof_of_human required', async () => {
      const verifier = new WorldIdHttpVerifier({
        appId: TEST_APP_ID,
        environment: 'staging',
      });

      const idkitResult: IDKitResult = {
        protocol_version: '4.0',
        nonce: '0x123',
        action: 'test',
        responses: [{
          identifier: 'selfie',
          signal_hash: '0x456', // Match expected
          proof: ['1', '2', '3', '4', '5'],
          nullifier: '123',
          issuer_schema_id: 11, // Not proof_of_human
          expires_at_min: 0,
        }],
        environment: 'staging',
      };

      const expectedContext: ExpectedVerificationContext = {
        action: 'test',
        nonce: '0x123',
        signalHash: '0x456',
        requireProofOfHuman: true,
      };

      const result = await verifier.verify(idkitResult, expectedContext);

      assert.equal(result.success, false);
      assert.match(result.error!, /proof_of_human required/i);
    });
  });
});
