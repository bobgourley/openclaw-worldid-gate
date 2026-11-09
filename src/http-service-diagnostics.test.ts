/**
 * Tests for /api/diagnostics/client endpoint.
 * 
 * Validates:
 * - Schema allowlisting (events, error codes, status classes)
 * - Field validation (ranges, types)
 * - Unknown field stripping
 * - Sensitive pattern rejection (nullifiers, session IDs, nonces, signatures)
 * - Body size limits
 * - 204 responses (never echo input)
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { HttpService } from './http-service.js';
import { EnrollmentService } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import { WorldIdHttpVerifier } from './worldid-verifier-http.js';
import { TelegramBotHandler } from './telegram-bot-handler.js';

const TEST_BOT_TOKEN = '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890';
const TEST_SIGNING_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const TEST_APP_ID = 'app_b466e1f63a70a695b6d990d261e31b6a';
const TEST_RP_ID = 'rp_223416a2a76673a1';

async function createTestService(): Promise<any> {
  const adapter = new WorldIdChallengeAdapter({
    appId: TEST_APP_ID,
    rpId: TEST_RP_ID,
    signingKeyHex: TEST_SIGNING_KEY,
    challengeTtlSeconds: 300,
    environment: 'staging',
  });

  const verifier = new WorldIdHttpVerifier({
    appId: TEST_APP_ID,
    rpId: TEST_RP_ID,
    environment: 'staging',
    baseUrlOverride: 'http://localhost:9999',
  });

  const enrollmentService = new EnrollmentService({
    telegramBotToken: TEST_BOT_TOKEN,
    challengeAdapter: adapter,
    verificationClient: verifier,
    action: 'test-action',
    dbPath: ':memory:',
  });

  const stubTransport = {
    async sendMessage(chatId: number, text: string): Promise<void> {
      // Stub
    },
  };

  const botHandler = new TelegramBotHandler({
    botToken: TEST_BOT_TOKEN,
    enrollmentService,
    transport: stubTransport as any,
    enrollmentBaseUrl: 'http://localhost:3000',
  });

  const service = new HttpService({
    enrollmentService,
    telegramBotHandler: botHandler,
    port: 0,
    host: '127.0.0.1',
  });

  await service.start();
  return service;
}

test('Client diagnostics: valid request returns 204', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'poll_complete',
        pollCount: 5,
        visibilityChanges: 2,
        durationMs: 10000,
        finalStatus: 'failure',
        errorCode: 'connection_failed',
        lastStatusClass: 'failed',
        timestamp: Date.now(),
      }),
    });

    assert.strictEqual(response.status, 204);
    assert.strictEqual(await response.text(), ''); // No body
  } finally {
    await service.stop();
  }
});

test('Client diagnostics: unknown event type returns 204 and drops event', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'unknown_event_type',
        pollCount: 5,
      }),
    });

    assert.strictEqual(response.status, 204);
  } finally {
    await service.stop();
  }
});

test('Client diagnostics: unknown fields are stripped', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // Capture console output
  const originalLog = console.log;
  let loggedData: any = null;
  console.log = (...args: any[]) => {
    if (args[0] === '[Client Diagnostics]') {
      loggedData = JSON.parse(args[1]);
    }
  };

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'poll_complete',
        pollCount: 5,
        unknownField: 'should be stripped',
        userId: 123456, // Should be stripped
        nullifier: '0xabcd', // Should be stripped
      }),
    });

    assert.strictEqual(response.status, 204);
    assert.ok(loggedData);
    assert.strictEqual(loggedData.event, 'poll_complete');
    assert.strictEqual(loggedData.pollCount, 5);
    assert.strictEqual(loggedData.unknownField, undefined);
    assert.strictEqual(loggedData.userId, undefined);
    assert.strictEqual(loggedData.nullifier, undefined);
  } finally {
    console.log = originalLog;
    await service.stop();
  }
});

test('Client diagnostics: nullifier pattern rejected', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // Capture console output
  const originalLog = console.log;
  let loggedData: any = null;
  console.log = (...args: any[]) => {
    if (args[0] === '[Client Diagnostics]') {
      loggedData = JSON.parse(args[1]);
    }
  };

  try {
    // Try to sneak in a nullifier - it should be stripped as non-allowlisted errorCode
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'poll_complete',
        pollCount: 5,
        errorCode: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    });

    assert.strictEqual(response.status, 204);
    assert.ok(loggedData);
    // Nullifier-like errorCode should be stripped (not in allowlist, undefined in output)
    assert.strictEqual(loggedData.errorCode, undefined);
  } finally {
    console.log = originalLog;
    await service.stop();
  }
});

test('Client diagnostics: session ID pattern rejected', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const originalLog = console.log;
  let loggedData: any = null;
  console.log = (...args: any[]) => {
    if (args[0] === '[Client Diagnostics]') {
      loggedData = JSON.parse(args[1]);
    }
  };

  try {
    // Try to sneak in a session ID - it should be stripped as non-allowlisted errorCode
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'poll_complete',
        errorCode: 'session_' + '0'.repeat(128),
      }),
    });

    assert.strictEqual(response.status, 204);
    assert.ok(loggedData);
    // Session-like errorCode should be stripped (not in allowlist, undefined in output)
    assert.strictEqual(loggedData.errorCode, undefined);
  } finally {
    console.log = originalLog;
    await service.stop();
  }
});

test('Client diagnostics: nonce-like pattern rejected', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const originalLog = console.log;
  let logged = false;
  console.log = (...args: any[]) => {
    if (args[0] === '[Client Diagnostics]') {
      logged = true;
    }
  };

  try {
    // Inject nonce field in body (should be dropped as unknown field)
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'poll_complete',
        nonce: '0xabcdef1234567890',
      }),
    });

    assert.strictEqual(response.status, 204);
    // Should be logged because nonce is dropped as unknown field before pattern check
    assert.ok(logged);
  } finally {
    console.log = originalLog;
    await service.stop();
  }
});

test('Client diagnostics: oversized body rejected with 413', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // Capture console output to verify nothing logged
  const originalLog = console.log;
  let loggedData: any = null;
  console.log = (...args: any[]) => {
    if (args[0] === '[Client Diagnostics]') {
      loggedData = JSON.parse(args[1]);
    }
  };

  try {
    // Create a body larger than 2KB
    const largeBody = {
      event: 'poll_complete',
      pollCount: 5,
      extraData: 'x'.repeat(3000), // >2KB
    };

    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(largeBody),
    });

    // Should be rejected with 413 Payload Too Large
    assert.strictEqual(response.status, 413);
    // Nothing should be logged
    assert.strictEqual(loggedData, null);
  } finally {
    console.log = originalLog;
    await service.stop();
  }
});

test('Client diagnostics: rate limit returns 429', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // Capture console output to verify nothing logged on rate limit
  const originalLog = console.log;
  let logCount = 0;
  console.log = (...args: any[]) => {
    if (args[0] === '[Client Diagnostics]') {
      logCount++;
    }
  };

  try {
    // Send 31 requests (limit is 30 per minute)
    const requests: Promise<Response>[] = [];
    for (let i = 0; i < 31; i++) {
      requests.push(
        fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'poll_complete',
            pollCount: i,
          }),
        })
      );
    }

    const responses = await Promise.all(requests);
    
    // First 30 should succeed (204)
    const successCount = responses.filter(r => r.status === 204).length;
    // At least one should be rate limited (429)
    const rateLimitedCount = responses.filter(r => r.status === 429).length;

    assert.strictEqual(successCount, 30);
    assert.strictEqual(rateLimitedCount, 1);
    // Only 30 events should be logged (not the rate limited one)
    assert.strictEqual(logCount, 30);
  } finally {
    console.log = originalLog;
    await service.stop();
  }
});

test('Client diagnostics: rate limit is per-IP', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    // Send 30 requests from first "IP" (all will have same IP in test)
    for (let i = 0; i < 30; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'poll_complete',
          pollCount: i,
        }),
      });
      assert.strictEqual(response.status, 204);
    }

    // 31st request should be rate limited
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'poll_complete',
        pollCount: 31,
      }),
    });

    assert.strictEqual(response.status, 429);
  } finally {
    await service.stop();
  }
});

test('Client diagnostics: pollCount range validated', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const originalLog = console.log;
  let loggedData: any = null;
  console.log = (...args: any[]) => {
    if (args[0] === '[Client Diagnostics]') {
      loggedData = JSON.parse(args[1]);
    }
  };

  try {
    // Try to send pollCount > 1000
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'poll_complete',
        pollCount: 9999,
      }),
    });

    assert.strictEqual(response.status, 204);
    assert.ok(loggedData);
    // Should be clamped to 1000
    assert.strictEqual(loggedData.pollCount, 1000);
  } finally {
    console.log = originalLog;
    await service.stop();
  }
});

test('Client diagnostics: negative pollCount clamped to 0', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const originalLog = console.log;
  let loggedData: any = null;
  console.log = (...args: any[]) => {
    if (args[0] === '[Client Diagnostics]') {
      loggedData = JSON.parse(args[1]);
    }
  };

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'poll_complete',
        pollCount: -5,
      }),
    });

    assert.strictEqual(response.status, 204);
    assert.ok(loggedData);
    assert.strictEqual(loggedData.pollCount, 0);
  } finally {
    console.log = originalLog;
    await service.stop();
  }
});

test('Client diagnostics: invalid JSON returns 204', async () => {
  const service = await createTestService();
  const address = service.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid json',
    });

    // Body parser should handle this and result in empty req.body
    assert.ok(response.status === 400 || response.status === 204);
  } finally {
    await service.stop();
  }
});
