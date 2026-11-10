/**
 * Production HTTP service for World ID enrollment.
 *
 * Localhost-bound service with strict validation, body limits, and generic errors.
 * No public admin API (grant/revoke requires separate authenticated channel).
 *
 * @module http-service
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { EnrollmentService, CreateChallengeResult, CompleteEnrollmentRequest, CompleteEnrollmentResult } from './enrollment-service-production.js';
import type { TelegramBotHandler } from './telegram-bot-handler.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Simple in-memory rate limiter with bounded storage.
 */
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxIPs: number;
  private lastCleanup: number = Date.now();

  constructor(windowMs: number, maxRequests: number, maxIPs: number = 10000) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.maxIPs = maxIPs;
  }

  /**
   * Check if request is allowed for given IP.
   * Returns true if allowed, false if rate limit exceeded.
   */
  check(ip: string): boolean {
    const now = Date.now();
    
    // Periodic cleanup to prevent unbounded memory (every 5 minutes)
    if (now - this.lastCleanup > 300000) {
      this.cleanup(now);
    }

    // Get or create timestamp array for this IP
    let timestamps = this.requests.get(ip);
    if (!timestamps) {
      // Enforce max IPs to prevent memory exhaustion
      if (this.requests.size >= this.maxIPs) {
        // Remove oldest IP by finding the one with oldest timestamps
        let oldestIP: string | null = null;
        let oldestTime = now;
        for (const [checkIP, times] of this.requests.entries()) {
          if (times.length > 0 && times[0] < oldestTime) {
            oldestTime = times[0];
            oldestIP = checkIP;
          }
        }
        if (oldestIP) {
          this.requests.delete(oldestIP);
        }
      }
      timestamps = [];
      this.requests.set(ip, timestamps);
    }

    // Remove timestamps outside the window
    const cutoff = now - this.windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    // Check if limit exceeded
    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    // Allow request
    timestamps.push(now);
    return true;
  }

  /**
   * Clean up old entries to prevent unbounded growth.
   */
  private cleanup(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [ip, timestamps] of this.requests.entries()) {
      // Remove expired timestamps
      while (timestamps.length > 0 && timestamps[0] < cutoff) {
        timestamps.shift();
      }
      // Remove IP if no recent requests
      if (timestamps.length === 0) {
        this.requests.delete(ip);
      }
    }
    this.lastCleanup = now;
  }
}

/**
 * HTTP service configuration.
 */
export interface HttpServiceConfig {
  /** Enrollment service (dependency injection) */
  enrollmentService: EnrollmentService;

  /** Telegram bot handler (optional, for bot integration) */
  telegramBotHandler?: TelegramBotHandler;

  /** Port to bind (default: 3000) */
  port?: number;

  /** Host to bind (default: "127.0.0.1" - localhost only) */
  host?: string;

  /** Request body size limit (default: "1mb", max: "2mb") */
  bodyLimit?: string;

  /** Request timeout in milliseconds (default: 30000) */
  requestTimeoutMs?: number;
}

/**
 * Client diagnostics allowlists (exported for tests).
 *
 * Error codes are the official IDKit codes (IDKitErrorCodes in @worldcoin/idkit-core 4.6.0,
 * https://docs.world.org/world-id/idkit/error-codes) plus 'unknown_poll_type', which the
 * enrollment page reports when the SDK returns a status type it does not recognize.
 */
