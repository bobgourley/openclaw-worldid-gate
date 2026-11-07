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
  DeveloperPortalVerifyRequest,
  DeveloperPortalVerifyResponse,
} from './worldid-types.js';

/**
 * HTTP verification client configuration.
 */
export interface WorldIdHttpVerifierConfig {
  /** App ID for Developer Portal (e.g., "app_b466e1f63a70a695b6d990d261e31b6a") */
  appId: `app_${string}`;

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
  private readonly environment: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(config: WorldIdHttpVerifierConfig) {
    // Validate app ID
    if (!config.appId || !config.appId.startsWith('app_')) {
      throw new Error('Invalid appId: must start with "app_"');
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
    this.environment = config.environment;
    this.timeoutMs = timeout;

    // Official endpoints (override only for testing)
    this.baseUrl = config.baseUrlOverride ?? 'https://developer.worldcoin.org';
  }

  /**
   * Verify World ID proof via Developer Portal API.
   *
   * Forwards IDKitResult intact to real API, validates response strictly.
   *
   * @param idkitResult - IDKit result from World App (forwarded intact)
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

    // Build Developer Portal API request
    const verifyRequest: DeveloperPortalVerifyRequest = {
      action: idkitResult.action,
      nullifier_hash: this.formatNullifierForAPI(response.nullifier),
      merkle_root: this.extractMerkleRoot(response.proof),
      proof: this.formatProofForAPI(response.proof),
      credential_type: response.identifier,
      signal_hash: response.signal_hash,
    };

    // Call Developer Portal API
    const endpoint = `${this.baseUrl}/api/v2/verify/${this.appId}`;

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
      let apiResult: DeveloperPortalVerifyResponse;

      try {
        apiResult = JSON.parse(responseText);
      } catch {
        return { success: false, error: 'Developer Portal returned malformed JSON' };
      }

      // Validate response structure
      if (typeof apiResult !== 'object' || apiResult === null) {
        return { success: false, error: 'Developer Portal returned invalid response' };
      }

      // Strict boolean validation (not truthy)
      if (apiResult.success !== true) {
        return {
          success: false,
          error: apiResult.detail || apiResult.code || 'Verification failed',
        };
      }

      // Success: return nullifier from original request (not API response)
      return {
        success: true,
        nullifier: response.nullifier,
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

  /**
   * Format nullifier for Developer Portal API (canonical format: nil_<64-hex>).
   */
  private formatNullifierForAPI(nullifier: string): string {
    // IDKitResult contains decimal string, API expects nil_<hex>
    const nullifierBigInt = BigInt(nullifier);
    const nullifierHex = nullifierBigInt.toString(16).padStart(64, '0');
    return `nil_${nullifierHex}`;
  }

  /**
   * Extract Merkle root from proof array (5th element, decimal string).
   */
  private extractMerkleRoot(proof: string[]): string {
    if (proof.length < 5) {
      throw new Error('Invalid proof: expected at least 5 elements');
    }
    // Convert decimal string to 0x-prefixed hex
    const merkleRootBigInt = BigInt(proof[4]);
    return '0x' + merkleRootBigInt.toString(16).padStart(64, '0');
  }

  /**
   * Format Groth16 proof for Developer Portal API (first 4 elements, 0x-prefixed hex).
   */
  private formatProofForAPI(proof: string[]): string {
    if (proof.length < 4) {
      throw new Error('Invalid proof: expected at least 4 elements');
    }

    // Concatenate first 4 elements as hex
    const proofElements = proof.slice(0, 4).map(element => {
      const elementBigInt = BigInt(element);
      return elementBigInt.toString(16).padStart(64, '0');
    });

    return '0x' + proofElements.join('');
  }
}
