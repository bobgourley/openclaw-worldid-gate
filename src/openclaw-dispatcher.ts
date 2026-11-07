/**
 * OpenClaw CLI dispatcher
 * 
 * Safely invokes the OpenClaw agent CLI with bounded execution.
 * 
 * Security boundaries:
 * - No shell interpolation (uses spawn array arguments)
 * - No user-controlled agent ID, session key, or flags
 * - No --deliver or recipient routing
 * - Bounded timeout and output size
 * - Temporary files cleaned up with restricted permissions
 * - Session identity deterministically partitioned by account/group/user
 * 
 * Session key format: telegram:{accountId}:{groupId}:{userId}
 * This ensures each (account, group, user) tuple gets an isolated session.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface OpenClawDispatchConfig {
  /** Path to openclaw executable */
  openclawBin: string;
  /** Agent ID (must be pre-configured, not user-controlled) */
  agentId: string;
  /** Telegram account ID for session partitioning */
  telegramAccountId: string;
  /** Default timeout in seconds */
  timeoutSeconds: number;
  /** Maximum output size in bytes */
  maxOutputBytes: number;
  /** Optional --profile flag for isolated config */
  profile?: string;
}

export interface DispatchRequest {
  /** Numeric Telegram user ID (authenticated) */
  telegramUserId: number;
  /** Telegram group/chat ID */
  chatId: number;
  /** Message text */
  text: string;
}

export interface DispatchResult {
  success: boolean;
  response?: string;
  error?: string;
  timeout?: boolean;
}

/**
 * Build deterministic session key
 * Format: telegram:{accountId}:{chatId}:{userId}
 */
function buildSessionKey(accountId: string, chatId: number, userId: number): string {
  return `telegram:${accountId}:${chatId}:${userId}`;
}

/**
 * Dispatch text message to OpenClaw agent CLI
 */
export async function dispatchToOpenClaw(
  config: OpenClawDispatchConfig,
  request: DispatchRequest
): Promise<DispatchResult> {
  const messageFile = join(tmpdir(), `openclaw-msg-${randomBytes(16).toString('hex')}.txt`);
  let outputBuffer = '';
  let errorBuffer = '';
  let timeoutTriggered = false;

  try {
    // Write message to temporary file with restricted permissions
    await writeFile(messageFile, request.text, { encoding: 'utf8', mode: 0o600 });
    await chmod(messageFile, 0o600); // Ensure restricted even if writeFile mode failed

    const sessionKey = buildSessionKey(
      config.telegramAccountId,
      request.chatId,
      request.telegramUserId
    );

    // Build args array (no shell interpolation)
    const args = [
      'agent',
      '--agent', config.agentId,
      '--message-file', messageFile,
      '--session-key', sessionKey,
      '--json',
      '--timeout', config.timeoutSeconds.toString(),
      // --deliver defaults to false (no outbound routing)
    ];

    if (config.profile) {
      args.unshift('--profile', config.profile);
    }

    // Spawn process with bounded execution
    const child = spawn(config.openclawBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: config.timeoutSeconds * 1000 + 5000, // Add 5s buffer for process overhead
      env: {
        ...process.env,
        // Prevent token leakage
        OPENCLAW_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN: undefined,
      },
    });

    let outputSize = 0;
    const maxSize = config.maxOutputBytes;

    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize <= maxSize) {
        outputBuffer += chunk.toString('utf8');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (errorBuffer.length < 4096) { // Bounded error buffer
        errorBuffer += text;
      }
    });

    // Wait for process completion
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(null));
      
      // Timeout handler
      setTimeout(() => {
        if (!child.killed) {
          timeoutTriggered = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 2000);
        }
      }, config.timeoutSeconds * 1000 + 4000);
    });

    if (timeoutTriggered) {
      return {
        success: false,
        error: 'OpenClaw agent timeout exceeded',
        timeout: true,
      };
    }

    if (exitCode !== 0) {
      return {
        success: false,
        error: `OpenClaw agent exited with code ${exitCode}: ${errorBuffer.trim()}`,
      };
    }

    if (outputSize > maxSize) {
      return {
        success: false,
        error: `OpenClaw agent output exceeded ${maxSize} bytes`,
      };
    }

    // Parse JSON output
    try {
      const parsed = JSON.parse(outputBuffer.trim());
      const responseText = parsed.response || parsed.text || JSON.stringify(parsed);
      return {
        success: true,
        response: responseText.slice(0, 4096), // Bounded response
      };
    } catch (parseError) {
      return {
        success: false,
        error: `Failed to parse OpenClaw response: ${String(parseError)}`,
      };
    }

  } catch (error) {
    return {
      success: false,
      error: `OpenClaw dispatch failed: ${String(error)}`,
    };
  } finally {
    // Cleanup temporary message file
    try {
      await unlink(messageFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Subprocess runner interface for testing
 */
export interface SubprocessRunner {
  spawn(
    command: string,
    args: string[],
    options: any
  ): {
    stdout: { on: (event: string, handler: (chunk: Buffer) => void) => void };
    stderr: { on: (event: string, handler: (chunk: Buffer) => void) => void };
    on: (event: string, handler: (code: number | null) => void) => void;
    kill: (signal?: string) => boolean;
    killed: boolean;
  };
}
