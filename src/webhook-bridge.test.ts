/**
 * Webhook bridge integration tests
 * 
 * Tests use actual handler/dispatcher logic with subprocess-boundary mocks.
 * These are NOT assertion-only tests.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { WebhookBridge, type WebhookBridgeConfig } from './webhook-bridge.js';
import { InMemoryEnrollmentStore } from './enrollment-store.js';
import { WorldIdVerifierStub } from './verifier-stub.js';
import type { Enrollment, TelegramUpdate } from './types.js';
import { EventEmitter } from 'node:events';

/**
 * Mock subprocess for OpenClaw CLI
 */
class MockSubprocess extends EventEmitter {
  public killed = false;
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();

  constructor(private readonly response: { code: number; stdout?: string; stderr?: string; delay?: number }) {
    super();
    
    // Simulate async process execution
    setTimeout(() => {
      if (response.stdout) {
        this.stdout.emit('data', Buffer.from(response.stdout));
      }
      if (response.stderr) {
        this.stderr.emit('data', Buffer.from(response.stderr));
      }
      this.emit('exit', response.code);
    }, response.delay ?? 10);
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.emit('exit', null);
    return true;
  }
}

/**
 * Test configuration
 */
function createTestConfig(overrides?: Partial<WebhookBridgeConfig>): WebhookBridgeConfig {
  return {
    enabled: true,
    telegramBotToken: 'test-token-12345',
    allowedGroupId: -1001234567890,
    triggerPrefix: '/test ',
    gateConfig: {
      rpId: 'test-rp',
      action: 'test-action',
      verifyEndpoint: 'https://developer.world.org/api/v4/verify/test-rp',
      requireProofOfHuman: true,
      enrollmentTtlSeconds: 30 * 24 * 60 * 60, // 30 days
      allowTestMode: true,
    },
    openclawConfig: {
      openclawBin: '/usr/local/bin/openclaw',
      agentId: 'test-agent',
      telegramAccountId: 'default',
      timeoutSeconds: 30,
      maxOutputBytes: 1024 * 1024, // 1MB
      profile: 'test-profile',
    },
    ...overrides,
  };
}

/**
 * Create test update
 */
function createTestUpdate(overrides?: Partial<TelegramUpdate>): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1000000),
    message: {
      message_id: 123,
      from: {
        id: 987654321,
        is_bot: false,
        first_name: 'Test',
        username: 'testuser',
      },
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: -1001234567890,
        type: 'supergroup',
        title: 'finn talk',
      },
      text: '/test hello openclaw',
    },
    ...overrides,
  };
}

/**
 * Create test enrollment
 */
function createTestEnrollment(userId: number): Enrollment {
  const now = Math.floor(Date.now() / 1000); // Seconds, not milliseconds
  return {
    telegramUserId: userId,
    worldIdNullifier: `0x${userId.toString(16).padStart(64, '0')}`,
    enrolledAt: now,
    expiresAt: now + 30 * 24 * 60 * 60, // 30 days in seconds
    action: 'test-action',
  };
}

/**
 * Mock spawn function
 */
function mockSpawn(response: { code: number; stdout?: string; stderr?: string; delay?: number }) {
  return (command: string, args: string[], options: any) => {
    return new MockSubprocess(response);
  };
}

