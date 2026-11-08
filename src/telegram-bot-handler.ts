/**
 * Telegram bot handler for World ID verification.
 *
 * Security:
 * - Webhook secret validation (not invented signature)
 * - Authenticated polling with bot token
 * - Forged from.id cannot become trusted
 * - Fail-closed on malformed updates
 * - No arbitrary unauthenticated endpoints
 */

import type { EnrollmentService } from './enrollment-service-production.js';
import { createHmac } from 'node:crypto';
import type { OpenClawDispatchConfig } from './openclaw-dispatcher.js';
import { dispatchToOpenClaw } from './openclaw-dispatcher.js';

/**
 * Telegram update structure (incoming from Bot API).
 */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: 'private' | 'group' | 'supergroup' | 'channel';
    };
    date: number;
    text?: string;
  };
}

/**
 * Telegram bot transport interface (injectable for testing).
 */
export interface TelegramBotTransport {
  /**
   * Send message to user.
   * @param chatId - Telegram chat ID
   * @param text - Message text
   * @param options - Additional options (parse_mode, reply_markup, etc.)
   */
  sendMessage(chatId: number, text: string, options?: any): Promise<void>;
}

/**
 * Telegram bot handler configuration.
 */
export interface TelegramBotHandlerConfig {
  /** Bot token for authentication */
  botToken: string;
  
  /** Enrollment service */
  enrollmentService: EnrollmentService;
  
  /** Transport implementation (injectable for testing) */
  transport: TelegramBotTransport;
  
  /** Base URL for enrollment UI links */
  enrollmentBaseUrl: string;
  
  /** Webhook secret for validation (optional, recommended) */
  webhookSecret?: string;
  
  /** OpenClaw dispatcher config (optional, enables /ask command) */
  openclawConfig?: OpenClawDispatchConfig;
  
  /** Allowed group ID for OpenClaw dispatch (required if openclawConfig set) */
  allowedGroupId?: number;
}

/**
 * Telegram bot handler for enrollment commands.
 */
export class TelegramBotHandler {
  private readonly botToken: string;
  private readonly enrollmentService: EnrollmentService;
  private readonly transport: TelegramBotTransport;
  private readonly enrollmentBaseUrl: string;
  private readonly webhookSecret?: string;
  private readonly openclawConfig?: OpenClawDispatchConfig;
  private readonly allowedGroupId?: number;
  private readonly activeSessions: Map<number, { sessionId: string; createdAt: number }> = new Map();
  private readonly recentDeliveries: Map<string, number> = new Map();

  constructor(config: TelegramBotHandlerConfig) {
    if (!config.botToken || typeof config.botToken !== 'string' || config.botToken.length === 0) {
      throw new Error('Invalid botToken: must be non-empty string');
    }
    if (!config.enrollmentService) {
      throw new Error('Invalid enrollmentService: required');
    }
    if (!config.transport) {
      throw new Error('Invalid transport: required');
    }
    if (!config.enrollmentBaseUrl || typeof config.enrollmentBaseUrl !== 'string') {
      throw new Error('Invalid enrollmentBaseUrl: must be non-empty string');
    }

    this.botToken = config.botToken;
    this.enrollmentService = config.enrollmentService;
    this.transport = config.transport;
    this.enrollmentBaseUrl = config.enrollmentBaseUrl;
    this.webhookSecret = config.webhookSecret;
    this.openclawConfig = config.openclawConfig;
    this.allowedGroupId = config.allowedGroupId;
    
    // Validate OpenClaw config if provided
    if (this.openclawConfig) {
      if (!this.webhookSecret) {
        throw new Error('Webhook secret required when OpenClaw integration enabled');
      }
      if (!this.allowedGroupId) {
        throw new Error('Allowed group ID required when OpenClaw integration enabled');
      }
      if (!this.openclawConfig.profile || this.openclawConfig.profile.trim() === '') {
        throw new Error('Dedicated profile required when OpenClaw integration enabled');
      }
      if (this.openclawConfig.timeoutSeconds < 1 || this.openclawConfig.timeoutSeconds > 600) {
        throw new Error('Timeout must be between 1 and 600 seconds');
      }
      if (!Number.isInteger(this.allowedGroupId) || this.allowedGroupId >= 0) {
        throw new Error('Allowed group ID must be negative integer (Telegram group format)');
      }
    }
  }

