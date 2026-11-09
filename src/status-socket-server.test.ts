/**
 * Tests for Unix domain socket server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StatusSocketServer, loadStatusSecret } from './status-socket-server.js';
import { EnrollmentService } from './enrollment-service-production.js';
import { writeFile, unlink, mkdir, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

describe('StatusSocketServer', () => {
  it('should start with mode 0600', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const socketPath = join(testDir, 'test.sock');
    const mockService = {
      findEnrollment: async () => null,
    } as any;

    const server = new StatusSocketServer({
      socketPath,
      secret: 'test-secret-12345678901234567890',
      enrollmentService: mockService,
    });

    try {
      await server.start();

      // Check socket permissions
      const stats = await stat(socketPath);
      const mode = stats.mode & 0o777;
      assert.strictEqual(mode, 0o600, 'Socket should have mode 0600');

      await server.stop();
    } finally {
      try {
        await unlink(socketPath);
      } catch {}
    }
  });

  it('should require bearer authentication', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const socketPath = join(testDir, 'test.sock');
    const secret = 'test-secret-12345678901234567890';
    const mockService = {
      findEnrollment: async () => null,
    } as any;

    const server = new StatusSocketServer({
      socketPath,
      secret,
      enrollmentService: mockService,
    });

    try {
      await server.start();

      // Try without auth
      const resultNoAuth = await makeSocketRequest(socketPath, '/status/123', '');
      assert.strictEqual(resultNoAuth.statusCode, 401);

      // Try with wrong auth
      const resultWrongAuth = await makeSocketRequest(socketPath, '/status/123', 'Bearer wrong-secret');
      assert.strictEqual(resultWrongAuth.statusCode, 401);

      // Try with correct auth
      const resultCorrectAuth = await makeSocketRequest(socketPath, '/status/123', `Bearer ${secret}`);
      assert.strictEqual(resultCorrectAuth.statusCode, 200);

      await server.stop();
    } finally {
      try {
        await unlink(socketPath);
      } catch {}
    }
  });

  it('should return none state for unknown user', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const socketPath = join(testDir, 'test.sock');
    const secret = 'test-secret-12345678901234567890';
    const mockService = {
      findEnrollment: async (userId: number) => null,
      action: 'test-action',
    } as any;

    const server = new StatusSocketServer({
      socketPath,
      secret,
      enrollmentService: mockService,
    });

    try {
      await server.start();

      const result = await makeSocketRequest(socketPath, '/status/123', `Bearer ${secret}`);
      assert.strictEqual(result.statusCode, 200);

      const data = JSON.parse(result.body);
      assert.strictEqual(data.verified, false);
      assert.strictEqual(data.state, 'none');
      assert.strictEqual(data.expiresAt, null);
      assert.strictEqual(data.action, 'test-action');

      await server.stop();
    } finally {
      try {
        await unlink(socketPath);
      } catch {}
    }
  });

  it('should return active state for valid enrollment', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const socketPath = join(testDir, 'test.sock');
    const secret = 'test-secret-12345678901234567890';
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400;

    const mockService = {
      findEnrollment: async (userId: number) => ({
        nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        telegramUserId: userId,
        action: 'test-action',
        expiresAt: futureExpiry,
        createdAt: new Date().toISOString(),
        revoked: false,
        expired: false,
      }),
      action: 'test-action',
    } as any;

    const server = new StatusSocketServer({
      socketPath,
      secret,
      enrollmentService: mockService,
    });

    try {
      await server.start();

      const result = await makeSocketRequest(socketPath, '/status/123', `Bearer ${secret}`);
      assert.strictEqual(result.statusCode, 200);

      const data = JSON.parse(result.body);
      assert.strictEqual(data.verified, true);
      assert.strictEqual(data.state, 'active');
      assert.strictEqual(data.expiresAt, futureExpiry);
      assert.strictEqual(data.action, 'test-action');

      await server.stop();
    } finally {
      try {
        await unlink(socketPath);
      } catch {}
    }
  });

  it('should return expired state for expired enrollment', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const socketPath = join(testDir, 'test.sock');
    const secret = 'test-secret-12345678901234567890';
    const pastExpiry = Math.floor(Date.now() / 1000) - 86400;

    const mockService = {
      findEnrollment: async (userId: number) => ({
        nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        telegramUserId: userId,
        action: 'test-action',
        expiresAt: pastExpiry,
        createdAt: new Date().toISOString(),
        revoked: false,
        expired: true,
      }),
      action: 'test-action',
    } as any;

    const server = new StatusSocketServer({
      socketPath,
      secret,
      enrollmentService: mockService,
    });

    try {
      await server.start();

      const result = await makeSocketRequest(socketPath, '/status/123', `Bearer ${secret}`);
      assert.strictEqual(result.statusCode, 200);

      const data = JSON.parse(result.body);
      assert.strictEqual(data.verified, false);
      assert.strictEqual(data.state, 'expired');

      await server.stop();
    } finally {
      try {
        await unlink(socketPath);
      } catch {}
    }
  });

  it('should return revoked state for revoked enrollment', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const socketPath = join(testDir, 'test.sock');
    const secret = 'test-secret-12345678901234567890';
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400;

    const mockService = {
      findEnrollment: async (userId: number) => ({
        nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        telegramUserId: userId,
        action: 'test-action',
        expiresAt: futureExpiry,
        createdAt: new Date().toISOString(),
        revoked: true,
        expired: false,
      }),
      action: 'test-action',
    } as any;

    const server = new StatusSocketServer({
      socketPath,
      secret,
      enrollmentService: mockService,
    });

    try {
      await server.start();

      const result = await makeSocketRequest(socketPath, '/status/123', `Bearer ${secret}`);
      assert.strictEqual(result.statusCode, 200);

      const data = JSON.parse(result.body);
      assert.strictEqual(data.verified, false);
      assert.strictEqual(data.state, 'revoked');

      await server.stop();
    } finally {
      try {
        await unlink(socketPath);
      } catch {}
    }
  });

  it('should return 404 for invalid paths', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const socketPath = join(testDir, 'test.sock');
    const secret = 'test-secret-12345678901234567890';
    const mockService = {
      findEnrollment: async () => null,
    } as any;

    const server = new StatusSocketServer({
      socketPath,
      secret,
      enrollmentService: mockService,
    });

    try {
      await server.start();

      const result = await makeSocketRequest(socketPath, '/invalid', `Bearer ${secret}`);
      assert.strictEqual(result.statusCode, 404);

      await server.stop();
    } finally {
      try {
        await unlink(socketPath);
      } catch {}
    }
  });

  it('should only accept numeric user IDs', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const socketPath = join(testDir, 'test.sock');
    const secret = 'test-secret-12345678901234567890';
    const mockService = {
      findEnrollment: async () => null,
    } as any;

    const server = new StatusSocketServer({
      socketPath,
      secret,
      enrollmentService: mockService,
    });

    try {
      await server.start();

      const result = await makeSocketRequest(socketPath, '/status/abc', `Bearer ${secret}`);
      assert.strictEqual(result.statusCode, 404);

      await server.stop();
    } finally {
      try {
        await unlink(socketPath);
      } catch {}
    }
  });
});

describe('loadStatusSecret', () => {
  it('should load secret from file', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const secretFile = join(testDir, 'secret.txt');
    await writeFile(secretFile, 'my-secret-token-1234567890123456\n', { mode: 0o600 });

    const secret = await loadStatusSecret(secretFile);
    assert.strictEqual(secret, 'my-secret-token-1234567890123456');

    await unlink(secretFile);
  });

  it('should reject short secrets', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const secretFile = join(testDir, 'secret.txt');
    await writeFile(secretFile, 'short\n', { mode: 0o600 });

    await assert.rejects(
      async () => await loadStatusSecret(secretFile),
      /Secret must be at least 32 characters/
    );

    await unlink(secretFile);
  });

  it('should reject empty secrets', async () => {
    const testDir = join(tmpdir(), `worldid-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const secretFile = join(testDir, 'secret.txt');
    await writeFile(secretFile, '\n', { mode: 0o600 });

    await assert.rejects(
      async () => await loadStatusSecret(secretFile),
      /Secret file is empty/
    );

    await unlink(secretFile);
  });
});

/**
 * Helper to make HTTP request over Unix socket.
 */
async function makeSocketRequest(
  socketPath: string,
  path: string,
  authHeader: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath,
      path,
      method: 'GET',
      headers: authHeader ? { Authorization: authHeader } : {},
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 500, body });
      });
    });

    req.on('error', reject);
    req.end();
  });
}
