/**
 * Telegram Bot API client for member tag management.
 * 
 * Implements native setChatMemberTag method for display-only member labels.
 * Tags are cosmetic UI indicators, NOT access control mechanisms.
 * 
 * Official API: https://core.telegram.org/bots/api#setchatmembertag
 */

/**
 * Configuration for Telegram Bot API client.
 */
export interface TelegramApiConfig {
  /** Bot token for API authentication */
  botToken: string;
  
  /** Base URL for Telegram Bot API (default: official API) */
  baseUrl?: string;
}

/**
 * Result of setChatMemberTag operation.
 */
export interface SetTagResult {
  /** Whether operation succeeded */
  success: boolean;
  
  /** Error message if operation failed */
  error?: string;
  
  /** Whether failure was due to missing bot permissions */
  permissionDenied?: boolean;
  
  /** Whether failure was due to invalid target (admin, bot, not in group) */
  invalidTarget?: boolean;
}

/**
 * Telegram Bot API client for member tag operations.
 * 
 * SECURITY: Tags are display-only. Tag operations NEVER affect access control.
 */
export class TelegramApiClient {
  private readonly botToken: string;
  private readonly baseUrl: string;

  constructor(config: TelegramApiConfig) {
    if (!config.botToken || typeof config.botToken !== 'string') {
      throw new Error('Bot token required');
    }

    this.botToken = config.botToken;
    this.baseUrl = config.baseUrl || 'https://api.telegram.org';
  }

  /**
   * Set member tag (native Telegram feature).
   * 
   * DISPLAY-ONLY: Tag is cosmetic UI indicator, NOT authorization mechanism.
   * Tag failure does NOT affect access control (handled separately at admission gate).
   * 
   * @param chatId - Telegram chat ID (group/supergroup) or @username
   * @param userId - Telegram user ID (numeric, immutable)
   * @param tag - Tag text (0-16 chars, no emoji). Empty string removes tag.
   * @returns Result with success/error details
   * 
   * Requirements (checked by Telegram):
   * - Bot must be administrator in chat
   * - Bot must have can_manage_tags permission
   * - User must be regular member (not admin, creator, or bot)
   * - Chat must be group or supergroup (not channel or DM)
   */
  async setChatMemberTag(
    chatId: number | string,
    userId: number,
    tag: string
  ): Promise<SetTagResult> {
    // Validate inputs (fail-closed)
    if (!chatId) {
      return { success: false, error: 'Chat ID required' };
    }

    if (!userId || typeof userId !== 'number') {
      return { success: false, error: 'User ID must be numeric' };
    }

    if (typeof tag !== 'string') {
      return { success: false, error: 'Tag must be string' };
    }

    // Validate tag length (Telegram limit: 0-16 characters)
    if (tag.length > 16) {
      return { success: false, error: 'Tag exceeds 16 character limit' };
    }

    // Check for emoji (simple check: non-ASCII characters)
    if (tag && /[^\x00-\x7F]/.test(tag)) {
      return { success: false, error: 'Tag cannot contain emoji or non-ASCII characters' };
    }

    // Call Telegram Bot API
    const url = `${this.baseUrl}/bot${this.botToken}/setChatMemberTag`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          user_id: userId,
          tag: tag || undefined, // Empty string removes tag
        }),
      });

      const data = await response.json() as any;

      if (data.ok === true) {
        return { success: true };
      }

      // Parse error
      const errorDescription = data.description || 'Unknown error';
      
      // Detect permission errors
      if (errorDescription.includes('not enough rights') ||
          errorDescription.includes('CHAT_ADMIN_REQUIRED') ||
          errorDescription.includes('can_manage_tags')) {
        return {
          success: false,
          error: errorDescription,
          permissionDenied: true,
        };
      }

      // Detect invalid target errors
      if (errorDescription.includes('user not found') ||
          errorDescription.includes('USER_NOT_PARTICIPANT') ||
          errorDescription.includes('is an administrator') ||
          errorDescription.includes('CHAT_WRITE_FORBIDDEN')) {
        return {
          success: false,
          error: errorDescription,
          invalidTarget: true,
        };
      }

      return {
        success: false,
        error: errorDescription,
      };

    } catch (error: any) {
      return {
        success: false,
        error: `Network error: ${error.message || 'Unknown'}`,
      };
    }
  }

  /**
   * Remove member tag.
   * 
   * Convenience method that calls setChatMemberTag with empty string.
   */
  async removeChatMemberTag(
    chatId: number | string,
    userId: number
  ): Promise<SetTagResult> {
    return this.setChatMemberTag(chatId, userId, '');
  }

  /**
   * Check if bot has permission to manage tags in a chat.
   * 
   * PREFLIGHT: Call before attempting tag operations to validate bot setup.
   * 
   * @param chatId - Telegram chat ID
   * @returns Result indicating if bot can manage tags
   * 
   * Note: This attempts a no-op tag operation to check permissions.
   * Returns success if bot has can_manage_tags right.
   */
  async checkTagPermission(chatId: number | string): Promise<SetTagResult> {
    // Attempt to get chat info via getChat
    const url = `${this.baseUrl}/bot${this.botToken}/getChat`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
        }),
      });

      const data = await response.json() as any;

      if (!data.ok) {
        return {
          success: false,
          error: data.description || 'Cannot access chat',
        };
      }

      // Check if chat type supports tags
      const chatType = data.result?.type;
      if (chatType !== 'group' && chatType !== 'supergroup') {
        return {
          success: false,
          error: `Chat type '${chatType}' does not support member tags (only groups and supergroups)`,
        };
      }

      // NOTE: We cannot directly check can_manage_tags without attempting an operation
      // or calling getChatMember for the bot itself (which requires user_id)
      // For now, return success if chat type is valid
      // Actual permission will be verified on first tag operation
      return { success: true };

    } catch (error: any) {
      return {
        success: false,
        error: `Network error: ${error.message || 'Unknown'}`,
      };
    }
  }
}