  /**
   * Validate webhook request (fail-closed on invalid).
   * 
   * @param body - Raw request body
   * @param secretToken - X-Telegram-Bot-Api-Secret-Token header value
   * @returns True if valid, false otherwise
   */
  validateWebhook(body: string, secretToken?: string): boolean {
    // If webhook secret configured, require matching header
    if (this.webhookSecret) {
      if (!secretToken || secretToken !== this.webhookSecret) {
        return false;
      }
    }
    
    // Basic body validation
    if (!body || typeof body !== 'string' || body.length === 0) {
      return false;
    }
    
    return true;
  }

  /**
   * Handle incoming Telegram update (webhook or polling).
   * 
   * Security: Fail-closed on malformed updates, unsupported commands, group messages.
   * 
   * @param update - Telegram update object
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    // Validate update structure (fail-closed)
    if (!update || typeof update !== 'object') {
      console.error('Invalid update: not an object');
      return;
    }

    if (!update.message) {
      // Ignore non-message updates (edited messages, callbacks, etc.)
      return;
    }

    const message = update.message;

    // Validate message structure
    if (!message.from || typeof message.from.id !== 'number') {
      console.error('Invalid message: missing or invalid from.id');
      return;
    }

    // Reject bot messages
    if (message.from.is_bot) {
      console.error('Invalid message: from bot user');
      return;
    }

    // Handle group messages only if OpenClaw enabled and allowed
    if (message.chat.type !== 'private') {
      const text = message.text?.trim() || '';
      
      // Check for /revoke in group - direct to private DM without exposing details
      if (text === '/revoke' || text.match(/^\/revoke@\w+$/)) {
        await this.transport.sendMessage(
          message.chat.id,
          '⚠️ Please message me privately.'
        ).catch(err => console.error('Failed to send group revoke error:', err));
        return;
      }
      
      if (this.openclawConfig && message.chat.id === this.allowedGroupId) {
        // OpenClaw dispatch in allowed group
        if (text.startsWith('/ask ')) {
          await this.handleOpenClawCommand(message.from.id, message.chat.id, text.slice(5).trim(), update.update_id);
        }
        // Silently ignore other messages in group
      } else {
        // Send error to unauthorized group/channel
        await this.transport.sendMessage(
          message.chat.id,
          '⚠️ World ID verification is only available in private chat with the bot. Please message me directly.'
        ).catch(err => console.error('Failed to send group error:', err));
      }
      return;
    }

    // Parse command (fail-closed on unsupported)
    const text = message.text?.trim() || '';

    if (text === '/start' || text === '/help') {
      await this.handleHelpCommand(message.from.id);
    } else if (text === '/verify') {
      await this.handleVerifyCommand(message.from.id, {
        first_name: message.from.first_name,
        username: message.from.username,
      });
    } else if (text === '/status') {
      await this.handleStatusCommand(message.from.id);
    } else if (text === '/revoke' || text.match(/^\/revoke@\w+$/)) {
      await this.handleRevokeCommand(message.from.id);
    } else if (text.startsWith('/ask ')) {
      // OpenClaw CLI dispatch command (private chat only)
      if (this.openclawConfig) {
        await this.handleOpenClawCommand(message.from.id, message.chat.id, text.slice(5).trim(), update.update_id);
      } else {
        await this.transport.sendMessage(
          message.from.id,
          '❌ OpenClaw integration not enabled.'
        ).catch(err => console.error('Failed to send error:', err));
      }
    } else if (text.startsWith('/')) {
      // Unknown command (fail-closed)
      await this.transport.sendMessage(
        message.from.id,
        '❌ Unknown command. Use /verify to start verification, or /help for more information.'
      ).catch(err => console.error('Failed to send unknown command error:', err));
    } else {
      // Non-command text (informational response)
      await this.transport.sendMessage(
        message.from.id,
        'Use /verify to verify your World ID, or /help for more information.'
      ).catch(err => console.error('Failed to send info:', err));
    }
  }

  /**
   * Handle /ask command - gated OpenClaw CLI dispatch.
   * 
   * Security:
   * - Numeric human sender (already validated)
   * - Fresh enrollment check before dispatch
   * - Bounded CLI execution
   * - Duplicate suppression
   */
  private async handleOpenClawCommand(userId: number, chatId: number, query: string, updateId: number): Promise<void> {
    if (!this.openclawConfig) {
      return;
    }

    try {
      if (!query) {
        await this.transport.sendMessage(chatId, '❌ Usage: /ask <your question>');
        return;
      }

      // Duplicate suppression (5-minute window) - reserve BEFORE async work
      const deliveryKey = `${userId}:${chatId}:${updateId}`;
      const now = Date.now();
      const recentTime = this.recentDeliveries.get(deliveryKey);
      if (recentTime && now - recentTime < 300000) {
        console.log(`Duplicate delivery suppressed: ${deliveryKey}`);
        return;
      }

      // Reserve immediately to prevent concurrent duplicates
      this.recentDeliveries.set(deliveryKey, now);

      // Clean old delivery records
      for (const [key, time] of this.recentDeliveries.entries()) {
        if (now - time > 600000) {
          this.recentDeliveries.delete(key);
        }
      }

      let spawnAttempted = false;

      try {
        // Dispatch to OpenClaw CLI with fresh enrollment check before spawn
        const result = await dispatchToOpenClaw(this.openclawConfig, {
          telegramUserId: userId,
          chatId: chatId,
          text: query,
          preSpawnCheck: async () => {
            // Fresh enrollment check AFTER file prep, BEFORE spawn
            const enrollment = await this.enrollmentService.findEnrollment(userId);
            
            if (!enrollment) {
              return { allowed: false, reason: 'World ID verification required' };
            }

            if (enrollment.revoked) {
              return { allowed: false, reason: 'Enrollment revoked' };
            }

            if (enrollment.expired) {
              return { allowed: false, reason: 'Enrollment expired' };
            }

            spawnAttempted = true;
            return { allowed: true };
          },
        });

        // Handle result
        if (result.error && !spawnAttempted) {
          // Admission rejected before spawn - allow retry
          this.recentDeliveries.delete(deliveryKey);
          
          if (result.error.includes('verification required')) {
            await this.transport.sendMessage(
              chatId,
              '❌ World ID verification required.\n\nUse /verify to start verification.'
            );
          } else if (result.error.includes('revoked')) {
            await this.transport.sendMessage(
              chatId,
              '❌ Your verification has been revoked.\n\nPlease contact support.'
            );
          } else if (result.error.includes('expired')) {
            await this.transport.sendMessage(
              chatId,
              '❌ Your verification has expired.\n\nUse /verify to renew.'
            );
          } else {
            await this.transport.sendMessage(chatId, '❌ Request failed.');
          }
          return;
        }

        // Spawn was attempted - preserve reservation even if delivery fails
        if (result.success && result.response) {
          const responseText = result.response.slice(0, 4096);
          await this.transport.sendMessage(chatId, responseText);
        } else if (result.timeout) {
          await this.transport.sendMessage(chatId, '⏱️ Request timed out.');
        } else {
          await this.transport.sendMessage(chatId, '❌ Request failed.');
          console.error('OpenClaw dispatch error:', result.error);
        }
      } catch (error) {
        // Remove reservation only if spawn was not attempted
        if (!spawnAttempted) {
          this.recentDeliveries.delete(deliveryKey);
        }
        throw error;
      }

    } catch (error: any) {
      console.error('OpenClaw command error:', error);
      await this.transport.sendMessage(
        chatId,
        '❌ An error occurred processing your request.'
      ).catch(err => console.error('Failed to send error:', err));
    }
  }