export const CLIENT_DIAGNOSTIC_EVENTS: readonly string[] = ['poll_complete', 'poll_cancel', 'nullifier_replayed'];
export const CLIENT_DIAGNOSTIC_ERROR_CODES: readonly string[] = [
  'user_rejected', 'verification_rejected', 'credential_unavailable', 'feature_unavailable',
  'world_id_4_not_available', 'world_id_3_not_available', 'malformed_request', 'invalid_network',
  'inclusion_proof_pending', 'inclusion_proof_failed', 'unexpected_response', 'connection_failed',
  'max_verifications_reached', 'failed_by_host_app', 'user_presence_failed', 'invalid_rp_signature',
  'nullifier_replayed', 'duplicate_nonce', 'unknown_rp', 'inactive_rp', 'timestamp_too_old',
  'timestamp_too_far_in_future', 'invalid_timestamp', 'rp_signature_expired',
  'identity_attributes_not_matched', 'generic_error', 'invalid_rp_id_format', 'timeout', 'cancelled',
  'unknown_poll_type',
];
export const CLIENT_DIAGNOSTIC_TRANSPORTS: readonly string[] = ['bridge', 'mini_app', 'unknown'];
export const CLIENT_DIAGNOSTIC_DEVICE_CLASSES: readonly string[] = ['phone', 'tablet', 'desktop', 'unknown'];
export const CLIENT_DIAGNOSTIC_TG_PLATFORMS: readonly string[] = [
  'ios', 'android', 'tdesktop', 'macos', 'weba', 'webk', 'web', 'unigram', 'unknown',
];
export const CLIENT_DIAGNOSTIC_ENTRY_PATHS: readonly string[] = ['qr', 'link'];
export const CLIENT_DIAGNOSTIC_FLOWS: readonly string[] = ['enroll', 'renewal'];

/**
 * Raw error code the World ID app put in its bridge reply, read from the documented
 * getDebugReport().response_payload. IDKit 4.6.0 collapses codes it does not know
 * (for example challenge_failed, added in worldcoin/idkit PR 365) into generic_error,
 * so the raw value is logged separately. Values outside this list are logged as 'other'.
 */
export const CLIENT_DIAGNOSTIC_UPSTREAM_CODES: readonly string[] = [
  ...CLIENT_DIAGNOSTIC_ERROR_CODES.filter((c) => c !== 'unknown_poll_type'),
  'challenge_failed', 'other',
];
/** Optional bridge error reason vocabulary (ErrorReason in worldcoin/idkit PR 365). */
export const CLIENT_DIAGNOSTIC_UPSTREAM_REASONS: readonly string[] = [
  'face_challenge_quality', 'face_challenge_mismatch', 'face_challenge_missing',
  'face_challenge_integrity', 'face_selfie_quality', 'face_selfie_mismatch', 'face_selfie_timeout',
  'spoof_detected', 'age_below_threshold', 'username_mismatch', 'biometric_rejected',
  'user_cancelled', 'proof_failed', 'credential_unavailable', 'pcp_missing',
  'face_auth_unavailable', 'face_auth_failed', 'metadata_failed', 'network_error',
  'server_rejected', 'client_error', 'process_challenge_failed', 'face_quality', 'face_mismatch',
  'face_auth_timeout', 'unknown', 'other',
];

/** Placeholder in enrollment.html replaced with the page build id when served. */
export const UI_BUILD_PLACEHOLDER = '__UI_BUILD_ID__';

/** Build id for the enrollment page: short SHA-256 of the unstamped HTML. */
export function uiBuildId(rawHtml: string): string {
  return createHash('sha256').update(rawHtml).digest('hex').slice(0, 16);
}

/**
 * HTTP service for World ID enrollment endpoints.
 */
export class HttpService {
  private app: express.Express;
  private enrollmentService: EnrollmentService;
  private server: any;
  private readonly port: number;
  private readonly host: string;

  private telegramBotHandler?: TelegramBotHandler;
  
  // Rate limiter for diagnostics endpoint: 30 requests per minute per IP
  private diagnosticsRateLimiter: RateLimiter = new RateLimiter(60000, 30);

