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
  private featureEnabled: boolean; // Mutable, re-checked on each sweep
  private readonly sweepIntervalHours: number;
  private sweeperInterval: NodeJS.Timeout | null = null;

  constructor(config: MemberTagManagerConfig) {
    this.telegramClient = config.telegramClient;
    this.enrollmentService = config.enrollmentService;
    this.db = config.db;
    this.targetChatId = config.targetChatId;
    this.tagText = config.tagText;
    this.action = config.action;
    this.featureEnabled = config.enabled;
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
    if (!this.featureEnabled) {
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

    // Skip non-members and restricted users with is_member=false
    if (memberStatus.status === 'left' || memberStatus.status === 'kicked') {
      return {
        success: false,
        status: 'User not in group',
        retryable: false,
      };
    }

    if (memberStatus.status === 'restricted' && !memberStatus.isMember) {
      return {
        success: false,
        status: 'User restricted without membership',
        retryable: false,
      };
    }

    // Read member's current tag from Telegram API to check for conflicts
    const currentTag = memberStatus.tag || null;
    
    // Check if there's a different tag we didn't apply
    const ourRecord = this.getAppliedTag(telegramUserId);
    if (currentTag && currentTag !== this.tagText) {
      // Tag exists but doesn't match ours
      if (!ourRecord || ourRecord.applied_text !== currentTag) {
        // We didn't apply this tag - don't overwrite
        console.log('[MemberTag] Tag conflict detected, skip');
        return {
          success: false,
          status: 'Tag conflict (different tag exists)',
          retryable: false,
        };
      }
    }

    // If tag already matches, no need to apply again
    if (currentTag === this.tagText) {
      // Ensure we have a record of it
      if (!ourRecord) {
        this.recordTagApplication(telegramUserId, this.tagText);
      }
      return {
        success: true,
        status: 'Tag already applied',
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
      console.log('[MemberTag] Tag applied');
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

    // Handle rate limiting with retry_after
    if (result.retryAfter) {
      return {
        success: false,
        status: `Rate limited (retry after ${result.retryAfter}s)`,
        retryable: true,
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
   * Only removes if gate applied it and current tag still matches.
   * 
   * @param telegramUserId - Telegram user ID
   * @returns Result with sanitized status
   */
  async removeTagFromMember(telegramUserId: number): Promise<TagOperationResult> {
    // Feature gate
    if (!this.featureEnabled) {
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

    // Read member's current tag from Telegram API
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

    const currentTag = memberStatus.tag || null;

    // Only remove if current tag matches what we applied
    if (currentTag !== appliedTag.applied_text) {
      this.recordTagRemoval(telegramUserId);
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
      console.log('[MemberTag] Tag removed');
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

    // Handle rate limiting
    if (result.retryAfter) {
      return {
        success: false,
        status: `Rate limited (retry after ${result.retryAfter}s)`,
        retryable: true,
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
    if (!this.featureEnabled) {
      return { processed: 0, applied: 0, removed: 0, skipped: 0, failed: 0 };
    }

    let processed = 0;
    let applied = 0;
    let removed = 0;
    let skipped = 0;
    let failed = 0;

    try {
      // Get all enrollments for this action
      const allEnrollments = this.db.prepare(`
        SELECT telegram_user_id, revoked, expires_at
        FROM enrollments
        WHERE action = ?
      `).all(this.action) as Array<{
        telegram_user_id: number;
        revoked: number;
        expires_at: number;
      }>;

      const now = Math.floor(Date.now() / 1000);

      for (const row of allEnrollments) {
        processed++;
        const isExpired = row.expires_at <= now;
        const isRevoked = row.revoked === 1;

        if (isExpired || isRevoked) {
          // Remove tag
          const result = await this.removeTagFromMember(row.telegram_user_id);
          if (result.success && result.status === 'Tag removed') {
            removed++;
          } else if (!result.success && result.retryable) {
            failed++;
          } else {
            skipped++;
          }
        } else {
          // Apply tag (will skip if already present)
          const result = await this.applyTagToMember(row.telegram_user_id);
          if (result.success && (result.status === 'Tag applied' || result.status === 'Tag already applied')) {
            if (result.status === 'Tag applied') {
              applied++;
            } else {
              skipped++;
            }
          } else if (!result.success && result.retryable) {
            failed++;
          } else {
            skipped++;
          }
        }
      }
    } catch (error) {
      console.error('[MemberTag] Reconciliation error');
    }

    return { processed, applied, removed, skipped, failed };
  }

  /**
   * Check bot permissions by calling Telegram API.
   * 
   * Always checks actual permissions regardless of current featureEnabled state.
   * This allows tagging to re-enable itself when permissions are granted.
   * 
   * @param timeoutMs - Optional timeout in milliseconds (default: 5000)
   * @returns Result indicating permission status
   */
  async checkPermissions(timeoutMs: number = 5000): Promise<TagOperationResult> {
    // Always check Telegram, even if currently disabled (allows re-enabling)
    let timeoutHandle: NodeJS.Timeout | undefined;
    
    const timeoutPromise = new Promise<TagOperationResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({
          success: false,
          status: 'Permission check timeout',
          retryable: true,
        });
      }, timeoutMs);
    });

    const checkPromise = this.telegramClient.checkTagPermission(this.targetChatId).then(result => {
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
    });

    try {
      return await Promise.race([checkPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Start expiry sweeper (applies missing tags and removes tags from expired enrollments).
   * Runs initial sweep immediately, then at configured interval (default 24 hours).
   * Always starts regardless of initial permission state, so tagging can enable itself later.
   */
  startSweeper(): void {
    if (this.sweeperInterval) {
      return; // Already running
    }

    // Run initial sweep in background (don't block startup)
    this.runSweeperCycle().catch(error => {
      console.error('[MemberTag] Initial sweep failed');
    });

    // Schedule periodic sweeps
    const intervalMs = this.sweepIntervalHours * 60 * 60 * 1000;
    this.sweeperInterval = setInterval(() => {
      this.runSweeperCycle().catch(error => {
        console.error('[MemberTag] Periodic sweep failed');
      });
    }, intervalMs);
    
    // Don't prevent process exit in production
    this.sweeperInterval.unref();
  }

  /**
   * Run one sweeper cycle: re-check permissions and reconcile all tags.
   * Updates featureEnabled flag based on current permission state.
   */
  private async runSweeperCycle(): Promise<void> {
    // Re-check permissions each cycle (allows granting rights without restart)
    const permCheck = await this.checkPermissions();
    if (!permCheck.success) {
      if (this.featureEnabled) {
        console.log('[MemberTag] Permission check failed, tagging disabled until granted');
        this.featureEnabled = false;
      }
      return;
    }

    // Permission check passed
    if (!this.featureEnabled) {
      console.log('[MemberTag] Permission check passed, tagging enabled');
      this.featureEnabled = true;
    }

    // Reconcile all tags
    await this.reconcileAllTags();
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
        this.getChatIdString(),
        tagText,
        new Date().toISOString()
      );
    } catch (error) {
      console.error('[MemberTag] Failed to record tag application');
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
        this.getChatIdString()
      );
    } catch (error) {
      console.error('[MemberTag] Failed to record tag removal');
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
      `).get(telegramUserId, this.getChatIdString()) as any;
      
      return row || null;
    } catch (error) {
      console.error('[MemberTag] Failed to get applied tag');
      return null;
    }
  }

  /**
   * Convert chat ID to string for storage.
   */
  private getChatIdString(): string {
    return String(this.targetChatId);
  }
}
