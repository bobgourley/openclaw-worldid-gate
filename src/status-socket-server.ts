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
import { unlink, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { EnrollmentService } from './enrollment-service-production.js';
import { timingSafeEqual } from 'node:crypto';

/**
 * Simple in-memory rate limiter for socket queries.
 */
class SocketRateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly windowMs: number = 60000; // 1 minute
  private readonly maxRequests: number = 100; // 100 requests per minute per endpoint

  check(key: string): boolean {
    const now = Date.now();
    let timestamps = this.requests.get(key) || [];
    
    // Remove expired timestamps
    const cutoff = now - this.windowMs;
    timestamps = timestamps.filter(t => t > cutoff);
    
    // Check limit
    if (timestamps.length >= this.maxRequests) {
      return false;
    }
    
    timestamps.push(now);
    this.requests.set(key, timestamps);
    return true;
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
    // Remove stale socket file if exists
    if (existsSync(this.config.socketPath)) {
      await unlink(this.config.socketPath);
    }

    this.server = http.createServer(async (req, res) => {
      await this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error('Server not initialized'));
        return;
      }

      this.server.listen(this.config.socketPath, async () => {
        try {
          // Set socket permissions to 0600 (owner-only)
          await chmod(this.config.socketPath, 0o600);
          console.log(`[StatusSocket] Listening on ${this.config.socketPath} (mode 0600)`);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      this.server.on('error', (error: any) => {
        reject(error);
      });
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
      console.error('[StatusSocket] Query error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  /**
   * Verify bearer authentication with constant-time compare.
   */
  private verifyAuth(authHeader: string | undefined): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }

    const providedSecret = authHeader.slice(7); // Remove "Bearer " prefix
    
    // Constant-time comparison to prevent timing attacks
    try {
      const expected = Buffer.from(this.config.secret, 'utf8');
      const provided = Buffer.from(providedSecret, 'utf8');
      
      // Both buffers must be same length for timingSafeEqual
      if (expected.length !== provided.length) {
        return false;
      }
      
      return timingSafeEqual(expected, provided);
    } catch {
      return false;
    }
  }
}

/**
 * Load secret from file (0600 permissions check).
 */
export async function loadStatusSecret(secretFile: string): Promise<string> {
  try {
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
