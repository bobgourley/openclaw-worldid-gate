/**
 * Tests for OpenClaw dispatcher context logging.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dispatchToOpenClaw } from './openclaw-dispatcher.js';
import { writeFile, unlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('OpenClaw Dispatcher Context', () => {
  it('should log enrollment expiry context', async () => {
    const fakeCliPath = join(tmpdir(), `fake-cli-${Date.now()}.sh`);
    await writeFile(
      fakeCliPath,
      '#!/bin/bash\necho \'{"status":"ok","result":{"payloads":[{"text":"Response"}]}}\'\nexit 0\n',
      { mode: 0o755 }
    );
    await chmod(fakeCliPath, 0o755);

    try {
      // Capture console.log output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(' '));
      };

      try {
        const expiresAt = Math.floor(Date.now() / 1000) + 86400; // Tomorrow
        const expiryDate = new Date(expiresAt * 1000).toISOString().split('T')[0];

        const result = await dispatchToOpenClaw(
          {
            openclawBin: fakeCliPath,
            agentId: 'test-agent',
            telegramAccountId: 'test',
            timeoutSeconds: 5,
            maxOutputBytes: 1024,
            profile: 'test-profile',
          },
          {
            telegramUserId: 123,
            chatId: -456,
            text: 'test message',
            preSpawnCheck: async () => ({
              allowed: true,
              enrollmentExpiresAt: expiresAt,
            }),
          }
        );

        // Verify context line was logged
        const contextLog = logs.find(log => log.includes('[gate] sender World ID verified'));
        assert.ok(contextLog, 'Context log line not found');
        assert.ok(contextLog.includes(`expires ${expiryDate}`), `Context log should include expiry date ${expiryDate}`);

        assert.strictEqual(result.success, true);
      } finally {
        console.log = originalLog;
      }
    } finally {
      await unlink(fakeCliPath);
    }
  });

  it('should not log context when enrollmentExpiresAt not provided', async () => {
    const fakeCliPath = join(tmpdir(), `fake-cli-${Date.now()}.sh`);
    await writeFile(
      fakeCliPath,
      '#!/bin/bash\necho \'{"status":"ok","result":{"payloads":[{"text":"Response"}]}}\'\nexit 0\n',
      { mode: 0o755 }
    );
    await chmod(fakeCliPath, 0o755);

    try {
      // Capture console.log output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(' '));
      };

      try {
        const result = await dispatchToOpenClaw(
          {
            openclawBin: fakeCliPath,
            agentId: 'test-agent',
            telegramAccountId: 'test',
            timeoutSeconds: 5,
            maxOutputBytes: 1024,
            profile: 'test-profile',
          },
          {
            telegramUserId: 123,
            chatId: -456,
            text: 'test message',
            preSpawnCheck: async () => ({
              allowed: true,
              // No enrollmentExpiresAt
            }),
          }
        );

        // Verify context line was NOT logged
        const contextLog = logs.find(log => log.includes('[gate] sender World ID verified'));
        assert.ok(!contextLog, 'Context log line should not be present without enrollmentExpiresAt');

        assert.strictEqual(result.success, true);
      } finally {
        console.log = originalLog;
      }
    } finally {
      await unlink(fakeCliPath);
    }
  });
});