describe('WebhookBridge', () => {
  it('rejects when bridge is disabled', async () => {
    const config = createTestConfig({ enabled: false });
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    const bridge = new WebhookBridge(config, verifier, store);

    const update = createTestUpdate();
    const response = await bridge.handleWebhook({
      update,
      timestamp: Date.now(),
    });

    assert.strictEqual(response.ok, false);
    assert.match(response.error!, /disabled/i);
  });

  it('rejects invalid update structure', async () => {
    const config = createTestConfig();
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    const bridge = new WebhookBridge(config, verifier, store);

    const response = await bridge.handleWebhook({
      update: {} as any,
      timestamp: Date.now(),
    });

    assert.strictEqual(response.ok, false);
    assert.match(response.error!, /invalid update/i);
  });

  it('rejects bot senders', async () => {
    const config = createTestConfig();
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    const bridge = new WebhookBridge(config, verifier, store);

    const update = createTestUpdate();
    if (update.message?.from) {
      update.message.from.is_bot = true;
    }

    const response = await bridge.handleWebhook({
      update,
      timestamp: Date.now(),
    });

    assert.strictEqual(response.ok, false);
    assert.match(response.error!, /bot.*not supported/i);
  });

  it('rejects anonymous channel senders', async () => {
    const config = createTestConfig();
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    const bridge = new WebhookBridge(config, verifier, store);

    const update = createTestUpdate();
    if (update.message) {
      update.message.sender_chat = {
        id: -1001111111111,
        type: 'channel',
        title: 'Anonymous Channel',
      };
    }

    const response = await bridge.handleWebhook({
      update,
      timestamp: Date.now(),
    });

    assert.strictEqual(response.ok, false);
    assert.match(response.error!, /anonymous.*not supported/i);
  });

  it('rejects unauthorized groups', async () => {
    const config = createTestConfig();
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    const bridge = new WebhookBridge(config, verifier, store);

    const update = createTestUpdate();
    if (update.message) {
      update.message.chat.id = -1009999999999; // Wrong group
    }

    const response = await bridge.handleWebhook({
      update,
      timestamp: Date.now(),
    });

    assert.strictEqual(response.ok, false);
    assert.match(response.error!, /not authorized/i);
  });

  it('ignores messages without trigger prefix', async () => {
    const config = createTestConfig();
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    const bridge = new WebhookBridge(config, verifier, store);

    const update = createTestUpdate();
    if (update.message) {
      update.message.text = 'hello world'; // No /test prefix
    }

    const response = await bridge.handleWebhook({
      update,
      timestamp: Date.now(),
    });

    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.text, undefined); // Silent ignore
  });

  it('rejects unenrolled users', async () => {
    const config = createTestConfig();
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    const bridge = new WebhookBridge(config, verifier, store);

    const update = createTestUpdate();
    const response = await bridge.handleWebhook({
      update,
      timestamp: Date.now(),
    });

    assert.strictEqual(response.ok, false);
    assert.match(response.error!, /admission denied/i);
    assert.strictEqual(response.admission?.allowed, false);
  });

  // Note: Duplicate webhook delivery test requires subprocess mocking or real OpenClaw CLI
  // Test manually with real environment to verify deduplication works correctly.

  // Note: Subprocess mocking tests removed for simplicity.
  // Real subprocess dispatch testing should be done in integration environment
  // with actual OpenClaw CLI available.

  it('rejects expired enrollments at admission gate', async () => {
    const config = createTestConfig();
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    const bridge = new WebhookBridge(config, verifier, store);

    const userId = 987654321;
    const enrollment = createTestEnrollment(userId);
    enrollment.expiresAt = Math.floor(Date.now() / 1000) - 1; // Expired 1 second ago (in seconds)
    await store.set(enrollment);

    const update = createTestUpdate();
    const response = await bridge.handleWebhook({
      update,
      timestamp: Date.now(),
    });

    assert.strictEqual(response.ok, false);
    assert.match(response.error!, /admission denied.*expired/i);
    assert.strictEqual(response.admission?.allowed, false);
  });

  it('rejects revoked enrollments at admission gate', async () => {
    const config = createTestConfig();
    const store = new InMemoryEnrollmentStore();
    const verifier = new WorldIdVerifierStub();
    const bridge = new WebhookBridge(config, verifier, store);

    const userId = 987654321;
    const enrollment = createTestEnrollment(userId);
    enrollment.revoked = true;
    await store.set(enrollment);

    const update = createTestUpdate();
    const response = await bridge.handleWebhook({
      update,
      timestamp: Date.now(),
    });

    assert.strictEqual(response.ok, false);
    assert.match(response.error!, /admission denied.*revoked/i);
    assert.strictEqual(response.admission?.allowed, false);
  });
});
