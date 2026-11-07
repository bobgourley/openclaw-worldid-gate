/**
 * HTTP service integration tests with production composition.
 *
 * Tests actual HTTP service with real enrollment service, SDK adapter, and mocked World API.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { HttpService } from './http-service.js';
import { EnrollmentService, type Clock, type BackendVerificationClient } from './enrollment-service-production.js';
import { WorldIdChallengeAdapter } from './worldid-challenge-adapter.js';
import type { IDKitResult, BackendVerificationResult, ExpectedVerificationContext } from './worldid-types.js';

// Throwaway test keys
const TEST_SIGNING_KEY = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_APP_ID = 'app_test1234567890abcdef1234567890';
const TEST_RP_ID = 'rp_test1234567890ab';
const TEST_BOT_TOKEN = 'test_bot_12345';
const TEST_ACTION = 'test-http-service';

// Fake clock
class FakeClock implements Clock {
  private currentSeconds: number;

  constructor(initialSeconds: number = Math.floor(Date.now() / 1000)) {
    this.currentSeconds = initialSeconds;
  }

  nowSeconds(): number {
    return this.currentSeconds;
  }

  nowISO(): string {
    return new Date(this.currentSeconds * 1000).toISOString();
  }

  advance(seconds: number): void {
    this.currentSeconds += seconds;
  }
}

// Mock verification client
class MockVerificationClient implements BackendVerificationClient {
  private responses: Map<string, BackendVerificationResult> = new Map();

  setResponse(nonce: string, result: BackendVerificationResult): void {
    this.responses.set(nonce, result);
  }

  async verify(
    idkitResult: IDKitResult,
    expectedContext: ExpectedVerificationContext
  ): Promise<BackendVerificationResult> {
    const response = this.responses.get(idkitResult.nonce);
    if (response) {
      return response;
    }

    return {
      success: true,
      nullifier: '12345678901234567890',
      issuerSchemaId: 1,
      expiresAtMin: Math.floor(Date.now() / 1000) + 86400,
    };
  }
}

// Generate valid initData
function createValidInitData(userId: number, botToken: string): string {
  const user = JSON.stringify({ id: userId, first_name: 'Test', username: 'testuser' });
  const authDate = Math.floor(Date.now() / 1000);

  const params: Record<string, string> = {
    user: user,
    auth_date: String(authDate),
  };

  const dataCheckString = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return `user=${encodeURIComponent(user)}&auth_date=${authDate}&hash=${hash}`;
}

// Create IDKitResult
function createIDKitResult(nonce: string, action: string, signalHash: string): IDKitResult {
  return {
    protocol_version: '4.0',
    nonce,
    action,
    responses: [
      {
        identifier: 'proof_of_human',
        signal_hash: signalHash,
        proof: ['1', '2', '3', '4', '5'],
        nullifier: '12345678901234567890',
        issuer_schema_id: 1,
        expires_at_min: Math.floor(Date.now() / 1000) + 86400,
      },
    ],
    environment: 'staging',
  };
}

describe('HttpService Integration', () => {
  let service: HttpService;
  let enrollmentService: EnrollmentService;
  let mockClient: MockVerificationClient;
  let fakeClock: FakeClock;
  let testDbPath: string;
  let testPort: number;

  beforeEach(async () => {
    // Generate unique identifiers for each test run
    const uniqueId = Math.floor(Math.random() * 1000000);
    testDbPath = `/tmp/test-http-service-${uniqueId}.db`;
    testPort = 13579 + (uniqueId % 1000);

    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    const adapter = new WorldIdChallengeAdapter({
      appId: TEST_APP_ID,
      rpId: TEST_RP_ID,
      signingKeyHex: TEST_SIGNING_KEY,
      challengeTtlSeconds: 300,
      environment: 'staging',
    });

    mockClient = new MockVerificationClient();
    fakeClock = new FakeClock();

    enrollmentService = new EnrollmentService({
      dbPath: testDbPath,
      challengeAdapter: adapter,
      verificationClient: mockClient,
      telegramBotToken: TEST_BOT_TOKEN,
      action: TEST_ACTION,
      challengeTtlSeconds: 300,
      enrollmentTtlSeconds: 2592000,
      clock: fakeClock,
    });

    service = new HttpService({
      enrollmentService,
      port: testPort,
      host: '127.0.0.1',
      bodyLimit: '1mb',
      requestTimeoutMs: 5000,
    });

    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    enrollmentService.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('startup and shutdown', () => {
    it('starts on localhost', async () => {
      // Service already started in beforeEach
      const response = await fetch(`http://127.0.0.1:${testPort}/health`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.status, 'healthy');
    });
  });

  describe('POST /api/challenge/create', () => {
    it('creates challenge with valid initData', async () => {
      const userId = 12345;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/challenge/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });

      assert.equal(response.status, 200);
      const data = await response.json();
      assert.ok(data.signedChallenge);
      assert.equal(data.signedChallenge.action, TEST_ACTION);
      assert.match(data.signedChallenge.nonce, /^0x[0-9a-f]{64}$/);
    });

    it('rejects invalid initData', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/challenge/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: 'invalid' }),
      });

      assert.equal(response.status, 401);
      const data = await response.json();
      assert.match(data.error, /authentication failed/i);
    });

    it('rejects missing initData', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/challenge/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      assert.equal(response.status, 400);
      const data = await response.json();
      assert.match(data.error, /initData required/i);
    });

    it('rejects malformed JSON', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/challenge/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });

      assert.equal(response.status, 400);
      const data = await response.json();
      assert.match(data.error, /invalid json/i);
    });

    it('rejects duplicate enrollment', async () => {
      const userId = 12345;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      // First enrollment
      const challenge1Response = await fetch(`http://127.0.0.1:${testPort}/api/challenge/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      const challenge1 = await challenge1Response.json();
      
      const idkitResult1 = createIDKitResult(
        challenge1.signedChallenge.nonce,
        TEST_ACTION,
        challenge1.signedChallenge.signalHash
      );

      await fetch(`http://127.0.0.1:${testPort}/api/enrollment/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, idkitResult: idkitResult1 }),
      });

      // Second attempt
      const response = await fetch(`http://127.0.0.1:${testPort}/api/challenge/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });

      assert.equal(response.status, 409);
      const data = await response.json();
      assert.match(data.error, /already enrolled/i);
    });
  });

  describe('POST /api/enrollment/complete', () => {
    it('completes enrollment with valid proof', async () => {
      const userId = 12345;
      const initData = createValidInitData(userId, TEST_BOT_TOKEN);

      // Create challenge
      const challengeResponse = await fetch(`http://127.0.0.1:${testPort}/api/challenge/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      const challenge = await challengeResponse.json();

      // Complete enrollment
      const idkitResult = createIDKitResult(
        challenge.signedChallenge.nonce,
        TEST_ACTION,
        challenge.signedChallenge.signalHash
      );

      const response = await fetch(`http://127.0.0.1:${testPort}/api/enrollment/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, idkitResult }),
      });

      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.success, true);
      assert.equal(data.telegramUserId, userId);
      assert.ok(data.expiresAt);
    });

    it('rejects missing initData', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/enrollment/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idkitResult: {} }),
      });

      assert.equal(response.status, 400);
      const data = await response.json();
      assert.match(data.error, /initData required/i);
    });

    it('rejects missing idkitResult', async () => {
      const initData = createValidInitData(12345, TEST_BOT_TOKEN);
      
      const response = await fetch(`http://127.0.0.1:${testPort}/api/enrollment/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });

      assert.equal(response.status, 400);
      const data = await response.json();
      assert.match(data.error, /idkitResult required/i);
    });
  });

  describe('404 handler', () => {
    it('returns 404 for unknown endpoints', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/unknown`);
      assert.equal(response.status, 404);
      const data = await response.json();
      assert.match(data.error, /not found/i);
    });
  });
});
