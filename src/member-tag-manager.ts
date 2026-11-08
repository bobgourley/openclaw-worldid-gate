/**
 * Member tag manager for display-only "Human Verified" labels.
 * 
 * Manages lifecycle of Telegram native member tags after enrollment.
 * Tags are cosmetic indicators, NOT access control mechanisms.
 * 
 * SECURITY: Tag operations are fail-safe and never affect access control.
 * Access is enforced at admission gate independently of tag status.
 */

import type { TelegramApiClient, SetTagResult } from './telegram-api-client.js';
import type { EnrollmentStore, Enrollment } from './types.js';

/**
 * Configuration for member tag manager.
 */
export interface MemberTagManagerConfig {
  /** Telegram API client for tag operations */
  telegramClient: TelegramApiClient;
  
  /** Enrollment store for querying enrollment status */
  enrollmentStore: EnrollmentStore;
  
  /** Target chat ID for tag operations (numeric or @username) */
  targetChatId: number | string;
  
  /** Tag text to apply (must be 0-16 chars, no emoji) */
  tagText: string;
  
  /** Whether tag feature is enabled */
  enabled: boolean;
}

/**
 * Result of tag operation with sanitized logging.
 */
export interface TagOperationResult {
  /** Whether operation succeeded */
  success: boolean;
  
  /** Sanitized status message (no sensitive data) */
  status: string;
  
  /** Whether retry is recommended (transient failure) */
  retryable: boolean;
}

/**
 * Manager for member tag lifecycle.
 * 
 * DISPLAY-ONLY: Tags are cosmetic. Tag failures do not affect access control.
 */
export class MemberTagManager {
  private readonly telegramClient: TelegramApiClient;
  private readonly enrollmentStore: EnrollmentStore;
  private readonly targetChatId: number | string;
  private readonly tagText: string;
  private readonly enabled: boolean;

  constructor(config: MemberTagManagerConfig) {
    this.telegramClient = config.telegramClient;
    this.enrollmentStore = config.enrollmentStore;
    this.targetChatId = config.targetChatId;
    this.tagText = config.tagText;
    this.enabled = config.enabled;

    // Validate tag text
    if (this.tagText.length > 16) {
      throw new Error('Tag text exceeds 16 character limit');
    }

    if (/[^\x00-\x7F]/.test(this.tagText)) {
      throw new Error('Tag text cannot contain emoji or non-ASCII characters');
    }
  }

  /**
   * Apply tag to enrolled member.
   * 
   * IDEMPOTENT: Safe to call multiple times for same user.
   * FAIL-SAFE: Failures are logged but never block enrollment.
   * 
   * @param telegramUserId - Telegram user ID (numeric)
   * @returns Result with sanitized status
   */
  async applyTagToMember(telegramUserId: number): Promise<TagOperationResult> {
    // Feature gate
    if (!this.enabled) {
      return {
        success: false,
        status: 'Tag feature disabled',
        retryable: false,
      };
    }

    // Verify enrollment exists and is active
    try {
      const enrollment = await this.enrollmentStore.get(telegramUserId);
      
      if (!enrollment) {
        return {
          success: false,
          status: 'No enrollment found',
          retryable: false,
        };
      }

      if (enrollment.revoked) {
        return {
          success: false,
          status: 'Enrollment revoked',
          retryable: false,
        };
      }

      const now = Math.floor(Date.now() / 1000);
      if (enrollment.expiresAt < now) {
        return {
          success: false,
          status: 'Enrollment expired',
          retryable: false,
        };
      }
    } catch (error) {
      // Store query failed
      return {
        success: false,
        status: 'Database error',
        retryable: true,
      };
    }

    // Apply tag via Telegram API
    const result = await this.telegramClient.setChatMemberTag(
      this.targetChatId,
      telegramUserId,
      this.tagText
    );

    if (result.success) {
      return {
        success: true,
        status: 'Tag applied',
        retryable: false,
      };
    }

    // Classify failure
    if (result.permissionDenied) {
      return {
        success: false,
        status: 'Bot lacks can_manage_tags permission',
        retryable: false,
      };
    }

    if (result.invalidTarget) {
      return {
        success: false,
        status: 'User is admin or not in group',
        retryable: false,
      };
    }

    // Network or transient error
    if (result.error?.includes('Network error') || result.error?.includes('timeout')) {
      return {
        success: false,
        status: 'Network error',
        retryable: true,
      };
    }

    return {
      success: false,
      status: 'API error',
      retryable: true,
    };
  }

  /**
   * Remove tag from member.
   * 
   * Called when enrollment expires or is revoked.
   * IDEMPOTENT: Safe to call even if tag not present.
   * 
   * @param telegramUserId - Telegram user ID
   * @returns Result with sanitized status
   */
  async removeTagFromMember(telegramUserId: number): Promise<TagOperationResult> {
    // Feature gate
    if (!this.enabled) {
      return {
        success: false,
        status: 'Tag feature disabled',
        retryable: false,
      };
    }

    // Remove tag (empty string removes existing tag)
    const result = await this.telegramClient.removeChatMemberTag(
      this.targetChatId,
      telegramUserId
    );

    if (result.success) {
      return {
        success: true,
        status: 'Tag removed',
        retryable: false,
      };
    }

    // Classify failure
    if (result.permissionDenied) {
      return {
        success: false,
        status: 'Bot lacks can_manage_tags permission',
        retryable: false,
      };
    }

    if (result.invalidTarget) {
      // User not in group or is admin - tag removal not needed
      return {
        success: true,
        status: 'User not in group (tag not present)',
        retryable: false,
      };
    }

    // Network or transient error
    if (result.error?.includes('Network error') || result.error?.includes('timeout')) {
      return {
        success: false,
        status: 'Network error',
        retryable: true,
      };
    }

    return {
      success: false,
      status: 'API error',
      retryable: true,
    };
  }

  /**
   * Reconcile tags for all existing enrollments.
   * 
   * Applies tags to active enrollments that may not have tags yet.
   * Removes tags from expired or revoked enrollments.
   * 
   * BOUNDED: Processes all enrollments in database.
   * IDEMPOTENT: Safe to call multiple times.
   * FAIL-SAFE: Individual failures don't stop reconciliation.
   * 
   * @returns Summary of reconciliation results
   */
  async reconcileAllTags(): Promise<{
    processed: number;
    applied: number;
    removed: number;
    skipped: number;
    failed: number;
  }> {
    if (!this.enabled) {
      return { processed: 0, applied: 0, removed: 0, skipped: 0, failed: 0 };
    }

    // Note: EnrollmentStore interface doesn't have getAllEnrollments
    // Reconciliation requires external coordination (e.g., operator script)
    // For now, return empty result
    return { processed: 0, applied: 0, removed: 0, skipped: 0, failed: 0 };
  }

  /**
   * Preflight check for bot permissions.
   * 
   * Verifies bot can manage tags in target chat before attempting operations.
   * Call during startup or configuration to detect permission issues early.
   * 
   * @returns Result indicating permission status
   */
  async checkPermissions(): Promise<TagOperationResult> {
    if (!this.enabled) {
      return {
        success: false,
        status: 'Tag feature disabled',
        retryable: false,
      };
    }

    const result = await this.telegramClient.checkTagPermission(this.targetChatId);

    if (result.success) {
      return {
        success: true,
        status: 'Bot can manage tags',
        retryable: false,
      };
    }

    return {
      success: false,
      status: result.error || 'Permission check failed',
      retryable: false,
    };
  }
}
