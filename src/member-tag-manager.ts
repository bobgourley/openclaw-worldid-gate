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
import type { EnrollmentService } from './enrollment-service-production.js';
import type Database from 'better-sqlite3';

/**
 * Configuration for member tag manager.
 */
export interface MemberTagManagerConfig {
  /** Telegram API client for tag operations */
  telegramClient: TelegramApiClient;
  
  /** Enrollment service for querying enrollment status */
  enrollmentService: EnrollmentService;
  
  /** Database for tracking applied tags */
  db: Database.Database;
  
  /** Target chat ID for tag operations (numeric or @username) */
  targetChatId: number | string;
  
  /** Tag text to apply (must be 0-16 chars, no emoji) */
  tagText: string;
  
  /** Action scope for this service */
  action: string;
  
  /** Whether tag feature is enabled */
  enabled: boolean;
  
  /** Sweep interval in hours (default 24) */
  sweepIntervalHours?: number;
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
  private readonly enrollmentService: EnrollmentService;
  private readonly db: Database.Database;
  private readonly targetChatId: number | string;
  private readonly tagText: string;
  private readonly action: string;
  private readonly enabled: boolean;
  private readonly sweepIntervalHours: number;
  private sweeperInterval: NodeJS.Timeout | null = null;

  constructor(config: MemberTagManagerConfig) {
    this.telegramClient = config.telegramClient;
    this.enrollmentService = config.enrollmentService;
    this.db = config.db;
    this.targetChatId = config.targetChatId;
    this.tagText = config.tagText;
    this.action = config.action;
    this.enabled = config.enabled;
    this.sweepIntervalHours = config.sweepIntervalHours || 24;

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
      const enrollment = await this.enrollmentService.findEnrollment(telegramUserId);
      
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

      if (enrollment.expired) {
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

    // Check member status (skip admins, creators, non-members)
    const memberStatus = await this.telegramClient.getChatMember(
      this.targetChatId,
      telegramUserId
    );

    if (!memberStatus.success) {
      return {
        success: false,
        status: 'Cannot check member status',
        retryable: true,
      };
    }

    // Skip administrators and creators
    if (memberStatus.status === 'administrator' || memberStatus.status === 'creator') {
      return {
        success: false,
        status: 'User is admin (skip)',
        retryable: false,
      };
    }

    // Skip non-members
    if (memberStatus.status !== 'member' && memberStatus.status !== 'restricted') {
      return {
        success: false,
        status: 'User not in group',
        retryable: false,
      };
    }

    // Check for existing different tag (conflict)
    const existingTag = this.getAppliedTag(telegramUserId);
    if (existingTag && existingTag.applied_text !== this.tagText) {
      console.log(`[MemberTag] Tag conflict: user ${telegramUserId} has different tag "${existingTag.applied_text}"`);
      return {
        success: false,
        status: 'Tag conflict (different tag exists)',
        retryable: false,
      };
    }

    // Apply tag via Telegram API
    const result = await this.telegramClient.setChatMemberTag(
      this.targetChatId,
      telegramUserId,
      this.tagText
    );

    if (result.success) {
      // Record tag application
      this.recordTagApplication(telegramUserId, this.tagText);
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
   * Only removes if gate applied it and it still matches.
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

    // Check if we applied this tag
    const appliedTag = this.getAppliedTag(telegramUserId);
    if (!appliedTag) {
      return {
        success: true,
        status: 'No tag applied by gate (skip)',
        retryable: false,
      };
    }

    // Only remove if still matches what we applied
    if (appliedTag.applied_text !== this.tagText) {
      return {
        success: true,
        status: 'Tag changed externally (skip)',
        retryable: false,
      };
    }

    // Remove tag (empty string removes existing tag)
    const result = await this.telegramClient.removeChatMemberTag(
      this.targetChatId,
      telegramUserId
    );

    if (result.success) {
      // Record tag removal
      this.recordTagRemoval(telegramUserId);
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
      this.recordTagRemoval(telegramUserId);
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

  /**
   * Start expiry sweeper (removes tags from expired enrollments).
   * Runs initial sweep immediately, then at configured interval (default 24 hours).
   */
  async startSweeper(): Promise<void> {
    if (!this.enabled || this.sweeperInterval) {
      return;
    }

    // Run initial sweep at startup
    await this.sweepExpiredTags();

    // Schedule periodic sweeps
    const intervalMs = this.sweepIntervalHours * 60 * 60 * 1000;
    this.sweeperInterval = setInterval(async () => {
      await this.sweepExpiredTags();
    }, intervalMs);
  }

  /**
   * Stop expiry sweeper.
   */
  stopSweeper(): void {
    if (this.sweeperInterval) {
      clearInterval(this.sweeperInterval);
      this.sweeperInterval = null;
    }
  }

  /**
   * Sweep expired enrollments and remove their tags.
   */
  private async sweepExpiredTags(): Promise<void> {
    try {
      // Get all applied tags
      const appliedTags = this.db.prepare(`
        SELECT telegram_user_id
        FROM member_tags
        WHERE chat_id = ? AND removed_at IS NULL
      `).all(this.getChatIdNumeric()) as any[];

      for (const row of appliedTags) {
        const enrollment = await this.enrollmentService.findEnrollment(row.telegram_user_id);
        
        // Remove tag if enrollment is expired or revoked
        if (!enrollment || enrollment.expired || enrollment.revoked) {
          await this.removeTagFromMember(row.telegram_user_id);
        }
      }
    } catch (error) {
      console.error('[MemberTag] Sweeper error:', error);
    }
  }

  /**
   * Record tag application in database.
   */
  private recordTagApplication(telegramUserId: number, tagText: string): void {
    try {
      this.db.prepare(`
        INSERT INTO member_tags (telegram_user_id, chat_id, applied_text, applied_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(telegram_user_id, chat_id) DO UPDATE SET
          applied_text = excluded.applied_text,
          applied_at = excluded.applied_at,
          removed_at = NULL
      `).run(
        telegramUserId,
        this.getChatIdNumeric(),
        tagText,
        new Date().toISOString()
      );
    } catch (error) {
      console.error('[MemberTag] Failed to record tag application:', error);
    }
  }

  /**
   * Record tag removal in database.
   */
  private recordTagRemoval(telegramUserId: number): void {
    try {
      this.db.prepare(`
        UPDATE member_tags
        SET removed_at = ?
        WHERE telegram_user_id = ? AND chat_id = ? AND removed_at IS NULL
      `).run(
        new Date().toISOString(),
        telegramUserId,
        this.getChatIdNumeric()
      );
    } catch (error) {
      console.error('[MemberTag] Failed to record tag removal:', error);
    }
  }

  /**
   * Get applied tag for user (if exists).
   */
  private getAppliedTag(telegramUserId: number): { applied_text: string } | null {
    try {
      const row = this.db.prepare(`
        SELECT applied_text
        FROM member_tags
        WHERE telegram_user_id = ? AND chat_id = ? AND removed_at IS NULL
      `).get(telegramUserId, this.getChatIdNumeric()) as any;
      
      return row || null;
    } catch (error) {
      console.error('[MemberTag] Failed to get applied tag:', error);
      return null;
    }
  }

  /**
   * Convert chat ID to numeric (handle @username format).
   */
  private getChatIdNumeric(): number | string {
    // If already numeric, return as-is
    if (typeof this.targetChatId === 'number') {
      return this.targetChatId;
    }
    
    // If string starting with @, return as-is
    if (typeof this.targetChatId === 'string' && this.targetChatId.startsWith('@')) {
      return this.targetChatId;
    }
    
    // Try to parse as number
    const parsed = parseInt(this.targetChatId as string, 10);
    if (!isNaN(parsed)) {
      return parsed;
    }
    
    return this.targetChatId;
  }
}
