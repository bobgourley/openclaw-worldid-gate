/**
 * Production HTTP verification client for World ID Developer Portal API.
 *
 * Forwards IDKitResult intact to real API with strict validation.
 * No invented verification shapes - uses official SDK contracts.
 *
 * @module worldid-verifier-http
 */

import type {
  IDKitResult,
  BackendVerificationResult,
  ExpectedVerificationContext,
  V4VerifyRequest,
  V4VerifyResponse,
} from './worldid-types.js';

/**
 * HTTP verification client configuration.
 */
export interface WorldIdHttpVerifierConfig {
  /** App ID (for constructing RpId, e.g., "app_b466e1f63a70a695b6d990d261e31b6a") */
  appId: `app_${string}`;

  /** RP ID for v4 API (e.g., "rp_223416a2a76673a1") */
  rpId: `rp_${string}`;

  /** Expected environment */
  environment: 'production' | 'staging';

  /** HTTP timeout in milliseconds (default: 10000, min: 100, max: 60000) */
  timeoutMs?: number;

  /** Base URL override for testing (default: uses official endpoints) */
  baseUrlOverride?: string;
}

/**
 * HTTP verification client for Developer Portal API.
 *
 * Forwards IDKitResult to official World ID verification endpoint.
 */
export class WorldIdHttpVerifier {
  private readonly appId: string;
  private readonly rpId: string;
  private readonly environment: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(config: WorldIdHttpVerifierConfig) {
    // Validate app ID
    if (!config.appId || !config.appId.startsWith('app_')) {
      throw new Error('Invalid appId: must start with "app_"');
    }

    // Validate RP ID
    if (!config.rpId || !config.rpId.startsWith('rp_')) {
      throw new Error('Invalid rpId: must start with "rp_"');
    }

    // Validate environment
    if (config.environment !== 'production' && config.environment !== 'staging') {
      throw new Error('Invalid environment: must be "production" or "staging"');
    }

    // Validate timeout bounds
    const timeout = config.timeoutMs ?? 10000;
    if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000) {
      throw new Error('Invalid timeoutMs: must be 100-60000');
    }

    this.appId = config.appId;
    this.rpId = config.rpId;
    this.environment = config.environment;
    this.timeoutMs = timeout;

    // Official endpoints (override only for testing)
    this.baseUrl = config.baseUrlOverride ?? 'https://developer.worldcoin.org';
  }

  /**
   * Verify World ID proof via v4 Developer Portal API.
   *
   * Forwards IDKitResult as-is per official documentation.
   * Source: https://docs.world.org/world-id/idkit/integrate.md
   * Source: https://docs.world.org/api-reference/developer-portal/verify.md
   *
   * @param idkitResult - IDKit result from World App (forwarded as-is)
   * @param expectedContext - Server-trusted expected context
   * @returns Verification result
   */
  async verify(
    idkitResult: IDKitResult,
    expectedContext: ExpectedVerificationContext
  ): Promise<BackendVerificationResult> {
    // Validate IDKitResult structure (fail-closed)
    if (!idkitResult || typeof idkitResult !== 'object') {
      return { success: false, error: 'Invalid idkitResult: expected object' };
    }

    if (idkitResult.protocol_version !== '4.0') {
      return { success: false, error: 'Unsupported protocol version (expected 4.0)' };
    }

    if (idkitResult.environment !== this.environment) {
      return {
        success: false,
        error: `Environment mismatch: expected ${this.environment}, got ${idkitResult.environment}`,
      };
    }

    if (!Array.isArray(idkitResult.responses) || idkitResult.responses.length === 0) {
      return { success: false, error: 'Invalid idkitResult: responses array required' };
    }

    // Conservative policy: single credential response only
    if (idkitResult.responses.length > 1) {
      return { success: false, error: 'Ambiguous multi-response batch (policy: single credential)' };
    }

    // Validate server-trusted expected context matches IDKitResult
    if (idkitResult.action !== expectedContext.action) {
      return {
        success: false,
        error: `Action mismatch: expected ${expectedContext.action}, got ${idkitResult.action}`,
      };
    }

    if (idkitResult.nonce !== expectedContext.nonce) {
      return {
        success: false,
        error: 'Nonce mismatch: challenge session not bound to this proof',
      };
    }

    const response = idkitResult.responses[0];

    // Validate signal hash if provided
    if (expectedContext.signalHash) {
      if (response.signal_hash !== expectedContext.signalHash) {
        return {
          success: false,
          error: 'Signal hash mismatch: proof not bound to expected signal',
        };
      }
    }

    // Validate credential type
    if (expectedContext.requireProofOfHuman !== false) {
      if (response.identifier !== 'proof_of_human' || response.issuer_schema_id !== 1) {
        return {
          success: false,
          error: 'Credential type rejected: proof_of_human required',
        };
      }
    }

    // Validate nullifier format (0x-prefixed hex)
    if (!response.nullifier || !response.nullifier.startsWith('0x')) {
      return {
        success: false,
        error: 'Invalid nullifier: expected 0x-prefixed hex string',
      };
    }

    // Forward IDKit result as-is to v4 API (no field remapping required)
    const verifyRequest: V4VerifyRequest = idkitResult;

    // Call v4 Developer Portal API
    const endpoint = `${this.baseUrl}/api/v4/verify/${this.rpId}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const apiResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(verifyRequest),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Read response body completely (bounded timeout)
      const responseText = await apiResponse.text();
      let apiResult: V4VerifyResponse;

      try {
        apiResult = JSON.parse(responseText);
      } catch {
        return { success: false, error: 'Developer Portal returned malformed JSON' };
      }

      // Validate response structure
      if (typeof apiResult !== 'object' || apiResult === null) {
        return { success: false, error: 'Developer Portal returned invalid response' };
      }

      // Validate top-level success (enum true)
      if (apiResult.success !== true) {
        return {
          success: false,
          error: 'Verification failed (top-level success not true)',
        };
      }

      // Validate results array exists
      if (!Array.isArray(apiResult.results) || apiResult.results.length === 0) {
        return {
          success: false,
          error: 'Verification response missing results array',
        };
      }

      // Find matching credential result
      const credentialResult = apiResult.results.find(r => r.identifier === response.identifier);

      if (!credentialResult) {
        return {
          success: false,
          error: `Credential result not found for identifier: ${response.identifier}`,
        };
      }

      // REQUIRED: Check per-credential success
      if (credentialResult.success !== true) {
        return {
          success: false,
          error: credentialResult.detail || credentialResult.code || 'Credential verification failed',
        };
      }

      // Validate nullifier format (0x-prefixed hex)
      if (!credentialResult.nullifier || !credentialResult.nullifier.startsWith('0x')) {
        return {
          success: false,
          error: 'Invalid nullifier format in response: expected 0x-prefixed hex',
        };
      }

      // Verify nullifier consistency (normalized numerical value)
      const requestNullifier = BigInt(response.nullifier);
      const responseNullifier = BigInt(credentialResult.nullifier);

      if (requestNullifier !== responseNullifier) {
        return {
          success: false,
          error: 'Nullifier mismatch between request and response',
        };
      }

      // Success: return verified nullifier (0x-prefixed hex from response)
      return {
        success: true,
        nullifier: credentialResult.nullifier,
        issuerSchemaId: response.issuer_schema_id,
        expiresAtMin: response.expires_at_min,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        return { success: false, error: 'Verification request timeout' };
      }

      return { success: false, error: 'Verification service unavailable' };
    }
  }
}
