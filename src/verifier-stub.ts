/**
 * TEST-ONLY World ID verification stub
 * 
 * This stub simulates World ID verification responses for testing purposes.
 * It MUST NOT be used in production. Production verification must call
 * the real World ID API: POST https://developer.world.org/api/v4/verify/{rp_id}
 * 
 * Reference: https://docs.world.org/api-reference/developer-portal/verify
 */

import type { WorldIdProof, WorldIdVerifyResult, WorldIdVerifier } from './types.js';

export class WorldIdVerifierStub implements WorldIdVerifier {
  private readonly validNullifiers = new Set<string>();
  private readonly revokedNullifiers = new Set<string>();
  private simulateOutage = false;
  private expectedAction?: string;

  /**
   * TEST-ONLY: Register a nullifier as valid for testing
   */
  addValidNullifier(nullifier: string): void {
    this.validNullifiers.add(nullifier);
  }

  /**
   * TEST-ONLY: Revoke a nullifier for testing
   */
  revokeNullifier(nullifier: string): void {
    this.revokedNullifiers.add(nullifier);
  }

  /**
   * TEST-ONLY: Simulate API outage for testing
   */
  setSimulateOutage(outage: boolean): void {
    this.simulateOutage = outage;
  }

  /**
   * TEST-ONLY: Set expected action for validation
   * 
   * When set, the verifier checks that proof.action matches this value.
   * This simulates the action-scoping security property of World ID proofs.
   */
  setExpectedAction(action: string | undefined): void {
    this.expectedAction = action;
  }

  async verify(proof: WorldIdProof): Promise<WorldIdVerifyResult> {
    if (this.simulateOutage) {
      throw new Error('Simulated World ID API outage');
    }

    if (proof.protocol_version !== '4.0') {
      return {
        success: false,
        code: 'unsupported_protocol',
        detail: 'Only protocol version 4.0 is supported',
      };
    }

    // Action-model gap validation: verify proof action matches expected action
    if (this.expectedAction !== undefined && proof.action !== this.expectedAction) {
      return {
        success: false,
        code: 'action_mismatch',
        detail: `Proof action '${proof.action}' does not match expected action '${this.expectedAction}'`,
      };
    }

    if (!proof.responses || proof.responses.length === 0) {
      return {
        success: false,
        code: 'no_responses',
        detail: 'No responses provided',
      };
    }

    const results = proof.responses.map((response) => {
      if (this.revokedNullifiers.has(response.nullifier)) {
        return {
          identifier: response.identifier,
          success: false,
          code: 'revoked',
          detail: 'Credential has been revoked',
        };
      }

      const now = Math.floor(Date.now() / 1000);
      if (response.expires_at_min && response.expires_at_min <= now) {
        return {
          identifier: response.identifier,
          success: false,
          code: 'expired',
          detail: 'Proof has expired',
        };
      }

      if (!this.validNullifiers.has(response.nullifier)) {
        return {
          identifier: response.identifier,
          success: false,
          code: 'verification_error',
          detail: 'Proof verification failed',
        };
      }

      return {
        identifier: response.identifier,
        success: true,
        nullifier: response.nullifier,
      };
    });

    const allFailed = results.every((r) => !r.success);
    if (allFailed) {
      return {
        success: false,
        code: 'all_verifications_failed',
        detail: 'All proof verifications failed',
        results,
      };
    }

    return {
      success: true,
      results,
    };
  }
}

/**
 * Production World ID verifier (UNIMPLEMENTED)
 * 
 * This would make real HTTPS calls to the World ID API.
 * Implementation requires:
 * - HTTPS client (fetch or similar)
 * - RP ID from configuration
 * - Error handling for network failures
 * - Timeout handling
 * - Retry logic (optional)
 */
export class WorldIdVerifierProduction implements WorldIdVerifier {
  constructor(
    private readonly rpId: string,
    private readonly endpoint = 'https://developer.world.org/api/v4/verify'
  ) {}

  async verify(_proof: WorldIdProof): Promise<WorldIdVerifyResult> {
    throw new Error(
      'Production World ID verification is not implemented. ' +
      'This is a test-only starter. Implementation requires: ' +
      '(1) Real HTTPS client, (2) Production RP ID, (3) Error handling'
    );
  }
}
