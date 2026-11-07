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
 * Server-trusted expected verification context.
 * 
 * Backend must validate that proof context matches the server's expected challenge session,
 * not client-supplied expectations. This prevents replay and context substitution attacks.
 */
export interface ExpectedVerificationContext {
  /** Expected action string from server's challenge session */
  action: string;
  /** Expected nonce from server's challenge session (bound to short-lived session) */
  nonce: string;
  /** Expected signal hash (bound to requester identity/context, optional) */
  signalHash?: string;
  /** Require proof_of_human credential (issuer_schema_id: 1), reject weaker credentials (default: true) */
  requireProofOfHuman?: boolean;
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
    // Bound timeoutMs to prevent timer leaks and resource exhaustion
    if (config.timeoutMs !== undefined) {
      if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 60000) {
        throw new Error("Invalid timeoutMs: must be finite number between 100 and 60000");
      }
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
   * Security requirements:
   * - Validate proof context (action/nonce/signal) against server-trusted expected values
   * - Enforce exact boolean success === true (reject truthy non-boolean)
   * - Enforce required credential type (proof_of_human with issuer_schema_id 1)
   * - Reject ambiguous multi-response batches unless unambiguous single credential policy
   * - Maintain timeout through complete response body consumption
   *
   * @param request - Complete IDKit result forwarded from frontend
   * @param expectedContext - Server-trusted expected verification context
   * @returns Verification result with nullifier from request or error
   */
  async verify(
    request: WorldIdV4VerifyRequest,
    expectedContext: ExpectedVerificationContext,
  ): Promise<WorldIdVerificationResult> {
    // Runtime validate unknown request input structure
    if (!request || typeof request !== "object") {
      return {
        success: false,
        error: "Invalid request: must be object",
      };
    }

    if (!Array.isArray(request.responses)) {
      return {
        success: false,
        error: "Invalid request: responses must be array",
      };
    }

    // Runtime validate expectedContext structure
    if (!expectedContext || typeof expectedContext !== "object") {
      return {
        success: false,
        error: "Invalid expectedContext: must be object",
      };
    }

    if (typeof expectedContext.action !== "string" || expectedContext.action.length === 0) {
      return {
        success: false,
        error: "Invalid expectedContext: action must be non-empty string",
      };
    }

    if (typeof expectedContext.nonce !== "string" || expectedContext.nonce.length === 0) {
      return {
        success: false,
        error: "Invalid expectedContext: nonce must be non-empty string",
      };
    }

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

    // Validate proof context against server-trusted expected values
    if (request.action !== expectedContext.action) {
      return {
        success: false,
        error: `Action mismatch: expected '${expectedContext.action}', got '${request.action}'`,
      };
    }

    if (request.nonce !== expectedContext.nonce) {
      return {
        success: false,
        error: `Nonce mismatch: expected '${expectedContext.nonce}', got '${request.nonce}'`,
      };
    }

    // Enforce unambiguous single credential (reject multi-response batches)
    if (request.responses.length > 1) {
      return {
        success: false,
        error: `Ambiguous multi-response batch: expected single credential, got ${request.responses.length}`,
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

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        clearTimeout(timeoutId);
        return {
          success: false,
          error: `Developer Portal returned ${response.status}: ${errorText}`,
        };
      }

      let verification: WorldIdVerifyResponse;
      try {
        verification = (await response.json()) as WorldIdVerifyResponse;
      } catch (err) {
        clearTimeout(timeoutId);
        return {
          success: false,
          error: `Invalid JSON in verification response: ${err instanceof Error ? err.message : "parse error"}`,
        };
      }

      // Clear timeout after complete body consumption
      clearTimeout(timeoutId);

      // Require exact boolean true (reject truthy non-boolean like 1 or "true")
      if (verification.success !== true) {
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

      // Enforce required credential type (proof_of_human with issuer_schema_id 1)
      const requireProofOfHuman = expectedContext.requireProofOfHuman ?? true;
      if (requireProofOfHuman) {
        if (firstResponse.identifier !== "proof_of_human") {
          return {
            success: false,
            error: `Weak credential rejected: expected 'proof_of_human', got '${firstResponse.identifier}'`,
          };
        }
        if (firstResponse.issuer_schema_id !== 1) {
          return {
            success: false,
            error: `Weak credential rejected: expected issuer_schema_id 1 (proof_of_human), got ${firstResponse.issuer_schema_id}`,
          };
        }
      }

      // Signal hash validation
      // NOTE: Comparing top-level nonce/action strings alone does not establish
      // cryptographic coverage. Signal binding provides additional context-specific
      // protection, but full protocol-level evidence of cryptographic binding
      // requires understanding World ID's zk-SNARK proof structure (out of scope).
      if (expectedContext.signalHash !== undefined) {
        if (typeof expectedContext.signalHash !== "string" || expectedContext.signalHash.length === 0) {
          return {
            success: false,
            error: "Invalid expectedContext: signalHash must be non-empty string when provided",
          };
        }
        if (firstResponse.signal_hash !== expectedContext.signalHash) {
          return {
            success: false,
            error: `Signal hash mismatch: expected '${expectedContext.signalHash}', got '${firstResponse.signal_hash}'`,
          };
        }
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
      // Clear timeout on any error path
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
