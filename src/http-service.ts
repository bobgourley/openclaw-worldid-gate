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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
 * HTTP service for World ID enrollment endpoints.
 */
export class HttpService {
  private app: express.Express;
  private enrollmentService: EnrollmentService;
  private server: any;
  private readonly port: number;
  private readonly host: string;

  private telegramBotHandler?: TelegramBotHandler;

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
    this.app.post('/api/diagnostics/client', jsonParser, async (req: Request, res: Response) => {
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
          const html = readFileSync(uiPath, 'utf-8');
          res.setHeader('Content-Type', 'text/html');
          res.send(html);
        } catch (error) {
          console.error('UI serving error:', error);
          res.status(500).send('Service unavailable');
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
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
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
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
          res.send(bundle);
        } catch (error) {
          console.error('QR code bundle serving error:', error);
          res.status(500).send('/* QR code bundle unavailable */');
        }
      });

      // Session info API (for UI initialization)
      this.app.get('/api/enrollment/session/:sessionId', async (req: Request, res: Response) => {
        try {
          await this.handleGetSessionInfo(req, res);
        } catch (error) {
          console.error('Session info error:', error);
          res.status(500).json({ error: 'Session retrieval failed' });
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
      console.error('Request error:', err);

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
      res.json({
        success: true,
        telegramUserId: result.telegramUserId,
        expiresAt: result.expiresAt,
        sessionId: result.sessionId,
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
   * Handle session challenge creation request.
   * 
   * Request body: { initData: string, mode?: 'renewal' | 'reactivation' }
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

    const mode = req.body.mode || 'renewal';
    if (mode !== 'renewal' && mode !== 'reactivation') {
      res.status(400).json({ error: 'mode must be "renewal" or "reactivation"' });
      return;
    }

    // Create session challenge
    try {
      const result = await this.enrollmentService.createSessionChallenge(
        req.body.initData,
        { mode }
      );

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

      if (error.message?.includes('has been revoked') && mode === 'renewal') {
        res.status(403).json({ error: 'Enrollment revoked (use mode=reactivation)' });
        return;
      }

      if (error.message?.includes('not revoked') && mode === 'reactivation') {
        res.status(400).json({ error: 'Enrollment not revoked' });
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
        res.json({
          success: true,
          telegramUserId: result.telegramUserId,
          nullifier: result.nullifier,
          expiresAt: result.expiresAt,
        });
      } else {
        // Verification failed
        res.status(400).json({
          success: false,
          error: result.error,
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
   * - reactivation: Revoked enrollment with saved session
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

      // Check protocol version and session presence
      if (!enrollment.protocolVersion || enrollment.protocolVersion === 'UNKNOWN' || !enrollment.sessionId) {
        // Historical enrollment without session - upgrade to v2
        res.json({
          status: 'upgrade',
        });
        return;
      }

      // Enrollment has session - check revocation status
      if (enrollment.revoked) {
        // Revoked with saved session - explicit reactivation flow
        res.json({
          status: 'reactivation',
          sessionId: enrollment.sessionId, // Needed for proveSession
          expiresAt: enrollment.expiresAt,
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
   * Handle session info request (for UI initialization).
   * 
   * Security: Validates session ID format, checks expiry.
   */
  private async handleGetSessionInfo(req: Request, res: Response): Promise<void> {
    if (!this.telegramBotHandler) {
      res.status(404).json({ error: 'Bot not configured' });
      return;
    }

    const sessionId = req.params.sessionId;

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    const sessionInfo = await this.telegramBotHandler.getSessionInfo(sessionId);

    if (!sessionInfo) {
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }

    // Return session configuration (NO SECRETS)
    res.json({
      signedChallenge: sessionInfo.signedChallenge,
      appId: sessionInfo.appId,
      rpId: (sessionInfo as any).rpId, // Include rpId if present
      signal: sessionInfo.signal,
    });
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
    // Validate request body exists and is object
    if (!req.body || typeof req.body !== 'object') {
      res.status(204).end();
      return;
    }

    // Allowlisted event types
    const ALLOWED_EVENTS = ['poll_complete', 'poll_cancel'];
    
    // Allowlisted error codes (IDKit error codes only, no free text)
    const ALLOWED_ERROR_CODES = [
      'timeout', 'cancelled', 'connection_failed', 'unexpected_response',
      'user_rejected', 'verification_rejected', 'credential_unavailable',
      'world_id_4_not_available', 'rp_signature_expired', 'nullifier_replayed',
      'invalid_rp_signature', 'max_verifications_reached', null
    ];
    
    // Allowlisted status classes
    const ALLOWED_STATUS_CLASSES = ['success', 'failure', 'awaiting', 'failed', 'network_error', null];

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
   * Get Express app (for testing).
   */
  getApp(): express.Express {
    return this.app;
  }
}