  /**
   * Handle /help and /start commands.
   */
  private async handleHelpCommand(userId: number): Promise<void> {
    const helpText = 
      '🌍 *World ID Verification Bot*\n\n' +
      'Verify your unique personhood with World ID to access protected Telegram groups.\n\n' +
      '*Commands:*\n' +
      '/verify - Start World ID verification\n' +
      '/status - Check your verification status\n' +
      '/revoke - Remove your verification (allows reverification)\n' +
      '/help - Show this help message\n\n' +
      '*Privacy:* Only a zero-knowledge proof is verified. No biometric data is collected or shared.';

    await this.transport.sendMessage(userId, helpText, { parse_mode: 'Markdown' })
      .catch(err => console.error('Failed to send help:', err));
  }

  /**
   * Handle /verify command - create enrollment session and send UI link.
   * 
   * Security: Requester-bound single-use session, short-lived.
   */
  private async handleVerifyCommand(userId: number, userInfo?: { first_name: string; username?: string }): Promise<void> {
    try {
      // Check existing enrollment
      const existing = await this.enrollmentService.findEnrollment(userId);
      
      if (existing && !existing.revoked && !existing.expired) {
        const expiryDate = new Date(existing.expiresAt * 1000);
        const daysRemaining = Math.floor((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        
        await this.transport.sendMessage(
          userId,
          `✅ You are already verified!\n\n` +
          `Your enrollment expires in ${daysRemaining} days (${expiryDate.toLocaleDateString()}).\n\n` +
          `Use /status to check your verification status.`
        );
        return;
      }

      // Create Mini App initData for authenticated session
      // Note: In production, this would come from Telegram Mini App context
      // For now, we create authenticated context for private message
      const authDate = Math.floor(Date.now() / 1000);
      const userObj: any = { id: userId };
      if (userInfo?.first_name) {
        userObj.first_name = userInfo.first_name;
      }
      if (userInfo?.username) {
        userObj.username = userInfo.username;
      }
      const user = JSON.stringify(userObj);
      const dataCheckString = `auth_date=${authDate}\nuser=${user}`;
      const secretKey = createHmac('sha256', 'WebAppData').update(this.botToken).digest();
      const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
      const initData = `user=${encodeURIComponent(user)}&auth_date=${authDate}&hash=${hash}`;

      // Create challenge session (authenticated to this user)
      const challengeResult = await this.enrollmentService.createChallenge(initData);
      
      if (!challengeResult.signedChallenge) {
        await this.transport.sendMessage(
          userId,
          '❌ Unable to create verification session. Please try again later.'
        );
        return;
      }

      // Generate session ID for UI link (rate limit: one active session per user)
      const existingSession = this.activeSessions.get(userId);
      if (existingSession && Date.now() - existingSession.createdAt < 300000) {
        // Reuse existing session if less than 5 minutes old
        const sessionId = existingSession.sessionId;
        const enrollmentUrl = `${this.enrollmentBaseUrl}/enrollment?session=${sessionId}`;
        
        await this.transport.sendMessage(
          userId,
          '🌍 *World ID Verification*\n\n' +
          'Click the button below to verify with World App.\n\n' +
          '⏱️ Session expires in 5 minutes.',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '🌍 Verify with World ID', web_app: { url: enrollmentUrl } }
              ]]
            }
          }
        );
        return;
      }

      // Create new session ID (bound to challenge nonce)
      const sessionId = challengeResult.signedChallenge.nonce.slice(2, 34); // 32 hex chars
      this.activeSessions.set(userId, { sessionId, createdAt: Date.now() });

      // Store complete challenge data for session (includes rpId from signed challenge)
      this.storeChallengeForSession(sessionId, userId, {
        signedChallenge: challengeResult.signedChallenge,
        appId: challengeResult.signedChallenge.appId,
        rpId: challengeResult.signedChallenge.rpId,
        signal: `telegram:${userId}`,
      });

      // Clean up old sessions (older than 10 minutes)
      for (const [uid, session] of this.activeSessions.entries()) {
        if (Date.now() - session.createdAt > 600000) {
          this.activeSessions.delete(uid);
        }
      }

      // Generate enrollment UI link with Telegram Mini App button
      const enrollmentUrl = `${this.enrollmentBaseUrl}/enrollment?session=${sessionId}`;

      await this.transport.sendMessage(
        userId,
        '🌍 *World ID Verification*\n\n' +
        'Click the button below to verify with World App.\n\n' +
        '⏱️ Session expires in 5 minutes.\n' +
        '📱 Make sure you have World App installed.',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🌍 Verify with World ID', web_app: { url: enrollmentUrl } }
            ]]
          }
        }
      );

    } catch (error: any) {
      console.error('Verify command error:', error);
      await this.transport.sendMessage(
        userId,
        '❌ An error occurred. Please try again later.'
      ).catch(err => console.error('Failed to send error:', err));
    }
  }

  /**
   * Handle /status command - show current enrollment status.
   */
  private async handleStatusCommand(userId: number): Promise<void> {
    try {
      const enrollment = await this.enrollmentService.findEnrollment(userId);
      
      if (!enrollment) {
        await this.transport.sendMessage(
          userId,
          '❌ You are not verified.\n\nUse /verify to start World ID verification.'
        );
        return;
      }

      if (enrollment.revoked) {
        await this.transport.sendMessage(
          userId,
          '⚠️ Your verification has been revoked.\n\nUse /verify to verify again with a fresh proof.'
        );
        return;
      }

      if (enrollment.expired) {
        await this.transport.sendMessage(
          userId,
          '⏰ Your verification has expired.\n\nUse /verify to renew your verification.'
        );
        return;
      }

      const expiryDate = new Date(enrollment.expiresAt * 1000);
      const daysRemaining = Math.floor((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

      await this.transport.sendMessage(
        userId,
        `✅ *Verification Status: Active*\n\n` +
        `Expires: ${expiryDate.toLocaleDateString()}\n` +
        `Days remaining: ${daysRemaining}\n\n` +
        `Use /verify to renew if your verification is expiring soon.`,
        { parse_mode: 'Markdown' }
      );

    } catch (error: any) {
      console.error('Status command error:', error);
      await this.transport.sendMessage(
        userId,
        '❌ Unable to check verification status. Please try again later.'
      ).catch(err => console.error('Failed to send error:', err));
    }
  }

  /**
   * Handle /revoke command - self-service removal of user's enrollment.
   * 
   * Security:
   * - Uses only authenticated message.from.id (no caller-supplied target)
   * - Idempotent (safe to call multiple times)
   * - Deletes pending challenges to prevent stale re-enrollment
   * - Does NOT delete World ID credential in World App
   * 
   * @param userId - Authenticated Telegram user ID from message.from.id
   */
  private async handleRevokeCommand(userId: number): Promise<void> {
    try {
      const wasRevoked = await this.enrollmentService.revokeEnrollment(userId);

      if (wasRevoked) {
        await this.transport.sendMessage(
          userId,
          '✅ *Your verification has been revoked.*\n\n' +
          '*What this means:*\n' +
          '• Your access to this bot has been removed\n' +
          '• Any pending verification sessions have been canceled\n' +
          '• You can verify again anytime by sending /verify\n\n' +
          '*Important:* This only removes your verification from this bot. ' +
          'Your World ID credentials in the World App are not affected.\n\n' +
          'Send /verify to verify again with a fresh proof.',
          { parse_mode: 'Markdown' }
        );
      } else {
        await this.transport.sendMessage(
          userId,
          '✅ *No active verification found.*\n\n' +
          'You do not have an active verification to revoke.\n\n' +
          'Send /verify to start World ID verification.',
          { parse_mode: 'Markdown' }
        );
      }
    } catch (error: any) {
      console.error('Revoke command error:', error);
      await this.transport.sendMessage(
        userId,
        '❌ Unable to process revocation. Please try again later.'
      ).catch(err => console.error('Failed to send error:', err));
    }
  }

  /**
   * Get session info for UI rendering (validates session ID).
   * 
   * @param sessionId - Session ID from URL
   * @returns Session info or null if invalid/expired
   */
  /**
   * Store challenge data for a session.
   * Called after creating challenge via enrollment service.
   */
  storeChallengeForSession(sessionId: string, userId: number, challengeData: {
    signedChallenge: any;
    appId: string;
    rpId: string;
    signal: string;
  }): void {
    const session = this.activeSessions.get(userId);
    if (session && session.sessionId === sessionId) {
      (session as any).challengeData = challengeData;
    }
  }

  async getSessionInfo(sessionId: string): Promise<{
    userId: number;
    signedChallenge: any;
    appId: string;
    rpId: string;
    signal: string;
  } | null> {
    // Validate session ID format
    if (!sessionId || typeof sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(sessionId)) {
      return null;
    }

    // Find user ID for this session
    for (const [userId, session] of this.activeSessions.entries()) {
      if (session.sessionId === sessionId) {
        // Check expiry (5 minutes)
        if (Date.now() - session.createdAt > 300000) {
          this.activeSessions.delete(userId);
          return null;
        }

        // Return stored challenge data if available
        const challengeData = (session as any).challengeData;
        if (challengeData) {
          return {
            userId,
            ...challengeData,
          };
        }

        // Fallback for legacy sessions without stored data
        const nonce = `0x${sessionId}${'0'.repeat(32)}`;
        return {
          userId,
          signedChallenge: {
            action: 'telegram-verification',
            nonce,
            signalHash: `0x${sessionId.split('').reverse().join('')}`,
          },
          appId: 'placeholder',
          rpId: 'rp_0000000000000000',
          signal: `telegram:${userId}`,
        };
      }
    }

    return null;
  }
}

/**
 * HTTP transport for Telegram Bot API.
 */
export class TelegramHttpTransport implements TelegramBotTransport {
  constructor(private readonly botToken: string) {
    if (!botToken || typeof botToken !== 'string') {
      throw new Error('Invalid botToken');
    }
  }

  async sendMessage(chatId: number, text: string, options?: any): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...options,
      }),
    });

    if (!response.ok) {
      const error = await response.text().catch(() => 'Unknown error');
      throw new Error(`Telegram API error: ${response.status} ${error}`);
    }
  }
}
