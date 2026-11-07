/**
 * Tests for WorldIdChallengeAdapter using throwaway test keys.
 *
 * These tests validate:
 * - Challenge creation with official SDK hashing
 * - Signature structure (65-byte ECDSA with recovery)
 * - Nonce uniqueness across calls
 * - Expiry validation with injected clock
 * - Constructor validation (fail-closed on bad config)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';

// Throwaway test ECDSA key (32 bytes hex, NEVER use in production)
const TEST_SIGNING_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_APP_ID = 'app_staging_test1234567890abcdef';
const TEST_RP_ID = 'rp_test1234567890ab';

describe('WorldIdChallengeAdapter', () => {
  describe('constructor validation', () => {
    it('rejects missing appId', () => {
      assert.throws(
        () => {
          new WorldIdChallengeAdapter({
            appId: '' as any,
            rpId: TEST_RP_ID,
            signingKeyHex: TEST_SIGNING_KEY,
          });
        },
        /invalid appId/i
      );
    });

    it('rejects appId without "app_" prefix', () => {
      assert.throws(
        () => {
          new WorldIdChallengeAdapter({
            appId: 'bad_prefix_1234' as any,
            rpId: TEST_RP_ID,
            signingKeyHex: TEST_SIGNING_KEY,
          });
        },
        /invalid appId/i
      );
    });

    it('rejects missing rpId', () => {
      assert.throws(
        () => {
          new WorldIdChallengeAdapter({
            appId: TEST_APP_ID,
            rpId: '' as any,
            signingKeyHex: TEST_SIGNING_KEY,
          });
        },
        /invalid rpId/i
      );
    });

    it('rejects rpId without "rp_" prefix', () => {
      assert.throws(
        () => {
          new WorldIdChallengeAdapter({
            appId: TEST_APP_ID,
            rpId: 'bad_prefix_123' as any,
            signingKeyHex: TEST_SIGNING_KEY,
          });
        },
        /invalid rpId/i
      );
    });

    it('rejects missing signingKeyHex', () => {
      assert.throws(
        () => {
          new WorldIdChallengeAdapter({
            appId: TEST_APP_ID,
            rpId: TEST_RP_ID,
            signingKeyHex: '' as any,
          });
        },
        /signingKeyHex is required/i
      );
    });

    it('rejects signingKeyHex with wrong length', () => {
      assert.throws(
        () => {
          new WorldIdChallengeAdapter({
            appId: TEST_APP_ID,
            rpId: TEST_RP_ID,
            signingKeyHex: '0123456789abcdef', // Only 8 bytes
          });
        },
        /expected 32 bytes/i
      );
    });

    it('rejects signingKeyHex with non-hex characters', () => {
      assert.throws(
        () => {
          new WorldIdChallengeAdapter({
            appId: TEST_APP_ID,
            rpId: TEST_RP_ID,
            signingKeyHex: 'g123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          });
        },
        /expected 32 bytes/i
      );
    });

    it('accepts valid config with 0x prefix', () => {
      assert.doesNotThrow(() => {
        new WorldIdChallengeAdapter({
          appId: TEST_APP_ID,
          rpId: TEST_RP_ID,
          signingKeyHex: '0x' + TEST_SIGNING_KEY,
        });
      });
    });

    it('accepts valid config without 0x prefix', () => {
      assert.doesNotThrow(() => {
        new WorldIdChallengeAdapter({
          appId: TEST_APP_ID,
          rpId: TEST_RP_ID,
          signingKeyHex: TEST_SIGNING_KEY,
        });
      });
    });
  });

  describe('createChallenge', () => {
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      challengeTtlSeconds: 300,
      environment: 'staging',
    });

    it('creates challenge with all required fields', () => {
      const { signedChallenge, expectedContext } = adapter.createChallenge(
        'test-action',
        'test-signal'
      );

      assert.equal(signedChallenge.appId, TEST_APP_ID);
      assert.equal(signedChallenge.rpId, TEST_RP_ID);
      assert.equal(signedChallenge.action, 'test-action');
      assert.equal(signedChallenge.environment, 'staging');

      // Nonce should be 32 bytes (64 hex + 0x prefix)
      assert.match(signedChallenge.nonce, /^0x[0-9a-f]{64}$/);

      // Signal hash should be 32 bytes (64 hex + 0x prefix)
      assert.match(signedChallenge.signalHash, /^0x[0-9a-f]{64}$/);

      // Signature should be 65 bytes (130 hex + 0x prefix)
      assert.match(signedChallenge.signature, /^0x[0-9a-f]{130}$/);

      // Timestamps should be reasonable
      const now = Math.floor(Date.now() / 1000);
      assert.ok(signedChallenge.createdAt >= now - 5);
      assert.ok(signedChallenge.createdAt <= now + 5);
      assert.equal(signedChallenge.expiresAt, signedChallenge.createdAt + 300);

      // Expected context should match
      assert.equal(expectedContext.action, 'test-action');
      assert.equal(expectedContext.nonce, signedChallenge.nonce);
      assert.equal(expectedContext.signalHash, signedChallenge.signalHash);
    });

    it('generates unique nonces for successive calls', () => {
      const { signedChallenge: challenge1 } = adapter.createChallenge('action1', 'signal1');
      const { signedChallenge: challenge2 } = adapter.createChallenge('action2', 'signal2');

      assert.notEqual(challenge1.nonce, challenge2.nonce);
    });

    it('generates different signal hashes for different signals', () => {
      const { signedChallenge: challenge1 } = adapter.createChallenge('action', 'signal-A');
      const { signedChallenge: challenge2 } = adapter.createChallenge('action', 'signal-B');

      assert.notEqual(challenge1.signalHash, challenge2.signalHash);
    });

    it('generates same signal hash for identical signals', () => {
      const signal = 'deterministic-signal';
      const { signedChallenge: challenge1 } = adapter.createChallenge('action1', signal);
      const { signedChallenge: challenge2 } = adapter.createChallenge('action2', signal);

      // Signal hash should be deterministic (Keccak256-based)
      assert.equal(challenge1.signalHash, challenge2.signalHash);
    });

    it('rejects empty action', () => {
      assert.throws(
        () => {
          adapter.createChallenge('', 'signal');
        },
        /action is required/i
      );
    });

    it('rejects null signal', () => {
      assert.throws(
        () => {
          adapter.createChallenge('action', null as any);
        },
        /signal is required/i
      );
    });

    it('rejects undefined signal', () => {
      assert.throws(
        () => {
          adapter.createChallenge('action', undefined as any);
        },
        /signal is required/i
      );
    });

    it('accepts empty string signal (valid per protocol)', () => {
      assert.doesNotThrow(() => {
        adapter.createChallenge('action', '');
      });
    });

    it('uses custom TTL when provided', () => {
      const customAdapter = new WorldIdChallengeAdapter({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        signingKeyHex: TEST_SIGNING_KEY,
        challengeTtlSeconds: 600, // 10 minutes
      });

      const { signedChallenge } = customAdapter.createChallenge('action', 'signal');
      assert.equal(signedChallenge.expiresAt, signedChallenge.createdAt + 600);
    });

    it('defaults environment to production', () => {
      const prodAdapter = new WorldIdChallengeAdapter({
        appId: TEST_APP_ID,
        rpId: TEST_RP_ID,
        signingKeyHex: TEST_SIGNING_KEY,
      });

      const { signedChallenge } = prodAdapter.createChallenge('action', 'signal');
      assert.equal(signedChallenge.environment, 'production');
    });
  });

  describe('extractNonce', () => {
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
    });

    it('extracts nonce from signed challenge', () => {
      const { signedChallenge } = adapter.createChallenge('action', 'signal');
      const nonce = adapter.extractNonce(signedChallenge);

      assert.equal(nonce, signedChallenge.nonce);
      assert.match(nonce, /^0x[0-9a-f]{64}$/);
    });
  });

  describe('isExpired', () => {
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      challengeTtlSeconds: 100,
    });

    it('returns false for fresh challenge', () => {
      const { signedChallenge } = adapter.createChallenge('action', 'signal');
      const nowSeconds = Math.floor(Date.now() / 1000);

      assert.equal(adapter.isExpired(signedChallenge, nowSeconds), false);
    });

    it('returns false one second before expiry', () => {
      const { signedChallenge } = adapter.createChallenge('action', 'signal');
      const oneSecondBeforeExpiry = signedChallenge.expiresAt - 1;

      assert.equal(adapter.isExpired(signedChallenge, oneSecondBeforeExpiry), false);
    });

    it('returns true at exact expiry timestamp', () => {
      const { signedChallenge } = adapter.createChallenge('action', 'signal');

      assert.equal(adapter.isExpired(signedChallenge, signedChallenge.expiresAt), true);
    });

    it('returns true one second after expiry', () => {
      const { signedChallenge } = adapter.createChallenge('action', 'signal');
      const oneSecondAfterExpiry = signedChallenge.expiresAt + 1;

      assert.equal(adapter.isExpired(signedChallenge, oneSecondAfterExpiry), true);
    });

    it('uses current time when clock not provided', () => {
      const { signedChallenge } = adapter.createChallenge('action', 'signal');

      // Should not be expired immediately after creation
      assert.equal(adapter.isExpired(signedChallenge), false);
    });
  });

  describe('signal hashing compatibility', () => {
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
    });

    it('produces 0x-prefixed 64-char hex signal hash', () => {
      const { signedChallenge } = adapter.createChallenge('action', 'test-signal-123');

      assert.match(signedChallenge.signalHash, /^0x[0-9a-f]{64}$/);
    });

    it('hashes numeric string signals deterministically', () => {
      const { signedChallenge: c1 } = adapter.createChallenge('action', '12345');
      const { signedChallenge: c2 } = adapter.createChallenge('action', '12345');

      assert.equal(c1.signalHash, c2.signalHash);
    });

    it('hashes UTF-8 signals correctly', () => {
      const { signedChallenge } = adapter.createChallenge('action', 'hello-世界');

      // Should not throw and should produce valid hash
      assert.match(signedChallenge.signalHash, /^0x[0-9a-f]{64}$/);
    });
  });

  describe('action isolation', () => {
    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
    });

    it('generates different signatures for same signal with different actions', () => {
      const signal = 'shared-signal';

      const { signedChallenge: c1 } = adapter.createChallenge('action-A', signal);
      const { signedChallenge: c2 } = adapter.createChallenge('action-B', signal);

      // Signal hash should be identical (same signal)
      assert.equal(c1.signalHash, c2.signalHash);

      // But signatures differ (action is part of signed message)
      // NOTE: Nonces also differ, but even with same nonce, signatures would differ due to action
      assert.notEqual(c1.signature, c2.signature);
      assert.notEqual(c1.action, c2.action);
    });
  });
});