  constructor(config: HttpServiceConfig) {
    this.enrollmentService = config.enrollmentService;
    this.telegramBotHandler = config.telegramBotHandler;
    this.port = config.port ?? 3000;
    this.host = config.host ?? '127.0.0.1';

    const bodyLimit = config.bodyLimit ?? '1mb';
    const requestTimeout = config.requestTimeoutMs ?? 30000;

    // Validate body limit (simple validation)
    const limitMatch = bodyLimit.match(/^(\d+)(kb|mb)$/i);
    if (!limitMatch) {
      throw new Error('Invalid bodyLimit: must be format "1mb" or "100kb"');
    }
    const limitNum = parseInt(limitMatch[1], 10);
    const limitUnit = limitMatch[2].toLowerCase();
    if (limitUnit === 'mb' && limitNum > 2) {
      throw new Error('Invalid bodyLimit: max 2mb (World ID proofs are ~10-50KB)');
    }

    this.app = express();

    // Request timeout (applied before body parsing)
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      req.setTimeout(requestTimeout);
      res.setTimeout(requestTimeout);
      next();
    });

    // Liveness probe (process is alive)
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'healthy' });
    });

    // Readiness probe (service is ready to accept requests)
    // Always returns 503 because HttpService alone cannot determine production readiness
    // Use separate health check in production composition (server.ts)
    this.app.get('/ready', (req: Request, res: Response) => {
      // HttpService is always "ready" at HTTP layer
      // Production readiness (configured secrets) checked at startup in server.ts
      res.json({ status: 'ready' });
    });

    // JSON body parser for API routes (not webhook)
    const jsonParser = express.json({ limit: bodyLimit, strict: true });

    // Challenge creation endpoint (requires authenticated Telegram initData)
    this.app.post('/api/challenge/create', jsonParser, async (req: Request, res: Response) => {
      try {
        await this.handleCreateChallenge(req, res);
      } catch (error) {
        console.error('Challenge creation error:', error);
        res.status(500).json({ error: 'Challenge creation failed' });
      }
    });

    // Enrollment completion endpoint
    this.app.post('/api/enrollment/complete', jsonParser, async (req: Request, res: Response) => {
      try {
        await this.handleCompleteEnrollment(req, res);
      } catch (error) {
        console.error('Enrollment completion error:', error);
        res.status(500).json({ error: 'Enrollment completion failed' });
      }
    });

    // Enrollment query endpoint (requires authenticated Telegram initData)
    this.app.post('/api/enrollment/query', jsonParser, async (req: Request, res: Response) => {
      try {
        await this.handleQueryEnrollment(req, res);
      } catch (error) {
        console.error('Enrollment query error:', error);
        res.status(500).json({ error: 'Enrollment query failed' });
      }
    });

    // Session verification routes
    this.app.post('/api/session/challenge/create', jsonParser, async (req: Request, res: Response) => {
      try {
        await this.handleCreateSessionChallenge(req, res);
      } catch (error) {
        console.error('Session challenge creation error:', error);
        res.status(500).json({ error: 'Session challenge creation failed' });
      }
    });

    this.app.post('/api/session/verify', jsonParser, async (req: Request, res: Response) => {
      try {
        await this.handleVerifySession(req, res);
      } catch (error) {
        console.error('Session verify error:', error);
        res.status(500).json({ error: 'Session verification failed' });
      }
    });

    // Client diagnostics endpoint (privacy-safe metrics only)
    // Route-specific 2KB body limit (diagnostics should be tiny)
    const diagnosticsParser = express.json({ limit: '2kb', strict: true });
    this.app.post('/api/diagnostics/client', diagnosticsParser, async (req: Request, res: Response) => {
      try {
        await this.handleClientDiagnostics(req, res);
      } catch (error) {
        console.error('Client diagnostics error:', error);
        res.status(500).json({ error: 'Diagnostics recording failed' });
      }
    });

    // Telegram bot webhook endpoint (optional, only if bot handler configured)
    if (this.telegramBotHandler) {
      this.app.post('/telegram/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
        try {
          await this.handleTelegramWebhook(req, res);
        } catch (error) {
          console.error('Telegram webhook error:', error);
          res.status(500).json({ error: 'Webhook processing failed' });
        }
      });

      // Enrollment UI route
      this.app.get('/enrollment', (req: Request, res: Response) => {
        try {
          // Try dist/ui first (production), fallback to ../dist/ui (when running from src in tests)
          let uiPath = join(__dirname, 'ui', 'enrollment.html');
          try {
            readFileSync(uiPath, 'utf-8');
          } catch {
            uiPath = join(__dirname, '..', 'dist', 'ui', 'enrollment.html');
          }
          const rawHtml = readFileSync(uiPath, 'utf-8');
          // Stamp the page with a content hash so an old page left open in Telegram
          // can notice a newer build (via /api/ui-build) and reload itself.
          const html = rawHtml.split(UI_BUILD_PLACEHOLDER).join(uiBuildId(rawHtml));
          res.setHeader('Content-Type', 'text/html');
          res.setHeader('Cache-Control', 'no-store');
          res.send(html);
        } catch (error) {
          console.error('UI serving error:', error);
          res.status(500).send('Service unavailable');
        }
      });

      // Current enrollment page build id (content hash only, no secrets)
      this.app.get('/api/ui-build', (req: Request, res: Response) => {
        try {
          let uiPath = join(__dirname, 'ui', 'enrollment.html');
          try {
            readFileSync(uiPath, 'utf-8');
          } catch {
            uiPath = join(__dirname, '..', 'dist', 'ui', 'enrollment.html');
          }
          res.setHeader('Cache-Control', 'no-store');
          res.json({ build: uiBuildId(readFileSync(uiPath, 'utf-8')) });
        } catch (error) {
          res.status(500).json({ error: 'Service unavailable' });
        }
      });

      // IDKit bundle route (locally bundled from installed @worldcoin/idkit-core)
      this.app.get('/idkit-bundle.js', (req: Request, res: Response) => {
        try {
          // Try dist/ui first (production), fallback to ../dist/ui (when running from src in tests)
          let bundlePath = join(__dirname, 'ui', 'idkit-bundle.js');
          try {
            readFileSync(bundlePath, 'utf-8');
          } catch {
            bundlePath = join(__dirname, '..', 'dist', 'ui', 'idkit-bundle.js');
          }
          const bundle = readFileSync(bundlePath, 'utf-8');
          res.setHeader('Content-Type', 'application/javascript');
          // No caching for unversioned bundles to prevent stale SDK after deployment
          res.setHeader('Cache-Control', 'no-store');
          res.send(bundle);
        } catch (error) {
          console.error('IDKit bundle serving error:', error);
          res.status(500).send('/* IDKit bundle unavailable */');
        }
      });

      // QR code bundle route (locally bundled qrcode library)
      this.app.get('/qrcode-bundle.js', (req: Request, res: Response) => {
        try {
          // Try dist/ui first (production), fallback to ../dist/ui (when running from src in tests)
          let bundlePath = join(__dirname, 'ui', 'qrcode-bundle.js');
          try {
            readFileSync(bundlePath, 'utf-8');
          } catch {
            bundlePath = join(__dirname, '..', 'dist', 'ui', 'qrcode-bundle.js');
          }
          const bundle = readFileSync(bundlePath, 'utf-8');
          res.setHeader('Content-Type', 'application/javascript');
          // No caching for unversioned bundles to prevent stale SDK after deployment
          res.setHeader('Cache-Control', 'no-store');
          res.send(bundle);
        } catch (error) {
          console.error('QR code bundle serving error:', error);
          res.status(500).send('/* QR code bundle unavailable */');
        }
      });

    }

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Generic error handler (no identity leaks)
    // MUST be registered AFTER all routes and 404 handler
    this.app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      // Log only safe fields, never the full error or body (could contain PII)
      console.error('Request error:', err.type || 'unknown', err.status || 'no-status');

      if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON' });
      }

      if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body too large' });
      }

      // Generic error (no details leaked)
      res.status(500).json({ error: 'Internal service error' });
    });
  }

  /**
   * Handle challenge creation request.
   *
   * Request body: { initData: string }
   * Response: { signedChallenge: SignedRpChallenge }
   */
  private async handleCreateChallenge(req: Request, res: Response): Promise<void> {
    // Validate request body
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    if (!req.body.initData || typeof req.body.initData !== 'string') {
      res.status(400).json({ error: 'initData required' });
      return;
    }

    // Create challenge (authenticates initData internally)
    try {
      const result: CreateChallengeResult = await this.enrollmentService.createChallenge(req.body.initData);

      // Flatten structure for frontend compatibility (top-level fields expected by enrollment.html)
      res.json({
        appId: result.signedChallenge.appId,
        rpId: result.signedChallenge.rpId,
        signal: result.signal,
        signedChallenge: result.signedChallenge,
      });
    } catch (error: any) {
      console.error('Challenge creation error:', error);

      // Map specific errors to generic responses (no identity leaks)
      if (error.message?.includes('initData validation failed')) {
        res.status(401).json({ error: 'Authentication failed' });
        return;
      }

      if (error.message?.includes('already enrolled')) {
        res.status(409).json({ error: 'User already enrolled' });
        return;
      }

      if (error.message?.includes('session verification')) {
        res.status(409).json({ error: 'User must use session verification' });
        return;
      }

      res.status(500).json({ error: 'Challenge creation failed' });
    }
  }

  /**
   * Handle enrollment completion request.
   *
   * Request body: CompleteEnrollmentRequest
   * Response: CompleteEnrollmentResult
   */
  private async handleCompleteEnrollment(req: Request, res: Response): Promise<void> {
    // Validate request body
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    if (!req.body.initData || typeof req.body.initData !== 'string') {
      res.status(400).json({ error: 'initData required' });
      return;
    }

    if (!req.body.idkitResult || typeof req.body.idkitResult !== 'object') {
      res.status(400).json({ error: 'idkitResult required' });
      return;
    }

    const enrollmentRequest: CompleteEnrollmentRequest = {
      initData: req.body.initData,
      idkitResult: req.body.idkitResult,
    };

    // Complete enrollment
    const result: CompleteEnrollmentResult = await this.enrollmentService.completeEnrollment(enrollmentRequest);

    if (result.success) {
      // Return only success, expiry, and protocol version (no PII/sessionId)
      res.json({
        success: true,
        expiresAt: result.expiresAt,
        protocolVersion: result.protocolVersion,
      });
    } else {
      // Map errors to appropriate HTTP status codes
      if (result.error?.includes('Authentication failed') || result.error?.includes('initData validation failed')) {
        res.status(401).json({ success: false, error: 'Authentication failed' });
      } else if (result.error?.includes('Account mismatch')) {
        res.status(403).json({ success: false, error: 'Account mismatch' });
      } else if (result.error?.includes('Challenge session not found')) {
        res.status(404).json({ success: false, error: 'Challenge session not found' });
      } else if (result.error?.includes('Challenge session expired')) {
        res.status(410).json({ success: false, error: 'Challenge session expired' });
      } else if (result.error?.includes('Nullifier revoked')) {
        res.status(403).json({ success: false, error: 'Access revoked' });
      } else if (result.error?.includes('already enrolled')) {
        res.status(409).json({ success: false, error: 'Already enrolled' });
      } else {
        res.status(400).json({ success: false, error: 'Enrollment failed' });
      }
    }
  }

  /**
   * Handle session challenge creation request (renewal only).
   * 
   * Request body: { initData: string }
   * Response: { signedChallenge: SignedRpChallenge }
   */
  private async handleCreateSessionChallenge(req: Request, res: Response): Promise<void> {
    // Validate request body
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    if (!req.body.initData || typeof req.body.initData !== 'string') {
      res.status(400).json({ error: 'initData required' });
      return;
    }

    // Create session challenge (renewal only)
    try {
      const result = await this.enrollmentService.createSessionChallenge(req.body.initData);

      res.json({
        signedChallenge: result.signedChallenge,
      });
    } catch (error: any) {
      console.error('Session challenge creation error:', error);

      // Map specific errors to generic responses
      if (error.message?.includes('initData validation failed')) {
        res.status(401).json({ error: 'Authentication failed' });
        return;
      }

      if (error.message?.includes('No existing enrollment')) {
        res.status(404).json({ error: 'No enrollment found' });
        return;
      }

      if (error.message?.includes('has been revoked')) {
        res.status(403).json({ error: 'Enrollment revoked' });
        return;
      }

      res.status(500).json({ error: 'Session challenge creation failed' });
    }
  }

  /**
   * Handle session verification request.
   * 
   * Request body: VerifySessionRequest (initData + idkitResult)
   * Response: CompleteEnrollmentResult
   */
  private async handleVerifySession(req: Request, res: Response): Promise<void> {
    // Validate request body
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    if (!req.body.initData || typeof req.body.initData !== 'string') {
      res.status(400).json({ error: 'initData required' });
      return;
    }

    if (!req.body.idkitResult || typeof req.body.idkitResult !== 'object') {
      res.status(400).json({ error: 'idkitResult required' });
      return;
    }

    // Verify session
    try {
      const result = await this.enrollmentService.verifySession({
        initData: req.body.initData,
        idkitResult: req.body.idkitResult,
      });

      if (result.success) {
        // Return only success and expiry (no PII/nullifier/sessionId)
        res.json({
          success: true,
          expiresAt: result.expiresAt,
        });
      } else {
        // Verification failed - sanitized error (no raw error text)
        res.status(400).json({
          success: false,
          error: 'Session verification failed',
        });
      }
    } catch (error: any) {
      console.error('Session verification error:', error);
      res.status(500).json({ error: 'Session verification failed' });
    }
  }

  /**
   * Handle enrollment status request (authenticated).
   * 
   * Server-driven flow decision:
   * - new: No enrollment exists (fresh v2 enrollment)
   * - upgrade: Historical UNKNOWN/no-session enrollment (fresh v2 enrollment)
   * - renewal: Active or expired enrollment with saved session
   * - error: Revoked enrollment (cannot use system)
   * 
   * Session ID returned ONLY when needed by frontend for proveSession flow.
   * NEVER returned for new/upgrade flows (no session exists yet).
   * 
   * Request body: { initData: string }
   * Response: { status: string, sessionId?: string, expiresAt?: number }
   */
  private async handleQueryEnrollment(req: Request, res: Response): Promise<void> {
    // Validate request body
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    if (!req.body.initData || typeof req.body.initData !== 'string') {
      res.status(400).json({ error: 'initData required' });
      return;
    }

    // Authenticate initData via service (extracts user ID)
    try {
      // Use findEnrollment which authenticates initData internally
      const enrollment = await this.enrollmentService.findEnrollmentByInitData(req.body.initData);

      if (!enrollment) {
        // No enrollment - fresh v2 enrollment flow
        res.json({
          status: 'new',
        });
        return;
      }

      // Check session presence (key only on sessionId, not protocolVersion)
      if (!enrollment.sessionId) {
        // Historical enrollment without session - upgrade to v2
        res.json({
          status: 'upgrade',
        });
        return;
      }

      // Enrollment has session - check revocation status
      if (enrollment.revoked) {
        // Revoked users cannot use the system (no reactivation flow)
        res.json({
          status: 'error',
        });
        return;
      }

      // Active or expired enrollment with saved session - renewal flow
      res.json({
        status: 'renewal',
        sessionId: enrollment.sessionId, // Needed for proveSession
        expiresAt: enrollment.expiresAt,
        expired: enrollment.expired,
      });
    } catch (error: any) {
      console.error('Enrollment status error:', error);
      
      // Map authentication errors
      if (error.message?.includes('initData validation failed')) {
        res.status(401).json({ error: 'Authentication failed' });
        return;
      }

      res.status(500).json({ error: 'Enrollment status check failed' });
    }
  }

  /**
   * Handle Telegram webhook request.
   * 
   * Security: Validates webhook secret header, rejects forged updates.
   */
  private async handleTelegramWebhook(req: Request, res: Response): Promise<void> {
    if (!this.telegramBotHandler) {
      res.status(404).json({ error: 'Bot not configured' });
      return;
    }

    // Get raw body and secret token header
    const rawBody = req.body?.toString('utf-8') || '';
    const secretToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;

    // Validate webhook (fail-closed)
    if (!this.telegramBotHandler.validateWebhook(rawBody, secretToken)) {
      res.status(403).json({ error: 'Invalid webhook request' });
      return;
    }

    // Parse update
    let update: any;
    try {
      update = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }

    // Handle update (async, don't block webhook response)
    this.telegramBotHandler.handleUpdate(update).catch(err => {
      console.error('Update handling error:', err);
    });

    // Telegram expects 200 OK quickly
    res.status(200).json({ ok: true });
  }

  /**
   * Handle client diagnostics (privacy-safe metrics only).
   * 
   * PRIVACY: This endpoint MUST NOT log or store:
   * - Telegram user IDs
   * - World ID nullifiers, nonces, signatures, session IDs
   * - Proof payloads or any credential data
   * - Request IDs from bridge
   * 
   * Only aggregated, privacy-safe metrics from allowlisted schema are logged.
   */
  private async handleClientDiagnostics(req: Request, res: Response): Promise<void> {
    // Rate limiting: 30 requests per minute per IP
    const clientIP = req.ip || 'unknown';
    if (!this.diagnosticsRateLimiter.check(clientIP)) {
      res.status(429).end();
      return;
    }

    // Validate request body exists and is object
    if (!req.body || typeof req.body !== 'object') {
      res.status(204).end();
      return;
    }

    const ALLOWED_EVENTS = CLIENT_DIAGNOSTIC_EVENTS;
    const ALLOWED_ERROR_CODES: readonly (string | null)[] = [...CLIENT_DIAGNOSTIC_ERROR_CODES, null];
    const ALLOWED_STATUS_CLASSES: readonly (string | null)[] = ['success', 'failure', 'awaiting', 'failed', 'network_error', null];

    // Extract and validate event
    const event = typeof req.body.event === 'string' && ALLOWED_EVENTS.includes(req.body.event)
      ? req.body.event
      : null;
    
    if (!event) {
      // Invalid event type - drop silently
      res.status(204).end();
      return;
    }

    // Extract and validate pollCount (0-1000 range)
    let pollCount = 0;
    if (typeof req.body.pollCount === 'number' && Number.isFinite(req.body.pollCount)) {
      pollCount = Math.max(0, Math.min(1000, Math.floor(req.body.pollCount)));
    }

    // Extract and validate visibilityChanges (0-100 range)
    let visibilityChanges = 0;
    if (typeof req.body.visibilityChanges === 'number' && Number.isFinite(req.body.visibilityChanges)) {
      visibilityChanges = Math.max(0, Math.min(100, Math.floor(req.body.visibilityChanges)));
    }

    // Extract and validate durationMs (0-600000 range, max 10 minutes)
    let durationMs = 0;
    if (typeof req.body.durationMs === 'number' && Number.isFinite(req.body.durationMs)) {
      durationMs = Math.max(0, Math.min(600000, Math.floor(req.body.durationMs)));
    }

    // Extract and validate finalStatus
    const finalStatus = typeof req.body.finalStatus === 'string' && ALLOWED_STATUS_CLASSES.includes(req.body.finalStatus)
      ? req.body.finalStatus
      : null;

    // Extract and validate errorCode
    const errorCode = typeof req.body.errorCode === 'string' && ALLOWED_ERROR_CODES.includes(req.body.errorCode)
      ? req.body.errorCode
      : null;

    // Extract and validate lastStatusClass
    const lastStatusClass = typeof req.body.lastStatusClass === 'string' && ALLOWED_STATUS_CLASSES.includes(req.body.lastStatusClass)
      ? req.body.lastStatusClass
      : null;

    // Coarse context fields (fixed enums only; anything else is dropped)
    const pickEnum = (value: unknown, allowed: readonly string[]): string | null =>
      typeof value === 'string' && allowed.includes(value) ? value : null;
    const transport = pickEnum(req.body.transport, CLIENT_DIAGNOSTIC_TRANSPORTS);
    const deviceClass = pickEnum(req.body.deviceClass, CLIENT_DIAGNOSTIC_DEVICE_CLASSES);
    const tgPlatform = pickEnum(req.body.tgPlatform, CLIENT_DIAGNOSTIC_TG_PLATFORMS);
    const entryPath = pickEnum(req.body.entryPath, CLIENT_DIAGNOSTIC_ENTRY_PATHS);
    const flow = pickEnum(req.body.flow, CLIENT_DIAGNOSTIC_FLOWS);
    const upstreamCode = pickEnum(req.body.upstreamCode, CLIENT_DIAGNOSTIC_UPSTREAM_CODES);
    const upstreamReason = pickEnum(req.body.upstreamReason, CLIENT_DIAGNOSTIC_UPSTREAM_REASONS);

    // Extract and validate timestamp (within last 24 hours)
    const now = Date.now();
    let timestamp = now;
    if (typeof req.body.timestamp === 'number' && Number.isFinite(req.body.timestamp)) {
      const age = now - req.body.timestamp;
      if (age >= 0 && age <= 86400000) { // Within last 24 hours
        timestamp = Math.floor(req.body.timestamp);
      }
    }

    // Construct privacy-safe diagnostic entry (only allowlisted fields, no unknown fields)
    const safeData: Record<string, any> = {
      event,
      pollCount,
      visibilityChanges,
      durationMs,
    };
    
    if (finalStatus) safeData.finalStatus = finalStatus;
    if (errorCode) safeData.errorCode = errorCode;
    if (lastStatusClass) safeData.lastStatusClass = lastStatusClass;
    if (transport) safeData.transport = transport;
    if (deviceClass) safeData.deviceClass = deviceClass;
    if (tgPlatform) safeData.tgPlatform = tgPlatform;
    if (entryPath) safeData.entryPath = entryPath;
    if (flow) safeData.flow = flow;
    if (upstreamCode) safeData.upstreamCode = upstreamCode;
    if (upstreamReason) safeData.upstreamReason = upstreamReason;
    safeData.timestamp = timestamp;

    // SECURITY: Scan for sensitive patterns that should never appear
    // If found, log warning and drop the entire event
    const dataStr = JSON.stringify(safeData);
    const sensitivePatterns = [
      /0x[0-9a-f]{64}/i, // Nullifier pattern
      /session_[0-9a-f]{128}/i, // Session ID pattern
      /telegram:\d+/i, // Signal pattern
      /"signature":/i, // Signature field
      /"nonce":/i, // Nonce field
    ];
    
    for (const pattern of sensitivePatterns) {
      if (pattern.test(dataStr)) {
        console.error('[Client Diagnostics] SECURITY: Sensitive pattern detected, dropping event');
        res.status(204).end();
        return;
      }
    }

    // Log privacy-safe diagnostics (console only, no persistent storage)
    console.log('[Client Diagnostics]', JSON.stringify(safeData));

    // Return 204 No Content (never echo input back)
    res.status(204).end();
  }

  /**
   * Start HTTP server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, this.host, () => {
          console.log(`HTTP service listening on http://${this.host}:${this.port}`);
          resolve();
        });

        this.server.on('error', (error: any) => {
          if (error.code === 'EADDRINUSE') {
            reject(new Error(`Port ${this.port} already in use`));
          } else {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop HTTP server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error: any) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get the actual port the server is listening on (useful when port 0 is used).
   */
  getActualPort(): number {
    if (!this.server) {
      return this.port;
    }
    const address = this.server.address();
    if (typeof address === 'object' && address !== null) {
      return address.port;
    }
    return this.port;
  }

  /**
   * Get Express app (for testing).
   */
  getApp(): express.Express {
    return this.app;
  }
}
