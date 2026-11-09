/**
 * Tests for Telegram API client (member tag management).
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { TelegramApiClient } from './telegram-api-client.js';

describe('TelegramApiClient', () => {
  describe('constructor', () => {
    it('requires bot token', () => {
      assert.throws(() => {
        new TelegramApiClient({ botToken: '' });
      }, /Bot token required/);
    });

    it('accepts valid config', () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      assert.ok(client);
    });
  });

  describe('setChatMemberTag', () => {
    it('validates chat ID', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      const result = await client.setChatMemberTag(0, 123, 'test');
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Chat ID required'));
    });

    it('validates user ID', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      const result = await client.setChatMemberTag(456, 0 as any, 'test');
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('User ID'));
    });

    it('validates tag length', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      const result = await client.setChatMemberTag(456, 123, 'x'.repeat(17));
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('16 character limit'));
    });

    it('rejects emoji', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      const result = await client.setChatMemberTag(456, 123, '✓ Verified');
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('emoji'));
    });

    it('accepts valid ASCII tag', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      
      // Mock fetch to return success
      const originalFetch = global.fetch;
      global.fetch = mock.fn(async () => ({
        json: async () => ({ ok: true }),
      })) as any;

      const result = await client.setChatMemberTag(456, 123, 'Human Verified');
      assert.strictEqual(result.success, true);

      global.fetch = originalFetch;
    });

    it('handles permission denied errors', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      
      const originalFetch = global.fetch;
      global.fetch = mock.fn(async () => ({
        json: async () => ({
          ok: false,
          description: 'not enough rights to manage tags',
        }),
      })) as any;

      const result = await client.setChatMemberTag(456, 123, 'test');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.permissionDenied, true);

      global.fetch = originalFetch;
    });

    it('handles invalid target errors', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      
      const originalFetch = global.fetch;
      global.fetch = mock.fn(async () => ({
        json: async () => ({
          ok: false,
          description: 'user is an administrator',
        }),
      })) as any;

      const result = await client.setChatMemberTag(456, 123, 'test');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.invalidTarget, true);

      global.fetch = originalFetch;
    });

    it('handles network errors', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      
      const originalFetch = global.fetch;
      global.fetch = mock.fn(async () => {
        throw new Error('Network timeout');
      }) as any;

      const result = await client.setChatMemberTag(456, 123, 'test');
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Network'));

      global.fetch = originalFetch;
    });
  });

  describe('removeChatMemberTag', () => {
    it('calls setChatMemberTag with empty string', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      
      const originalFetch = global.fetch;
      let capturedBody: any;
      global.fetch = mock.fn(async (_url: string, options: any) => {
        capturedBody = JSON.parse(options.body);
        return {
          json: async () => ({ ok: true }),
        };
      }) as any;

      await client.removeChatMemberTag(456, 123);
      assert.strictEqual(capturedBody.tag, undefined); // Empty string → undefined

      global.fetch = originalFetch;
    });
  });

  describe('checkTagPermission', () => {
    it('checks bot permissions', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      
      const originalFetch = global.fetch;
      let callCount = 0;
      global.fetch = mock.fn(async (url: string) => {
        callCount++;
        // First call: getMe
        if (callCount === 1) {
          return {
            json: async () => ({
              ok: true,
              result: { id: 123456 },
            }),
          };
        }
        // Second call: getChatMember
        return {
          json: async () => ({
            ok: true,
            result: {
              status: 'administrator',
              can_manage_tags: true,
            },
          }),
        };
      }) as any;

      const result = await client.checkTagPermission(456);
      assert.strictEqual(result.success, true);

      global.fetch = originalFetch;
    });

    it('fails when bot lacks can_manage_tags', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      
      const originalFetch = global.fetch;
      let callCount = 0;
      global.fetch = mock.fn(async (url: string) => {
        callCount++;
        // First call: getMe
        if (callCount === 1) {
          return {
            json: async () => ({
              ok: true,
              result: { id: 123456 },
            }),
          };
        }
        // Second call: getChatMember
        return {
          json: async () => ({
            ok: true,
            result: {
              status: 'administrator',
              can_manage_tags: false,
            },
          }),
        };
      }) as any;

      const result = await client.checkTagPermission(456);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('lacks can_manage_tags'));

      global.fetch = originalFetch;
    });

    it('fails when bot is not admin', async () => {
      const client = new TelegramApiClient({ botToken: 'test_token' });
      
      const originalFetch = global.fetch;
      let callCount = 0;
      global.fetch = mock.fn(async (url: string) => {
        callCount++;
        // First call: getMe
        if (callCount === 1) {
          return {
            json: async () => ({
              ok: true,
              result: { id: 123456 },
            }),
          };
        }
        // Second call: getChatMember
        return {
          json: async () => ({
            ok: true,
            result: {
              status: 'member',
            },
          }),
        };
      }) as any;

      const result = await client.checkTagPermission(456);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('not an administrator'));

      global.fetch = originalFetch;
    });
  });
});
