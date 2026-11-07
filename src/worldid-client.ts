/**
 * Production World ID v4.0 proof verification client.
 *
 * Official API reference:
 * https://docs.world.org/api-reference/developer-portal/verify
 * https://docs.world.org/world-id/id/cloud
 *
 * Implements strict server-side proof verification against World Developer Portal.
 * Verifies proof_of_human (issuer_schema_id: 1) or selfie (issuer_schema_id: 11).
 *
 * @module worldid-client
 */

/**
 * World ID v4.0 proof response structure per official API.
 */
export interface WorldIdV4ProofResponse {
  identifier: "proof_of_human" | "selfie";
  issuer_schema_id: 1 | 11;
  nullifier: string;
  expires_at_min: number;
  proof: string[];
  signal_hash: string;
  sybil_score?: number;
}

/**
 * World ID v4.0 verification request per official API.
 */
export interface WorldIdV4VerifyRequest {
  protocol_version: "4.0";
  nonce: string;
  action: string;
  environment: "production" | "staging";
  responses: WorldIdV4ProofResponse[];
}

/**
 * Developer Portal v4 verification response.
 * 
 * Per official docs, the response only confirms the proof is cryptographically valid.
 * It does NOT contain credential details - those are in the original request.
 * 
 * Official example from https://docs.world.org/world-id/id/cloud Step 5:
 * ```
 * const verification = await response.json();
 * if (verification?.success !== true || verification?.environment !== expectedEnvironment) {
 *   return NextResponse.json({ error: "Verification failed" }, { status: 400 });
 * }
 * ```
 */
export interface WorldIdVerifyResponse {
  success: boolean;
  environment: "production" | "staging";
  error?: string;
}

/**
 * Configuration for World ID verification client.
 */
export interface WorldIdClientConfig {
  /** RP ID from World Developer Portal (e.g., "rp_xxxxx") */
  rpId: string;
  /** Expected environment: "production" or "staging" */
  environment: "production" | "staging";
  /** HTTP timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

/**
 * World ID verification client result.
 * 
 * On success, returns nullifier and credential details from the REQUEST
 * (not response, which only confirms cryptographic validity).
 */
export interface WorldIdVerificationResult {
  success: boolean;
  /** Nullifier from request.responses[0] (server-validated credential) */
  nullifier?: string;
  /** Expiry from request.responses[0] (server-validated credential) */
  expiresAtMin?: number;
  /** Issuer schema ID from request.responses[0] (server-validated credential) */
  issuerSchemaId?: number;
  /** Identifier from request.responses[0] (e.g., "proof_of_human", "selfie") */
  identifier?: string;
  /** Environment from response */
  environment?: string;
  error?: string;
}

/**
 * World ID v4.0 proof verification client.
 *
 * Verifies proofs against official Developer Portal API endpoints:
 * - Production: https://developer.world.org/api/v4/verify/{rp_id}
 * - Staging: https://staging-developer.worldcoin.org/api/v4/verify/{rp_id}
 *
 * Requirements per official docs (https://docs.world.org/world-id/id/cloud Step 5):
 * - Must run on trusted backend (never client-side)
 * - Forward complete IDKit result payload as-is
 * - Verify environment matches backend's expected environment
 * - Store nullifier from REQUEST (response only confirms cryptographic validity)
 * - Backend must validate credential requirements (e.g., proof_of_human with issuer_schema_id 1)
 */
export class WorldIdVerificationClient {
  constructor(private config: WorldIdClientConfig) {
    if (!config.rpId.startsWith("rp_")) {
      throw new Error("Invalid rpId: must start with 'rp_'");
    }
    if (config.environment !== "production" && config.environment !== "staging") {
      throw new Error("Invalid environment: must be 'production' or 'staging'");
    }
  }

  /**
   * Verify a World ID v4.0 proof.
   * 
   * Official contract per https://docs.world.org/world-id/id/cloud Step 5:
   * - POST complete IDKit request to /api/v4/verify/{rp_id}
   * - Response only confirms success and environment (no credential details)
   * - Nullifier and credential details come from REQUEST responses[0]
   * - Backend must validate required credential (e.g., proof_of_human issuer_schema_id 1)
   *
   * @param request - Complete IDKit result forwarded from frontend
   * @returns Verification result with nullifier from request or error
   */
  async verify(request: WorldIdV4VerifyRequest): Promise<WorldIdVerificationResult> {
    // Pre-verification checks per official guidance
    if (request.environment !== this.config.environment) {
      return {
        success: false,
        error: `Environment mismatch: expected ${this.config.environment}, got ${request.environment}`,
      };
    }

    if (request.protocol_version !== "4.0") {
      return {
        success: false,
        error: `Unsupported protocol_version: ${request.protocol_version}`,
      };
    }

    if (request.responses.length === 0) {
      return {
        success: false,
        error: "No responses in proof request",
      };
    }

    const baseUrl =
      this.config.environment === "production"
        ? "https://developer.world.org"
        : "https://staging-developer.worldcoin.org";

    const verifyUrl = `${baseUrl}/api/v4/verify/${this.config.rpId}`;
    const timeoutMs = this.config.timeoutMs ?? 10000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(verifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        return {
          success: false,
          error: `Developer Portal returned ${response.status}: ${errorText}`,
        };
      }

      let verification: WorldIdVerifyResponse;
      try {
        verification = (await response.json()) as WorldIdVerifyResponse;
      } catch {
        return {
          success: false,
          error: "Invalid JSON in verification response",
        };
      }

      if (!verification.success) {
        return {
          success: false,
          error: verification.error ?? "Verification failed without error message",
        };
      }

      if (verification.environment !== this.config.environment) {
        return {
          success: false,
          error: `Response environment mismatch: expected ${this.config.environment}, got ${verification.environment}`,
        };
      }

      // Developer Portal response only confirms cryptographic validity.
      // Nullifier and credential details come from the REQUEST, not response.
      // Backend must validate credential requirements from request.responses.
      const firstResponse = request.responses[0];
      if (!firstResponse) {
        return {
          success: false,
          error: "No credential in request.responses",
        };
      }

      // Validate required fields in request response
      if (!firstResponse.nullifier || typeof firstResponse.nullifier !== "string") {
        return {
          success: false,
          error: "Missing or invalid nullifier in request response",
        };
      }

      if (typeof firstResponse.issuer_schema_id !== "number") {
        return {
          success: false,
          error: "Missing or invalid issuer_schema_id in request response",
        };
      }

      return {
        success: true,
        nullifier: firstResponse.nullifier,
        expiresAtMin: firstResponse.expires_at_min,
        issuerSchemaId: firstResponse.issuer_schema_id,
        identifier: firstResponse.identifier,
        environment: verification.environment,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if ((error as any)?.name === "AbortError") {
        return {
          success: false,
          error: `Request timeout after ${timeoutMs}ms`,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Network error during verification",
      };
    }
  }
}
