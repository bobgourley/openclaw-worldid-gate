/**
 * Server startup tests.
 *
 * Tests production readiness checks and fail-closed behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Server startup', () => {
  describe('missing configuration (fail-closed)', () => {
    it('exits with code 1 when WORLDID_APP_ID is missing', async () => {
      const serverPath = join(__dirname, 'server.ts');
      
      const child = spawn('tsx', [serverPath], {
        env: {
          ...process.env,
          WORLDID_APP_ID: undefined,
          WORLDID_RP_ID: 'rp_test123',
          WORLDID_SIGNING_KEY_HEX: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          TELEGRAM_BOT_TOKEN: 'test_token',
          WORLDID_ACTION: 'test-action',
        },
        timeout: 5000,
      });

      let stderr = '';
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const exitCode = await new Promise<number>((resolve) => {
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
      });

      assert.equal(exitCode, 1, 'Should exit with code 1');
      assert.match(stderr, /not configured|production readiness/i, 'Should explain missing configuration');
    });

    it('exits with code 1 when WORLDID_RP_ID is missing', async () => {
      const serverPath = join(__dirname, 'server.ts');
      
      const child = spawn('tsx', [serverPath], {
        env: {
          ...process.env,
          WORLDID_APP_ID: 'app_test123',
          WORLDID_RP_ID: undefined,
          WORLDID_SIGNING_KEY_HEX: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          TELEGRAM_BOT_TOKEN: 'test_token',
          WORLDID_ACTION: 'test-action',
        },
        timeout: 5000,
      });

      let stderr = '';
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const exitCode = await new Promise<number>((resolve) => {
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
      });

      assert.equal(exitCode, 1, 'Should exit with code 1');
      assert.match(stderr, /not configured|production readiness/i, 'Should explain missing configuration');
    });

    it('exits with code 1 when TELEGRAM_BOT_TOKEN is missing', async () => {
      const serverPath = join(__dirname, 'server.ts');
      
      const child = spawn('tsx', [serverPath], {
        env: {
          ...process.env,
          WORLDID_APP_ID: 'app_test123',
          WORLDID_RP_ID: 'rp_test123',
          WORLDID_SIGNING_KEY_HEX: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          TELEGRAM_BOT_TOKEN: undefined,
          WORLDID_ACTION: 'test-action',
        },
        timeout: 5000,
      });

      let stderr = '';
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const exitCode = await new Promise<number>((resolve) => {
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
      });

      assert.equal(exitCode, 1, 'Should exit with code 1');
      assert.match(stderr, /not configured|production readiness/i, 'Should explain missing configuration');
    });
  });
});
