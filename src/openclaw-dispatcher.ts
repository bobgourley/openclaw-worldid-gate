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
 * 
 * OpenClaw CLI JSON output schema (from fc23bc864e4553c2d215e479eeec47b67a0bf943):
 * src/commands/agent-via-gateway.ts:81-96 (type definitions)
 * src/commands/agent-via-gateway.ts:876-885 (JSON builder)
 * src/commands/agent-via-gateway.ts:1127-1129 (output call)
 * 
 * Schema:
 * {
 *   runId?: string;
 *   status?: string;  // "ok" or "completed" for success
 *   summary?: string;
 *   result?: {
 *     payloads?: Array<{
 *       text?: string;              // Model-visible text
 *       mediaUrl?: string | null;
 *       mediaUrls?: string[];
 *     }>;
 *     deliveryStatus?: unknown;
 *     meta?: unknown;
 *   };
 *   deliveryStatus?: unknown;
 * }
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
  /** Required --profile flag for isolated config */
  profile: string;
}

export interface DispatchRequest {
  /** Numeric Telegram user ID (authenticated) */
  telegramUserId: number;
  /** Telegram group/chat ID */
  chatId: number;
  /** Message text */
  text: string;
  /** Pre-spawn admission check (called after file prep, before spawn) */
  preSpawnCheck?: () => Promise<{ allowed: boolean; reason?: string; enrollmentExpiresAt?: number }>;
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
  let timeoutHandle: NodeJS.Timeout | null = null;
  let sigkillHandle: NodeJS.Timeout | null = null;

  try {
    // Write message to temporary file with restricted permissions
    await writeFile(messageFile, request.text, { encoding: 'utf8', mode: 0o600 });
    await chmod(messageFile, 0o600); // Ensure restricted even if writeFile mode failed

    // Fresh admission check AFTER async file prep, BEFORE spawn
    if (request.preSpawnCheck) {
      const checkResult = await request.preSpawnCheck();
      if (!checkResult.allowed) {
        return {
          success: false,
          error: checkResult.reason || 'Pre-spawn admission check failed',
        };
      }
      
      // Log enrollment context (privacy-safe: expiry date only, no nullifier)
      if (checkResult.enrollmentExpiresAt) {
        const expiryDate = new Date(checkResult.enrollmentExpiresAt * 1000).toISOString().split('T')[0];
        console.log(`[gate] sender World ID verified, expires ${expiryDate}`);
      }
    }

    const sessionKey = buildSessionKey(
      config.telegramAccountId,
      request.chatId,
      request.telegramUserId
    );

    // Build args array (no shell interpolation)
    const args = [
      '--profile', config.profile,
      'agent',
      '--agent', config.agentId,
      '--message-file', messageFile,
      '--session-key', sessionKey,
      '--json',
      '--timeout', config.timeoutSeconds.toString(),
      // --deliver defaults to false (no outbound routing)
    ];

    // Spawn process with bounded execution
    const child = spawn(config.openclawBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Prevent token leakage
        OPENCLAW_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN: undefined,
      },
    });

    let outputSize = 0;
    const maxSize = config.maxOutputBytes;
    let processExited = false;

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

    // Wait for process completion and stdout close
    const exitCode = await new Promise<number | null>((resolve) => {
      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (sigkillHandle) clearTimeout(sigkillHandle);
      };

      let exitReceived = false;
      let stdoutClosed = false;
      let finalExitCode: number | null = null;

      const checkComplete = () => {
        if (exitReceived && stdoutClosed) {
          cleanup();
          resolve(finalExitCode);
        }
      };

      child.on('exit', (code) => {
        processExited = true;
        exitReceived = true;
        finalExitCode = code;
        checkComplete();
      });

      child.stdout.on('close', () => {
        stdoutClosed = true;
        checkComplete();
      });

      child.on('error', (err) => {
        cleanup();
        resolve(null);
      });

      // Timeout handler
      timeoutHandle = setTimeout(() => {
        if (!processExited) {
          timeoutTriggered = true;
          child.kill('SIGTERM');
          // Escalate to SIGKILL after 2 seconds
          sigkillHandle = setTimeout(() => {
            if (!processExited) {
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
        error: `OpenClaw agent exited with code ${exitCode}`,
      };
    }

    if (outputSize > maxSize) {
      return {
        success: false,
        error: `OpenClaw agent output exceeded ${maxSize} bytes`,
      };
    }

    // Parse JSON output (actual OpenClaw schema from fc23bc864e4553c2d215e479eeec47b67a0bf943)
    try {
      const parsed = JSON.parse(outputBuffer.trim()) as {
        runId?: string;
        status?: string;
        summary?: string;
        result?: {
          payloads?: Array<{
            text?: string;
            mediaUrl?: string | null;
            mediaUrls?: string[];
          }>;
          deliveryStatus?: unknown;
          meta?: unknown;
        };
        deliveryStatus?: unknown;
      };

      // Extract model-visible text from first payload (fail closed on unknown schema)
      if (!parsed.result || !parsed.result.payloads || parsed.result.payloads.length === 0) {
        return {
          success: false,
          error: 'OpenClaw response missing result.payloads',
        };
      }

      const firstPayload = parsed.result.payloads[0];
      if (!firstPayload || typeof firstPayload.text !== 'string') {
        return {
          success: false,
          error: 'OpenClaw response missing text in first payload',
        };
      }

      return {
        success: true,
        response: firstPayload.text.slice(0, 4096), // Bounded response
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
    // Cleanup timeout timers
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (sigkillHandle) clearTimeout(sigkillHandle);

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
