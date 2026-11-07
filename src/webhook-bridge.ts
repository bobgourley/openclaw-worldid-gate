/**
 * Telegram webhook bridge for World ID gated OpenClaw integration
 * 
 * This is an ALTERNATE INGRESS ROUTE for confined testing.
 * It is NOT proof that all native OpenClaw Telegram plugin paths are gated.
 * 
 * Security architecture:
 * 1. Telegram webhook update arrives (MUST be authenticated via HMAC/signature)
 * 2. Admission gate checks World ID enrollment (fresh, not expired, not revoked)
 * 3. If admitted, dispatch to OpenClaw agent CLI
 * 4. Return bounded response via bot
 * 
 * Default: Bridge is OFF until explicit configuration.
 * 
 * Supported: Text messages from numeric human senders in configured test group
 * Unsupported: All other update types (rejected without dispatch)
 * 
 * Admission boundary: Fresh enrollment check immediately before CLI invocation,
 * after all async waits. Does NOT retroactively kill running agent turns.
 */

import type {
  TelegramUpdate,
  TelegramMessage,
  AdmissionRequest,
  GateConfig,
} from './types.js';
import { AdmissionGate } from './admission-gate.js';
import type { EnrollmentStore } from './types.js';
import type { WorldIdVerifier } from './types.js';
import {
  dispatchToOpenClaw,
  type OpenClawDispatchConfig,
  type DispatchRequest,
} from './openclaw-dispatcher.js';
import { validateTelegramUpdate } from './auth-adapter.js';

export interface WebhookBridgeConfig {
  /** Enable bridge (default: false) */
  enabled: boolean;
  
  /** Telegram bot token for HMAC validation */
  telegramBotToken: string;
  
  /** Configured test group ID (only this group accepted) */
  allowedGroupId: number;
  
  /** Text trigger prefix (e.g., '/test ') */
  triggerPrefix?: string;
  
  /** World ID gate configuration */
  gateConfig: GateConfig;
  
  /** OpenClaw CLI configuration */
  openclawConfig: OpenClawDispatchConfig;
}

export interface WebhookRequest {
  /** Raw update body */
  update: TelegramUpdate;
  
  /** Request signature/HMAC (for validation) */
  signature?: string;
  
  /** Request timestamp */
  timestamp: number;
}

export interface WebhookResponse {
  /** Success flag */
  ok: boolean;
  
  /** Response text (if admitted and processed) */
  text?: string;
  
  /** Error message (if rejected or failed) */
  error?: string;
  
  /** Admission details */
  admission?: {
    allowed: boolean;
    reason: string;
  };
}

/**
 * Webhook bridge orchestrator
 */
export class WebhookBridge {
  private readonly gate: AdmissionGate;
  private processedUpdateIds = new Set<number>();
  private readonly dedupeWindowMs = 300000; // 5 minutes

  constructor(
    private readonly config: WebhookBridgeConfig,
    verifier: WorldIdVerifier,
    enrollmentStore: EnrollmentStore
  ) {
    this.gate = new AdmissionGate(
      config.gateConfig,
      verifier,
      enrollmentStore
    );
  }

  /**
   * Handle incoming webhook request
   */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    // Bridge must be explicitly enabled
    if (!this.config.enabled) {
      return {
        ok: false,
        error: 'Webhook bridge is disabled',
      };
    }

    // Validate update structure
    if (!request.update || typeof request.update.update_id !== 'number') {
      return {
        ok: false,
        error: 'Invalid update structure',
      };
    }

    // Deduplicate (Telegram may retry webhook deliveries)
    if (this.processedUpdateIds.has(request.update.update_id)) {
      return {
        ok: true,
        text: '(duplicate delivery, already processed)',
      };
    }

    // Mark as processed
    this.processedUpdateIds.add(request.update.update_id);
    
    // Clean old entries periodically
    if (this.processedUpdateIds.size > 10000) {
      const cutoff = request.update.update_id - 1000;
      for (const id of this.processedUpdateIds) {
        if (id < cutoff) {
          this.processedUpdateIds.delete(id);
        }
      }
    }

    // Validate Telegram authentication (HMAC/signature check)
    // NOTE: In real deployment, this must validate bot token signature
    const authValid = validateTelegramUpdate(request.update, this.config.telegramBotToken);
    if (!authValid.valid) {
      return {
        ok: false,
        error: `Authentication failed: ${authValid.reason}`,
      };
    }

    // Extract message
    const message = this.extractMessage(request.update);
    if (!message) {
      return {
        ok: false,
        error: 'Unsupported update type (only text messages supported)',
      };
    }

    // Validate sender
    const senderId = message.from?.id;
    if (!senderId) {
      return {
        ok: false,
        error: 'No authenticated human sender (missing from.id)',
      };
    }

    if (message.from?.is_bot) {
      return {
        ok: false,
        error: 'Bot messages not supported',
      };
    }

    if (message.sender_chat) {
      return {
        ok: false,
        error: 'Anonymous channel messages not supported',
      };
    }

    // Validate group
    if (message.chat.id !== this.config.allowedGroupId) {
      return {
        ok: false,
        error: `Group ${message.chat.id} not authorized (only ${this.config.allowedGroupId} allowed)`,
      };
    }

    // Validate text and trigger
    if (!message.text) {
      return {
        ok: false,
        error: 'Non-text messages not supported',
      };
    }

    if (this.config.triggerPrefix && !message.text.startsWith(this.config.triggerPrefix)) {
      // Silent ignore (not an error, just not a test command)
      return {
        ok: true,
      };
    }

    // Check admission (fresh enrollment check at admission boundary)
    const admissionResult = await this.gate.checkAdmission({
      telegramUpdate: request.update,
      timestamp: request.timestamp,
    });

    if (!admissionResult.allowed) {
      return {
        ok: false,
        error: `Admission denied: ${admissionResult.reason}`,
        admission: {
          allowed: false,
          reason: admissionResult.reason,
        },
      };
    }

    // Dispatch to OpenClaw agent CLI
    const dispatchResult = await dispatchToOpenClaw(this.config.openclawConfig, {
      telegramUserId: senderId,
      chatId: message.chat.id,
      text: message.text,
    });

    if (!dispatchResult.success) {
      return {
        ok: false,
        error: `OpenClaw dispatch failed: ${dispatchResult.error}`,
        admission: {
          allowed: true,
          reason: admissionResult.reason,
        },
      };
    }

    return {
      ok: true,
      text: dispatchResult.response,
      admission: {
        allowed: true,
        reason: admissionResult.reason,
      },
    };
  }

  /**
   * Extract supported message from update
   */
  private extractMessage(update: TelegramUpdate): TelegramMessage | null {
    // Only support regular messages (not edited, channel posts, etc.)
    return update.message ?? null;
  }

  /**
   * Get gate metrics for observability
   */
  getMetrics() {
    return this.gate.getMetrics();
  }
}
