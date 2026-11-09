/**
 * Authenticated transport adapter interface
 * 
 * CRITICAL: This starter accepts synthetic test fixtures only.
 * Production MUST integrate with an authenticated transport that
 * validates updates before they reach the admission gate.
 * 
 * The numeric `from.id` in arbitrary JSON is NOT authenticated.
 * 
 * UNIMPLEMENTED: No production adapter exists in this starter.
 * The trust boundary is NOT fixed by warnings alone.
 * 
 * Telegram Bot API provides two authenticated transport modes:
 * 
 * 1. **Webhook mode** (recommended for production):
 *    - Call setWebhook with secret_token parameter (1-256 chars)
 *    - Telegram sends X-Telegram-Bot-Api-Secret-Token header with every request
 *    - Validate header matches expected secret_token (constant-time comparison)
 *    - Reject requests with missing/mismatched header before parsing JSON
 *    - Source: https://core.telegram.org/bots/api#setwebhook
 * 
 * 2. **Long polling mode** (getUpdates):
 *    - Call getUpdates over HTTPS with bot token in URL
 *    - Telegram validates token server-side
 *    - Receive array of Update objects
 *    - Source: https://core.telegram.org/bots/api#getupdates
 * 
 * NOTE: Telegram Web App initData uses different HMAC validation.
 * This is separate from Bot API webhook/polling authentication.
 * Source: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * 
 * A production adapter implementation must:
 * 1. Receive updates from authenticated Telegram Bot API transport
 * 2. For webhooks: Validate X-Telegram-Bot-Api-Secret-Token header
 * 3. For polling: Validate bot token and HTTPS connection to api.telegram.org
 * 4. Reject malformed, forged, or tampered updates
 * 5. Handle transport errors and retries
 * 6. Only then pass validated updates to admission gate
 */

import type { TelegramUpdate } from './types.js';

/**
 * Authenticated adapter contract
 * 
 * Production implementations must ensure the TelegramUpdate
 * was received from an authenticated source (OpenClaw gateway
 * receiving from Telegram Bot API over HTTPS).
 */
export interface AuthenticatedTelegramAdapter {
  /**
   * Receive and validate an authenticated update
   * 
   * @throws Error if update fails authentication/validation
   */
  receiveUpdate(): Promise<TelegramUpdate>;
}

/**
 * TEST-ONLY: Synthetic fixture adapter
 * 
 * This adapter accepts arbitrary JSON without authentication.
 * DO NOT USE IN PRODUCTION.
 * 
 * A real adapter would:
 * - Connect to Telegram Bot API over HTTPS
 * - Validate webhook signatures
 * - Reject unsigned/tampered updates
 * - Handle transport errors
 */
export class SyntheticFixtureAdapter implements AuthenticatedTelegramAdapter {
  constructor(private readonly fixtures: TelegramUpdate[]) {}

  async receiveUpdate(): Promise<TelegramUpdate> {
    const update = this.fixtures.shift();
    if (!update) {
      throw new Error('No more test fixtures');
    }
    return update;
  }
}

/**
 * Production adapter (UNIMPLEMENTED)
 * 
 * Integration requirements depend on transport mode:
 * 
 * **For Telegram webhook mode:**
 * - HTTPS endpoint receiving POST requests from Telegram
 * - Validate X-Telegram-Bot-Api-Secret-Token header (constant-time comparison)
 * - Reject requests before parsing JSON if header missing/mismatched
 * - Parse JSON only after header validation passes
 * - Handle malformed JSON and invalid Update schemas
 * - Source: https://core.telegram.org/bots/api#setwebhook
 * 
 * **For Telegram polling mode (getUpdates):**
 * - HTTPS client connecting to api.telegram.org
 * - Bot token authentication in URL
 * - Long polling with configurable timeout
 * - Handle network errors and retries
 * - Source: https://core.telegram.org/bots/api#getupdates
 * 
 * **For OpenClaw gateway integration:**
 * - Unknown: OpenClaw's internal transport authentication mechanism
 * - Official docs do not specify admission gate integration points
 * - May require OpenClaw source modification or plugin architecture
 * - See: https://docs.openclaw.ai/channels/telegram/
 * 
 * This adapter is not implemented. The trust boundary remains unprotected.
 */
export class OpenClawTelegramAdapter implements AuthenticatedTelegramAdapter {
  async receiveUpdate(): Promise<TelegramUpdate> {
    throw new Error(
      'Production OpenClaw adapter is not implemented. ' +
      'This requires integration with OpenClaw gateway Telegram transport. ' +
      'See official OpenClaw docs: https://docs.openclaw.ai/channels/telegram/'
    );
  }
}

/**
 * Validate Telegram update authentication
 * 
 * In production, this must validate:
 * - Webhook: X-Telegram-Bot-Api-Secret-Token header
 * - Or HMAC signature for initData
 * - Or validate getUpdates polling connection
 * 
 * This starter implementation performs minimal structure validation only.
 * Real authentication validation is required for production.
 */
export function validateTelegramUpdate(
  update: TelegramUpdate,
  botToken: string
): { valid: boolean; reason?: string } {
  // Minimal structure validation
  // Real implementation must validate cryptographic signatures
  
  if (!update || typeof update !== 'object') {
    return { valid: false, reason: 'Invalid update object' };
  }
  
  if (typeof update.update_id !== 'number') {
    return { valid: false, reason: 'Missing or invalid update_id' };
  }
  
  // In production, validate webhook signature header or HMAC
  // For now, accept if structure is valid
  return { valid: true };
}
