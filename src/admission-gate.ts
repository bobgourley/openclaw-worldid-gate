/**
 * World ID admission gate for OpenClaw Telegram bot
 * 
 * This module implements fail-closed admission control:
 * - Unknown/unverified senders are rejected BEFORE any LLM calls
 * - Rejected requests trigger ZERO conversation history access
 * - Rejected requests execute ZERO downstream tools
 * 
 * Security boundaries:
 * - Admission check happens first, before agent logic
 * - Only authenticated Telegram user IDs with valid World ID enrollment pass
 * - Synthetic test updates are not authenticated live Telegram API updates
 * - Username and display name are NOT used for authentication (mutable, untrusted)
 * - Forwarded/quoted messages do NOT substitute for authenticated sender
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

export class AdmissionGate {
  private readonly metrics: GateMetrics = {
    llmCallCount: 0,
    historyReadCount: 0,
    historyWriteCount: 0,
    toolExecutionCount: 0,
  };

  constructor(
    private readonly config: GateConfig,
    private readonly verifier: WorldIdVerifier,
    private readonly enrollmentStore: EnrollmentStore
  ) {}

  /**
   * Check admission for a Telegram update
   * 
   * FAIL-CLOSED: Returns allowed=false by default
   * Only explicitly verified enrollments are admitted
   */
  async checkAdmission(request: AdmissionRequest): Promise<AdmissionResult> {
    const telegramUserId = this.extractTelegramUserId(request.telegramUpdate);

    if (!telegramUserId) {
      return {
        allowed: false,
        reason: 'No authenticated Telegram user ID in update',
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

    const now = Math.floor(Date.now() / 1000);
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
   * This validates the proof, checks for duplicates, and stores the enrollment.
   * In production, this would be initiated by a separate enrollment flow
   * (e.g., a web interface where the user authenticates to both Telegram and World ID).
   */
  async enroll(
    telegramUserId: number,
    proof: WorldIdProof,
    enrollmentTtl?: number
  ): Promise<{ success: boolean; error?: string; enrollment?: Enrollment }> {
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

    const now = Math.floor(Date.now() / 1000);
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
