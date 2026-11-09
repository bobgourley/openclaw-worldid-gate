/**
 * Synthetic Telegram fixtures for testing
 * 
 * These are NOT authenticated live Telegram API updates.
 * They are synthetic test data for unit testing the admission gate logic.
 */

import type { TelegramUpdate, WorldIdProof } from './types.js';

export function createTelegramUpdate(options: {
  userId: number;
  username?: string;
  text?: string;
  isBot?: boolean;
  forwardedFrom?: number;
}): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1000000),
    message: {
      message_id: Math.floor(Math.random() * 1000000),
      from: {
        id: options.userId,
        is_bot: options.isBot ?? false,
        first_name: `User${options.userId}`,
        username: options.username,
      },
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: options.userId,
        type: 'private',
      },
      text: options.text ?? 'Hello',
      forward_from: options.forwardedFrom
        ? {
            id: options.forwardedFrom,
            is_bot: false,
            first_name: `User${options.forwardedFrom}`,
          }
        : undefined,
    },
  };
}

export function createBotUpdate(botId: number): TelegramUpdate {
  return createTelegramUpdate({ userId: botId, isBot: true });
}

export function createChannelPostUpdate(channelId: number, text: string): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1000000),
    channel_post: {
      message_id: Math.floor(Math.random() * 1000000),
      sender_chat: {
        id: channelId,
        type: 'channel',
        title: `Channel ${channelId}`,
      },
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: channelId,
        type: 'channel',
        title: `Channel ${channelId}`,
      },
      text,
    },
  };
}

export function createWorldIdProof(options: {
  nullifier: string;
  action: string;
  expiresAtMin?: number;
  identifier?: 'proof_of_human' | 'selfie' | 'orb';
}): WorldIdProof {
  const now = Math.floor(Date.now() / 1000);
  return {
    protocol_version: '4.0',
    nonce: `0x${Math.random().toString(16).slice(2)}`,
    action: options.action,
    responses: [
      {
        identifier: options.identifier ?? 'proof_of_human',
        issuer_schema_id: 1,
        nullifier: options.nullifier,
        expires_at_min: options.expiresAtMin ?? now + 86400,
        proof: ['0x111', '0x222', '0x333', '0x444', '0x555'],
        signal_hash: '0x0',
      },
    ],
    environment: 'production',
  };
}

export function createInvalidWorldIdProof(): WorldIdProof {
  return {
    protocol_version: '4.0',
    nonce: '0xbadnonce',
    action: 'invalid_action',
    responses: [
      {
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        nullifier: '0xbadnullifier',
        expires_at_min: 0,
        proof: [],
      },
    ],
  };
}

export function createExpiredWorldIdProof(action: string): WorldIdProof {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  return createWorldIdProof({
    nullifier: '0xexpired',
    action,
    expiresAtMin: oneDayAgo,
  });
}
