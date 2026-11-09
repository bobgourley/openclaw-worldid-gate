/**
 * Unix domain socket server for private enrollment status queries.
 * 
 * SECURITY:
 * - Unix socket with mode 0600 (owner-only)
 * - Bearer authentication with constant-time compare
 * - Rate limiting per query
 * - Privacy-safe fields only (no nullifiers, proofs, nonces, signatures)
 * - Must NEVER be exposed on the public HTTP server
 */

import http from 'node:http';
import { unlink, chmod, readFile, lstat, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EnrollmentService } from './enrollment-service-production.js';
import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * Global rate limiter for socket queries with automatic cleanup.
 */
class SocketRateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly windowMs: number = 60000; // 1 minute
  private readonly maxRequestsPerEndpoint: number = 100; // 100 requests per minute per endpoint
  private readonly maxGlobalRequests: number = 1000; // 1000 requests per minute global
  private lastCleanup: number = Date.now();

  check(key: string): boolean {
    const now = Date.now();
    
    // Periodic cleanup (every 5 minutes)
    if (now - this.lastCleanup > 300000) {
      this.evictStale(now);
    }
    
    // Global rate limit
    const allTimestamps: number[] = [];
    for (const timestamps of this.requests.values()) {
      allTimestamps.push(...timestamps);
    }
    const cutoff = now - this.windowMs;
    const recentGlobal = allTimestamps.filter(t => t > cutoff);
    if (recentGlobal.length >= this.maxGlobalRequests) {
      return false;
    }
    
    // Per-endpoint rate limit
    let timestamps = this.requests.get(key) || [];
    timestamps = timestamps.filter(t => t > cutoff);
    
    if (timestamps.length >= this.maxRequestsPerEndpoint) {
      return false;
    }
    
    timestamps.push(now);
    this.requests.set(key, timestamps);
    return true;
  }

  private evictStale(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.requests.entries()) {
      const recent = timestamps.filter(t => t > cutoff);
      if (recent.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, recent);
      }
    }
    this.lastCleanup = now;
  }
}

/**
 * Status socket server configuration.
 */
export interface StatusSocketConfig {
  /** Unix domain socket path */
  socketPath: string;
  
  /** Bearer secret for authentication (read from file) */
  secret: string;
  
  /** Enrollment service for queries */
  enrollmentService: EnrollmentService;
}

/**
 * Status socket server for private enrollment queries.
 */
export class StatusSocketServer {
  private server: http.Server | null = null;
  private readonly config: StatusSocketConfig;
  private readonly rateLimiter = new SocketRateLimiter();

  constructor(config: StatusSocketConfig) {
    this.config = config;
  }

