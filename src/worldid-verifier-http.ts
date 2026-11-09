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

    // Official primary endpoint (override only for explicit test transport injection)
    this.baseUrl = config.baseUrlOverride ?? 'https://developer.world.org';
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
    // Validate expectedContext at runtime FIRST (fail-closed on malformed server state)
    if (!expectedContext || typeof expectedContext !== 'object') {
      return { success: false, error: 'Invalid expectedContext: must be object' };
    }
    if (!expectedContext.nonce || typeof expectedContext.nonce !== 'string' || expectedContext.nonce.length === 0) {
      return { success: false, error: 'Invalid expectedContext.nonce: must be non-empty string' };
    }

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

    // Discriminate between uniqueness and session proofs
    // SECURITY: Use server-expected mode from challenge, not just client shape
    const clientHasSessionShape = 'session_id' in idkitResult && !('action' in idkitResult);
    const clientHasUniquenessShape = 'action' in idkitResult;

    if (!clientHasSessionShape && !clientHasUniquenessShape) {
      return { success: false, error: 'Cannot determine proof type (missing both action and session_id)' };
    }

    // Use server-expected mode if provided (from challenge), otherwise infer from client shape
    const isSessionProof = expectedContext.expectedMode === 'session' 
      || (expectedContext.expectedMode === undefined && clientHasSessionShape);
    const isUniquenessProof = expectedContext.expectedMode === 'uniqueness'
      || (expectedContext.expectedMode === undefined && clientHasUniquenessShape);

    // SECURITY: Reject if client proof shape disagrees with server-expected mode
    if (expectedContext.expectedMode === 'session' && !clientHasSessionShape) {
      return {
        success: false,
        error: 'Proof shape mismatch: expected session proof (has session_id), got uniqueness proof (has action)',
      };
    }
    if (expectedContext.expectedMode === 'uniqueness' && !clientHasUniquenessShape) {
      return {
        success: false,
        error: 'Proof shape mismatch: expected uniqueness proof (has action), got session proof (has session_id)',
      };
    }

    if (idkitResult.nonce !== expectedContext.nonce) {
      return {
        success: false,
        error: 'Nonce mismatch: challenge session not bound to this proof',
      };
    }

    const response = idkitResult.responses[0];

    // Validate credential type
    if (expectedContext.requireProofOfHuman !== false) {
      if (response.identifier !== 'proof_of_human' || response.issuer_schema_id !== 1) {
        return {
          success: false,
          error: 'Credential type rejected: proof_of_human required',
        };
      }
    }

    // UNIQUENESS PROOF VALIDATION
    if (isUniquenessProof) {
      // Validate expectedContext for uniqueness proofs
      if (!expectedContext.action || typeof expectedContext.action !== 'string' || expectedContext.action.length === 0) {
        return { success: false, error: 'Invalid expectedContext.action: required for uniqueness proofs' };
      }
      if (!expectedContext.signalHash || typeof expectedContext.signalHash !== 'string' || expectedContext.signalHash.length === 0) {
        return { success: false, error: 'Invalid expectedContext.signalHash: required for uniqueness proofs' };
      }

      // Validate action matches
      if (idkitResult.action !== expectedContext.action) {
        return {
          success: false,
          error: `Action mismatch: expected ${expectedContext.action}, got ${idkitResult.action}`,
        };
      }

      // Validate signal hash
      if (response.signal_hash !== expectedContext.signalHash) {
        return {
          success: false,
          error: 'Signal hash mismatch: proof not bound to expected signal',
        };
      }

      // Validate nullifier field exists (uniqueness proofs)
      if (!('nullifier' in response) || !response.nullifier || !response.nullifier.startsWith('0x')) {
        return {
          success: false,
          error: 'Invalid nullifier: expected 0x-prefixed hex string',
        };
      }
    }

    // SESSION PROOF VALIDATION
    if (isSessionProof) {
      // Session proofs do NOT have action field (per World ID 4.0 spec)
      // Session proofs have session_nullifier tuple, NOT nullifier field
      
      // Validate session_id matches expected (if provided by server)
      if (expectedContext.sessionId && idkitResult.session_id !== expectedContext.sessionId) {
        return {
          success: false,
          error: `Session ID mismatch: expected ${expectedContext.sessionId}, got ${idkitResult.session_id}`,
        };
      }
      
      // Validate session_nullifier tuple exists
      if (!('session_nullifier' in response) || !Array.isArray(response.session_nullifier)) {
        return {
          success: false,
          error: 'Invalid session response: session_nullifier tuple required',
        };
      }

      if (response.session_nullifier.length !== 2) {
        return {
          success: false,
          error: 'Invalid session_nullifier: must be 2-element tuple',
        };
      }

      // Validate both elements are hex strings
      const [sessionNullifier, sessionAction] = response.session_nullifier;
      if (!sessionNullifier || !sessionNullifier.startsWith('0x')) {
        return {
          success: false,
          error: 'Invalid session_nullifier[0]: expected 0x-prefixed hex string',
        };
      }
      if (!sessionAction || !sessionAction.startsWith('0x')) {
        return {
          success: false,
          error: 'Invalid session_nullifier[1]: expected 0x-prefixed hex string',
        };
      }
    }

    // Forward IDKit result as-is to v4 API
    // Per https://docs.world.org/api-reference/developer-portal/verify:
    // - Uniqueness proofs: require protocol_version, nonce, action, responses
    // - Session proofs: require protocol_version, nonce, session_id, responses
    const verifyRequest: V4VerifyRequest = idkitResult;

    // Call v4 Developer Portal API (primary endpoint only, test override explicit)
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

      // Check HTTP status before reading body (fail-closed on non-2xx)
      if (!apiResponse.ok) {
        return {
          success: false,
          error: `Developer Portal returned HTTP ${apiResponse.status}`,
        };
      }

      // Read response body with timeout coverage (bounded consumption)
      let responseText: string;
      try {
        responseText = await apiResponse.text();
      } finally {
        clearTimeout(timeoutId);
      }

      let apiResult: V4VerifyResponse;

      try {
        apiResult = JSON.parse(responseText);
      } catch {
        return { success: false, error: 'Developer Portal returned malformed JSON' };
      }

      // Validate response structure (runtime unknown input boundary)
      if (typeof apiResult !== 'object' || apiResult === null || Array.isArray(apiResult)) {
        return { success: false, error: 'Developer Portal returned invalid response' };
      }

      // Validate top-level success (enum true)
      if (apiResult.success !== true) {
        return {
          success: false,
          error: 'Verification failed (top-level success not true)',
        };
      }

      // Validate response environment matches expected (required per documentation)
      if (!apiResult.environment || typeof apiResult.environment !== 'string') {
        return {
          success: false,
          error: 'Response missing environment field',
        };
      }

      if (apiResult.environment !== this.environment) {
        return {
          success: false,
          error: `Environment mismatch: expected ${this.environment}, response ${apiResult.environment}`,
        };
      }

      // Validate results array exists
      if (!Array.isArray(apiResult.results) || apiResult.results.length === 0) {
        return {
          success: false,
          error: 'Verification response missing results array',
        };
      }

      // Validate all result items are objects with required fields
      for (let i = 0; i < apiResult.results.length; i++) {
        const item = apiResult.results[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return {
            success: false,
            error: `Result item ${i} is not a valid object`,
          };
        }
        if (typeof item.identifier !== 'string' || item.identifier.length === 0) {
          return {
            success: false,
            error: `Result item ${i} has invalid identifier`,
          };
        }
        if (typeof item.success !== 'boolean') {
          return {
            success: false,
            error: `Result item ${i} has invalid success field`,
          };
        }
        // Nullifier field is required for uniqueness proofs, optional for session proofs
        // Session proofs may only return success status (binding verified via session_id)
        if (isUniquenessProof && (typeof item.nullifier !== 'string' || item.nullifier.length === 0)) {
          return {
            success: false,
            error: `Result item ${i} has invalid nullifier`,
          };
        }
      }

      // Check for duplicate identifiers (ambiguous results)
      const identifiers = apiResult.results.map(r => r.identifier);
      const uniqueIdentifiers = new Set(identifiers);
      if (identifiers.length !== uniqueIdentifiers.size) {
        return {
          success: false,
          error: 'Ambiguous response: duplicate credential identifiers',
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

      // UNIQUENESS PROOF: Validate nullifier format and consistency
      if (isUniquenessProof) {
        // Validate nullifier format (strict 256-bit hex validation)
        if (!credentialResult.nullifier || !credentialResult.nullifier.startsWith('0x')) {
          return {
            success: false,
            error: 'Invalid nullifier format: must start with 0x',
          };
        }

        const nullifierHex = credentialResult.nullifier.slice(2);
        if (!/^[0-9a-f]{64}$/i.test(nullifierHex)) {
          return {
            success: false,
            error: 'Invalid nullifier format: must be 0x followed by 64 hex characters (256-bit)',
          };
        }

        // Verify nullifier consistency (strict bounded numerical normalization)
        let requestNullifier: bigint;
        let responseNullifier: bigint;

        try {
          requestNullifier = BigInt(response.nullifier);
          if (requestNullifier < 0n) {
            return { success: false, error: 'Request nullifier is negative' };
          }
          // 2^256 - 1 maximum
          if (requestNullifier > 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn) {
            return { success: false, error: 'Request nullifier exceeds 256-bit maximum' };
          }
        } catch {
          return { success: false, error: 'Request nullifier is not a valid number' };
        }

        try {
          responseNullifier = BigInt(credentialResult.nullifier);
          if (responseNullifier < 0n) {
            return { success: false, error: 'Response nullifier is negative' };
          }
          if (responseNullifier > 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn) {
            return { success: false, error: 'Response nullifier exceeds 256-bit maximum' };
          }
        } catch {
          return { success: false, error: 'Response nullifier is not a valid number' };
        }

        if (requestNullifier !== responseNullifier) {
          return {
            success: false,
            error: 'Nullifier mismatch between request and response',
          };
        }
      }

      // SESSION PROOF: No nullifier validation required
      // API validates session binding cryptographically
      // Service will use session_nullifier tuple from response for replay protection

      // Success: return verified result
      // For uniqueness proofs: return nullifier
      // For session proofs: nullifier may be undefined (service uses session_nullifier from response)
      return {
        success: true,
        nullifier: credentialResult.nullifier || undefined,
        issuerSchemaId: response.issuer_schema_id,
        expiresAtMin: response.expires_at_min,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);

      // Fail-closed result (not generic throw)
      if (error.name === 'AbortError') {
        return { success: false, error: 'Verification request timeout' };
      }

      return { success: false, error: 'Verification service unavailable' };
    }
  }
}
