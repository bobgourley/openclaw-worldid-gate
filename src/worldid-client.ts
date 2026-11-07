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
 */
export interface WorldIdVerifyResponse {
  success: boolean;
  environment: "production" | "staging";
  results?: Array<{
    identifier: string;
    valid: boolean;
    issuer_schema_id: number;
  }>;
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
 */
export interface WorldIdVerificationResult {
  success: boolean;
  nullifier?: string;
  expiresAtMin?: number;
  issuerSchemaId?: number;
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
 * Requirements per official docs:
 * - Must run on trusted backend (never client-side)
 * - Forward complete IDKit result payload as-is
 * - Verify environment matches backend's expected environment
 * - Store nullifier to enforce uniqueness per action
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
   * @param request - Complete IDKit result forwarded from frontend
   * @returns Verification result with nullifier or error
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

      const verification: WorldIdVerifyResponse = await response.json();

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

      // Extract first valid response (typically only one response per request)
      const firstResponse = request.responses[0];
      if (!firstResponse) {
        return {
          success: false,
          error: "No response in request.responses",
        };
      }

      return {
        success: true,
        nullifier: firstResponse.nullifier,
        expiresAtMin: firstResponse.expires_at_min,
        issuerSchemaId: firstResponse.issuer_schema_id,
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
