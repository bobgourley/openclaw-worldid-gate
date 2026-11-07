/**
 * World ID admission gate for OpenClaw Telegram bot
 * 
 * This module implements fail-closed admission control:
 * - Unknown/unverified senders are rejected BEFORE any LLM calls
 * - Rejected requests trigger ZERO conversation history access
 * - Rejected requests execute ZERO downstream tools
 * 
 * CRITICAL TRUST BOUNDARY WARNING:
 * The numeric `message.from.id` in arbitrary JSON is NOT authenticated.
 * This gate assumes updates are received from an authenticated adapter
 * (e.g., OpenClaw gateway validating Telegram Bot API updates).
 * 
 * DO NOT accept arbitrary JSON as authenticated updates. An attacker
 * can craft JSON with any user ID to impersonate enrolled users.
 * 
 * Production requires an authenticated transport adapter that validates
 * updates BEFORE passing them to this gate. See auth-adapter.ts.
 * 
 * Security boundaries:
 * - Admission check happens first, before agent logic
 * - Only authenticated Telegram user IDs with valid World ID enrollment pass
 * - Synthetic test updates are not authenticated live Telegram API updates
 * - Username and display name are NOT used for authentication (mutable, untrusted)
 * - Forwarded/quoted messages do NOT substitute for authenticated sender
 * - Malformed runtime values must fail closed
 */

import type {
  AdmissionRequest,
  AdmissionResult,
  Enrollment,
  EnrollmentStore,
  GateConfig,
  GateMetrics,
  TelegramUpdate,
  WorldIdProof,
  WorldIdVerifier,
} from './types.js';
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import { validateConfig } from './config.js';

export class AdmissionGate {
  private readonly metrics: GateMetrics = {
    llmCallCount: 0,
    historyReadCount: 0,
    historyWriteCount: 0,
    toolExecutionCount: 0,
  };

  private readonly clock: Clock;

  constructor(
    private readonly config: GateConfig,
    private readonly verifier: WorldIdVerifier,
    private readonly enrollmentStore: EnrollmentStore,
    clock?: Clock
  ) {
    // Validate configuration at construction time
    const errors = validateConfig(config);
    if (errors.length > 0) {
      throw new Error(
        `AdmissionGate configuration validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`
      );
    }
    this.clock = clock ?? new SystemClock();
  }

  /**
   * Check admission for a Telegram update
   * 
   * FAIL-CLOSED: Returns allowed=false by default
   * Only explicitly verified enrollments are admitted
   * 
   * WARNING: This assumes the update was received from an authenticated
   * adapter. See auth-adapter.ts for trust boundary requirements.
   */
  async checkAdmission(request: AdmissionRequest): Promise<AdmissionResult> {
    if (!request || !request.telegramUpdate) {
      return {
        allowed: false,
        reason: 'Malformed admission request (missing update)',
      };
    }

    const telegramUserId = this.extractTelegramUserId(request.telegramUpdate);

    if (telegramUserId === null) {
      return {
        allowed: false,
        reason: 'No authenticated Telegram user ID in update',
      };
    }

    if (telegramUserId <= 0) {
      return {
        allowed: false,
        reason: 'Invalid Telegram user ID (must be positive)',
        telegramUserId,
      };
    }

    const enrollment = await this.enrollmentStore.get(telegramUserId);

    if (!enrollment) {
      return {
        allowed: false,
        reason: 'No enrollment found for Telegram user ID',
        telegramUserId,
      };
    }

    if (enrollment.revoked) {
      return {
        allowed: false,
        reason: 'Enrollment has been revoked',
        telegramUserId,
        enrollment,
      };
    }

    const now = this.clock.nowSeconds();
    if (enrollment.expiresAt < now) {
      return {
        allowed: false,
        reason: 'Enrollment has expired',
        telegramUserId,
        enrollment,
      };
    }

    if (enrollment.action !== this.config.action) {
      return {
        allowed: false,
        reason: 'Enrollment action mismatch',
        telegramUserId,
        enrollment,
      };
    }

    return {
      allowed: true,
      reason: 'Valid enrollment',
      telegramUserId,
      enrollment,
    };
  }

