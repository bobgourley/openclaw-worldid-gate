/**
 * IDKit v4 Challenge & Proof Adapter
 *
 * Authentic implementation using official @worldcoin/idkit-core and @worldcoin/idkit-server SDKs.
 * Creates signed RP challenges and validates proof responses against expected context.
 *
 * Protocol reference:
 * - Signal hashing: Keccak256 + field reduction (>> 8), not plain SHA-256
 * - RP signature: ECDSA over version || nonce || created_at || expires_at || [action_hash]
 * - Uniqueness proofs (action-based): one-time nullifier per action
 * - Session proofs (action-free): recurring authentication, not used here
 */

import { hashSignal } from '@worldcoin/idkit-core';
import { signRequest, type RpSignature } from '@worldcoin/idkit-server';

/**
 * Runtime configuration for World ID integration.
 * IDs are not hardcoded; they must be provided at instantiation.
 */
export interface WorldIdChallengeAdapterConfig {
  /** App ID from Developer Portal (e.g., "app_b466e1f63a70a695b6d990d261e31b6a") */
  appId: `app_${string}`;

  /** Relying Party ID from Developer Portal (e.g., "rp_223416a2a76673a1") */
  rpId: `rp_${string}`;

  /**
   * ECDSA signing key (32-byte hex, with or without 0x prefix).
   * NEVER expose this key to clients or version control.
   * For tests, use throwaway test keys; for production, load from secure secret management.
   */
  signingKeyHex: string;

  /** Challenge TTL in seconds (default: 300 = 5 minutes) */
  challengeTtlSeconds?: number;

  /** World ID environment (default: "production") */
  environment?: 'production' | 'staging';
}

/**
 * Signed RP challenge context to send to the client.
 * Client submits this to World App, which validates the signature and includes nonce in proof.
 */
export interface SignedRpChallenge {
  /** App ID for IDKit configuration */
  appId: string;

  /** RP ID for proof verification */
  rpId: string;

  /** 0x-prefixed hex nonce (32 bytes) */
  nonce: string;

  /** Unix timestamp (seconds) when challenge was created */
  createdAt: number;

  /** Unix timestamp (seconds) when challenge expires */
  expiresAt: number;

  /** 65-byte ECDSA signature (0x-prefixed hex) */
  signature: string;

  /** Action identifier for uniqueness proof nullifier isolation */
  action: string;

  /** Expected signal hash (0x-prefixed hex) for proof validation */
  signalHash: string;

  /** World ID environment */
  environment: string;
}

/**
 * Server-side expected verification context (NEVER exposed to client).
 * Passed to WorldIdVerificationClient for strict proof validation.
 */
export interface ExpectedVerificationContext {
  action: string;
  nonce: string;
  signalHash: string;
}

/**
 * Creates signed World ID v4 uniqueness proof challenges with authentic SDK-based signal hashing.
 */
export class WorldIdChallengeAdapter {
  private readonly config: Required<WorldIdChallengeAdapterConfig>;

  constructor(config: WorldIdChallengeAdapterConfig) {
    // Validate required fields
    if (!config.appId || !config.appId.startsWith('app_')) {
      throw new Error('Invalid appId: must start with "app_"');
    }
    if (!config.rpId || !config.rpId.startsWith('rp_')) {
      throw new Error('Invalid rpId: must start with "rp_"');
    }
    if (!config.signingKeyHex || typeof config.signingKeyHex !== 'string') {
      throw new Error('signingKeyHex is required');
    }

    const keyHex = config.signingKeyHex.startsWith('0x')
      ? config.signingKeyHex.slice(2)
      : config.signingKeyHex;

    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error(
        'Invalid signingKeyHex: expected 32 bytes (64 hex characters)'
      );
    }

    this.config = {
      appId: config.appId,
      rpId: config.rpId,
      signingKeyHex: config.signingKeyHex,
      challengeTtlSeconds: config.challengeTtlSeconds ?? 300,
      environment: config.environment ?? 'production',
    };
  }

  /**
   * Creates a signed RP challenge for a uniqueness proof.
   *
   * @param action - Action identifier (arbitrary string, e.g., "enroll-telegram-user-12345")
   * @param signal - Signal to bind to proof (e.g., Telegram user ID)
   * @returns Signed challenge for client + expected context for server verification
   */
  createChallenge(
    action: string,
    signal: string
  ): {
    signedChallenge: SignedRpChallenge;
    expectedContext: ExpectedVerificationContext;
  } {
    if (!action || typeof action !== 'string') {
      throw new Error('action is required and must be a non-empty string');
    }
    if (signal === undefined || signal === null || typeof signal !== 'string') {
      throw new Error('signal is required and must be a string');
    }

    // Use official SDK signal hashing (Keccak256 + field reduction)
    const signalHash = hashSignal(signal);

    // Sign the RP challenge context with action (uniqueness proof mode)
    const rpSignature: RpSignature = signRequest({
      signingKeyHex: this.config.signingKeyHex,
      action,
      ttl: this.config.challengeTtlSeconds,
    });

    const signedChallenge: SignedRpChallenge = {
      appId: this.config.appId,
      rpId: this.config.rpId,
      nonce: rpSignature.nonce,
      createdAt: rpSignature.createdAt,
      expiresAt: rpSignature.expiresAt,
      signature: rpSignature.sig,
      action,
      signalHash,
      environment: this.config.environment,
    };

    const expectedContext: ExpectedVerificationContext = {
      action,
      nonce: rpSignature.nonce,
      signalHash,
    };

    return { signedChallenge, expectedContext };
  }

  /**
   * Extracts the nonce from a signed challenge for storage/lookup.
   */
  extractNonce(signedChallenge: SignedRpChallenge): string {
    return signedChallenge.nonce;
  }

  /**
   * Validates that a challenge has not expired (client-side or server-side check).
   * Does NOT verify signature; signature is validated by World App and verification service.
   */
  isExpired(signedChallenge: SignedRpChallenge, clockNowSeconds?: number): boolean {
    const now = clockNowSeconds ?? Math.floor(Date.now() / 1000);
    return now >= signedChallenge.expiresAt;
  }
}
