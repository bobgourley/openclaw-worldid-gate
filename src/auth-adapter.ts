/**
 * Authenticated transport adapter interface
 * 
 * CRITICAL: This starter accepts synthetic test fixtures only.
 * Production MUST integrate with an authenticated transport that
 * validates updates before they reach the admission gate.
 * 
 * The numeric `from.id` in arbitrary JSON is NOT authenticated.
 * A production adapter must:
 * 1. Receive updates from authenticated Telegram Bot API
 * 2. Validate HMAC or TLS client authentication
 * 3. Reject malformed, forged, or tampered updates
 * 4. Only then extract the authenticated user ID
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
 * Integration requirements:
 * - HTTPS connection to Telegram Bot API or OpenClaw gateway
 * - Webhook signature validation (if using webhooks)
 * - TLS client authentication (if using gateway)
 * - Malformed update rejection
 * - Transport error handling
 * - Rate limiting and backpressure
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