  /**
   * Start the Unix socket server.
   */
  async start(): Promise<void> {
    // Check for stale socket
    if (existsSync(this.config.socketPath)) {
      let stats;
      try {
        stats = await lstat(this.config.socketPath);
      } catch (error) {
        throw new Error(`Cannot stat socket path: ${error}`);
      }

      if (!stats.isSocket()) {
        throw new Error(`Socket path exists but is not a socket (refusing to unlink)`);
      }

      // Try connecting to check if socket is live
      const liveCheck = await this.checkSocketLive(this.config.socketPath);
      if (liveCheck === 'live') {
        throw new Error(`Socket is live (another instance running)`);
      }
      if (liveCheck === 'timeout') {
        throw new Error(`Socket check timed out (refusing to unlink, unknown state)`);
      }

      // Safe to remove stale socket (liveCheck === 'dead')
      await unlink(this.config.socketPath);
    }

    // Ensure directory exists with mode 0700
    const socketDir = dirname(this.config.socketPath);
    await mkdir(socketDir, { recursive: true, mode: 0o700 });

    this.server = http.createServer(async (req, res) => {
      await this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error('Server not initialized'));
        return;
      }

      // Set umask to 0177 before listen (socket will be 0600)
      const oldMask = process.umask(0o177);
      
      this.server.listen(this.config.socketPath, async () => {
        // Restore old umask
        process.umask(oldMask);
        
        try {
          // Verify socket was created with mode 0600 by umask
          const stats = statSync(this.config.socketPath);
          const mode = stats.mode & 0o777;
          
          if (mode !== 0o600) {
            // umask didn't work, fail rather than trying to fix
            this.server?.close();
            throw new Error(`Socket created with wrong mode ${mode.toString(8)}, expected 0600 (umask failed)`);
          }
          
          console.log(`[StatusSocket] Listening on ${this.config.socketPath} (mode 0600)`);
          resolve();
        } catch (error) {
          this.server?.close();
          reject(error);
        }
      });

      this.server.on('error', (error: any) => {
        // Restore umask on error
        process.umask(oldMask);
        this.server?.close();
        reject(error);
      });
    });
  }

  /**
   * Check if socket is live by attempting connection.
   * Returns 'live' if socket responds, 'dead' if connection fails, 'timeout' if no response.
   */
  private async checkSocketLive(socketPath: string): Promise<'live' | 'dead' | 'timeout'> {
    return new Promise((resolve) => {
      const client = http.request(
        {
          socketPath,
          path: '/health',
          method: 'GET',
          timeout: 1000,
        },
        () => {
          resolve('live'); // Socket answered
        }
      );

      client.on('error', () => {
        resolve('dead'); // Socket not live
      });

      client.on('timeout', () => {
        client.destroy();
        resolve('timeout'); // Timeout - unknown state
      });

      client.end();
    });
  }

  /**
   * Stop the Unix socket server.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      // Force close all active connections immediately
      this.server!.closeAllConnections?.();
      
      this.server!.close(async (error) => {
        if (error) {
          reject(error);
        } else {
          // Clean up socket file
          try {
            if (existsSync(this.config.socketPath)) {
              await unlink(this.config.socketPath);
            }
          } catch {
            // Ignore cleanup errors
          }
          resolve();
        }
      });
    });
  }

  /**
   * Handle incoming request.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Only handle GET requests
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Check bearer authentication
    const authHeader = req.headers['authorization'];
    if (!this.verifyAuth(authHeader)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Parse URL
    const url = new URL(req.url || '', 'http://localhost');
    
    // Match /status/:telegramUserId
    const match = url.pathname.match(/^\/status\/(\d+)$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const telegramUserId = parseInt(match[1], 10);

    // Rate limiting
    if (!this.rateLimiter.check(`status:${telegramUserId}`)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }

    // Query enrollment
    try {
      const enrollment = await this.config.enrollmentService.findEnrollment(telegramUserId);

      if (!enrollment) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          verified: false,
          state: 'none',
          expiresAt: null,
          action: this.config.enrollmentService['action'], // Access private field for action
        }));
        return;
      }

      // Determine state
      let state: 'active' | 'expired' | 'revoked' | 'none';
      if (enrollment.revoked) {
        state = 'revoked';
      } else if (enrollment.expired) {
        state = 'expired';
      } else {
        state = 'active';
      }

      // Return status (privacy-safe fields only)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        verified: state === 'active',
        state,
        expiresAt: enrollment.expiresAt,
        action: enrollment.action,
      }));
    } catch (error) {
      console.error('[StatusSocket] Query error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  /**
   * Verify bearer authentication with constant-time compare.
   * Hash both sides before comparison to ensure equal length.
   */
  private verifyAuth(authHeader: string | undefined): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }

    const providedSecret = authHeader.slice(7); // Remove "Bearer " prefix
    
    // Hash both sides to ensure equal length for timingSafeEqual
    try {
      const expectedHash = createHash('sha256').update(this.config.secret, 'utf8').digest();
      const providedHash = createHash('sha256').update(providedSecret, 'utf8').digest();
      
      return timingSafeEqual(expectedHash, providedHash);
    } catch {
      return false;
    }
  }
}

/**
 * Load secret from file and enforce mode 0600.
 */
export async function loadStatusSecret(secretFile: string): Promise<string> {
  try {
    // Check file permissions
    const stats = await lstat(secretFile);
    const mode = stats.mode & 0o777;
    
    if (mode !== 0o600) {
      throw new Error(`Secret file must have mode 0600 (current: 0${mode.toString(8)})`);
    }
    
    const content = await readFile(secretFile, 'utf8');
    const secret = content.trim();
    
    if (!secret) {
      throw new Error('Secret file is empty');
    }
    
    if (secret.length < 32) {
      throw new Error('Secret must be at least 32 characters');
    }
    
    return secret;
  } catch (error: any) {
    throw new Error(`Failed to load status secret: ${error.message}`);
  }
}