  /**
   * Enroll a Telegram user with a World ID proof
   * 
   * WARNING: This is a TEST-ONLY enrollment helper that accepts
   * arbitrary telegramUserId and proof parameters WITHOUT authenticating
   * the binding between them.
   * 
   * INSUFFICIENT FOR PRODUCTION:
   * - Caller-supplied Telegram user ID is not authenticated
   * - Proof possession does not prove Telegram account ownership
   * - No challenge prevents copied proofs
   * - No session binding validates the user controls both identities
   * 
   * Production requires a separate enrollment flow where:
   * 1. User authenticates to Telegram (via bot session or OAuth)
   * 2. User authenticates to World ID (via IDKit proof with nonce)
   * 3. Backend validates both identities independently
   * 4. Backend creates binding only after dual authentication
   * 
   * See AGENTS.md for enrollment challenge protocol requirements.
   */
  async enroll(
    telegramUserId: number,
    proof: WorldIdProof,
    enrollmentTtl?: number
  ): Promise<{ success: boolean; error?: string; enrollment?: Enrollment }> {
    if (telegramUserId <= 0) {
      return {
        success: false,
        error: 'Invalid Telegram user ID (must be positive)',
      };
    }
    if (await this.enrollmentStore.get(telegramUserId)) {
      return {
        success: false,
        error: 'Telegram user ID already enrolled',
      };
    }

    let verifyResult;
    try {
      verifyResult = await this.verifier.verify(proof);
    } catch (error) {
      return {
        success: false,
        error: `Verification service error: ${error instanceof Error ? error.message : 'unknown'}`,
      };
    }

    if (!verifyResult.success) {
      return {
        success: false,
        error: `Verification failed: ${verifyResult.detail || 'unknown'}`,
      };
    }

    const proofOfHumanResponse = verifyResult.results?.find(
      (r) => r.identifier === 'proof_of_human' && r.success
    );

    if (this.config.requireProofOfHuman && !proofOfHumanResponse) {
      return {
        success: false,
        error: 'No valid proof_of_human credential found',
      };
    }

    const response = proofOfHumanResponse || verifyResult.results?.[0];
    if (!response?.nullifier) {
      return {
        success: false,
        error: 'No nullifier in verification result',
      };
    }

    const now = this.clock.nowSeconds();
    const ttl = enrollmentTtl ?? this.config.enrollmentTtlSeconds;
    const enrollment: Enrollment = {
      telegramUserId,
      worldIdNullifier: response.nullifier,
      enrolledAt: now,
      expiresAt: now + ttl,
      action: proof.action,
    };

    await this.enrollmentStore.set(enrollment);

    return {
      success: true,
      enrollment,
    };
  }

  /**
   * Extract authenticated Telegram user ID from update
   * 
   * IMPORTANT: This only extracts the sender's numeric user ID.
   * It does NOT authenticate the update. In production, the OpenClaw
   * gateway receives authenticated updates from Telegram's bot API.
   * 
   * Username and display name are NOT used (mutable, not authenticated).
   * Forwarded/quoted message authors do NOT substitute for the sender.
   */
  private extractTelegramUserId(update: TelegramUpdate): number | null {
    const message =
      update.message ||
      update.edited_message ||
      update.channel_post ||
      update.edited_channel_post;

    if (!message) {
      return null;
    }

    if (message.from && !message.from.is_bot) {
      return message.from.id;
    }

    return null;
  }

  /**
   * Simulate downstream operations that would happen after admission
   * These are NEVER called for rejected requests
   */
  simulateLlmCall(): void {
    this.metrics.llmCallCount++;
  }

  simulateHistoryRead(): void {
    this.metrics.historyReadCount++;
  }

  simulateHistoryWrite(): void {
    this.metrics.historyWriteCount++;
  }

  simulateToolExecution(): void {
    this.metrics.toolExecutionCount++;
  }

  getMetrics(): Readonly<GateMetrics> {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics.llmCallCount = 0;
    this.metrics.historyReadCount = 0;
    this.metrics.historyWriteCount = 0;
    this.metrics.toolExecutionCount = 0;
  }
}
