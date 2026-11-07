/**
 * Telegram bot handler tests.
 *
 * Tests security boundaries, authentication, and fail-closed behavior.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBotHandler, type TelegramBotTransport, type TelegramUpdate } from './telegram-bot-handler.js';
import type { EnrollmentService } from './enrollment-service-production.js';

describe('TelegramBotHandler', () => {
  let mockTransport: TelegramBotTransport;
  let sentMessages: Array<{ chatId: number; text: string; options?: any }>;
  let mockEnrollmentService: EnrollmentService;

  beforeEach(() => {
    sentMessages = [];
    
    mockTransport = {
      sendMessage: mock.fn(async (chatId: number, text: string, options?: any) => {
        sentMessages.push({ chatId, text, options });
      }),
    };

    mockEnrollmentService = {
      findEnrollment: mock.fn(async () => null),
      createChallenge: mock.fn(async () => ({
        signedChallenge: {
          action: 'telegram-verification',
          nonce: '0x' + '1'.repeat(64),
          signalHash: '0x' + '2'.repeat(64),
        },
      })),
    } as any;
  });

  describe('constructor validation', () => {
    it('rejects empty bot token', () => {
      assert.throws(
        () => {
          new TelegramBotHandler({
            botToken: '',
            enrollmentService: mockEnrollmentService,
            transport: mockTransport,
            enrollmentBaseUrl: 'https://example.com',
          });
        },
        /invalid botToken/i
      );
    });

    it('rejects missing enrollment service', () => {
      assert.throws(
        () => {
          new TelegramBotHandler({
            botToken: 'test_token',
            enrollmentService: null as any,
            transport: mockTransport,
            enrollmentBaseUrl: 'https://example.com',
          });
        },
        /invalid enrollmentService/i
      );
    });

    it('rejects missing transport', () => {
      assert.throws(
        () => {
          new TelegramBotHandler({
            botToken: 'test_token',
            enrollmentService: mockEnrollmentService,
            transport: null as any,
            enrollmentBaseUrl: 'https://example.com',
          });
        },
        /invalid transport/i
      );
    });
  });

  describe('webhook validation', () => {
    it('accepts valid webhook with matching secret', () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
        webhookSecret: 'my_secret_123',
      });

      const body = '{"update_id": 1}';
      const result = handler.validateWebhook(body, 'my_secret_123');

      assert.equal(result, true);
    });

    it('rejects webhook with wrong secret', () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
        webhookSecret: 'my_secret_123',
      });

      const body = '{"update_id": 1}';
      const result = handler.validateWebhook(body, 'wrong_secret');

      assert.equal(result, false);
    });

    it('rejects webhook with missing secret when required', () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
        webhookSecret: 'my_secret_123',
      });

      const body = '{"update_id": 1}';
      const result = handler.validateWebhook(body, undefined);

      assert.equal(result, false);
    });

    it('accepts webhook without secret when not configured', () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const body = '{"update_id": 1}';
      const result = handler.validateWebhook(body, undefined);

      assert.equal(result, true);
    });

    it('rejects empty body', () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const result = handler.validateWebhook('', undefined);

      assert.equal(result, false);
    });
  });

  describe('update handling', () => {
    it('ignores non-message updates', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 0);
    });

    it('rejects malformed update (null)', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      await handler.handleUpdate(null as any);

      assert.equal(sentMessages.length, 0);
    });

    it('rejects message without from.id', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: 'private' },
          date: 1234567890,
          text: '/verify',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 0);
    });

    it('rejects message from bot', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: true, first_name: 'Bot' },
          chat: { id: 123, type: 'private' },
          date: 1234567890,
          text: '/verify',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 0);
    });

    it('rejects group message with error', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: false, first_name: 'Test' },
          chat: { id: 456, type: 'group' },
          date: 1234567890,
          text: '/verify',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].chatId, 456);
      assert.match(sentMessages[0].text, /private chat/i);
    });

    it('rejects supergroup message with error', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: false, first_name: 'Test' },
          chat: { id: 456, type: 'supergroup' },
          date: 1234567890,
          text: '/verify',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /private chat/i);
    });

    it('rejects unknown command', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: false, first_name: 'Test' },
          chat: { id: 123, type: 'private' },
          date: 1234567890,
          text: '/unknown',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /unknown command/i);
    });

    it('handles /start command', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: false, first_name: 'Test' },
          chat: { id: 123, type: 'private' },
          date: 1234567890,
          text: '/start',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /World ID Verification Bot/i);
    });

    it('handles /help command', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: false, first_name: 'Test' },
          chat: { id: 123, type: 'private' },
          date: 1234567890,
          text: '/help',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /Commands/i);
    });

    it('handles /verify command for new user', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: false, first_name: 'Test' },
          chat: { id: 123, type: 'private' },
          date: 1234567890,
          text: '/verify',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /World ID Verification/i);
      
      // Verify web_app inline keyboard button (not URL in text)
      assert.ok(sentMessages[0].options?.reply_markup, 'Message should have reply_markup');
      assert.ok(sentMessages[0].options.reply_markup.inline_keyboard, 'Should have inline_keyboard');
      const buttons = sentMessages[0].options.reply_markup.inline_keyboard;
      assert.ok(buttons.length > 0, 'Should have at least one button row');
      assert.ok(buttons[0].length > 0, 'First row should have at least one button');
      assert.ok(buttons[0][0].web_app, 'First button should have web_app');
      assert.match(buttons[0][0].web_app.url, /https:\/\/example\.com\/enrollment\?session=/i);
    });

    it('handles /verify for already enrolled user', async () => {
      mockEnrollmentService.findEnrollment = mock.fn(async () => ({
        nullifier: '0x123',
        telegramUserId: 123,
        action: 'test',
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        revoked: false,
        expired: false,
      }));

      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: false, first_name: 'Test' },
          chat: { id: 123, type: 'private' },
          date: 1234567890,
          text: '/verify',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /already verified/i);
    });

    it('handles /status for enrolled user', async () => {
      mockEnrollmentService.findEnrollment = mock.fn(async () => ({
        nullifier: '0x123',
        telegramUserId: 123,
        action: 'test',
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        createdAt: new Date().toISOString(),
        revoked: false,
        expired: false,
      }));

      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: false, first_name: 'Test' },
          chat: { id: 123, type: 'private' },
          date: 1234567890,
          text: '/status',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /Verification Status: Active/i);
    });

    it('handles /status for non-enrolled user', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, is_bot: false, first_name: 'Test' },
          chat: { id: 123, type: 'private' },
          date: 1234567890,
          text: '/status',
        },
      };

      await handler.handleUpdate(update);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0].text, /not verified/i);
    });
  });

  describe('session validation', () => {
    it('rejects invalid session ID format', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const result = await handler.getSessionInfo('invalid');

      assert.equal(result, null);
    });

    it('rejects non-hex session ID', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const result = await handler.getSessionInfo('g'.repeat(32));

      assert.equal(result, null);
    });

    it('rejects session ID with wrong length', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const result = await handler.getSessionInfo('a'.repeat(16));

      assert.equal(result, null);
    });

    it('rejects non-existent session', async () => {
      const handler = new TelegramBotHandler({
        botToken: 'test_token',
        enrollmentService: mockEnrollmentService,
        transport: mockTransport,
        enrollmentBaseUrl: 'https://example.com',
      });

      const result = await handler.getSessionInfo('a'.repeat(32));

      assert.equal(result, null);
    });
  });
});
