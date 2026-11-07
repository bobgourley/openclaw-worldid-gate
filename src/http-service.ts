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

    // Strict JSON parsing with size limit
    this.app.use(express.json({
      limit: bodyLimit,
      strict: true,
    }));

    // Request timeout
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      req.setTimeout(requestTimeout);
      res.setTimeout(requestTimeout);
      next();
    });

    // Generic error handler (no identity leaks)
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

    // Challenge creation endpoint (requires authenticated Telegram initData)
    this.app.post('/api/challenge/create', async (req: Request, res: Response) => {
      try {
        await this.handleCreateChallenge(req, res);
      } catch (error) {
        console.error('Challenge creation error:', error);
        res.status(500).json({ error: 'Challenge creation failed' });
      }
    });

    // Enrollment completion endpoint
    this.app.post('/api/enrollment/complete', async (req: Request, res: Response) => {
      try {
        await this.handleCompleteEnrollment(req, res);
      } catch (error) {
        console.error('Enrollment completion error:', error);
        res.status(500).json({ error: 'Enrollment completion failed' });
      }
    });

    // Enrollment query endpoint (requires authenticated Telegram initData)
    this.app.post('/api/enrollment/query', async (req: Request, res: Response) => {
      try {
        await this.handleQueryEnrollment(req, res);
      } catch (error) {
        console.error('Enrollment query error:', error);
        res.status(500).json({ error: 'Enrollment query failed' });
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
          const uiPath = join(__dirname, 'ui', 'enrollment.html');
          const html = readFileSync(uiPath, 'utf-8');
          res.setHeader('Content-Type', 'text/html');
          res.send(html);
        } catch (error) {
          console.error('UI serving error:', error);
          res.status(500).send('Service unavailable');
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

      res.json({
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
   * Handle enrollment query request.
   *
   * Request body: { initData: string }
   * Response: { enrolled: boolean, expiresAt?: number }
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

    // Authenticate initData to extract user ID
    // NOTE: This duplicates authentication - in production, use a shared auth middleware
    // For now, we'll create a challenge and extract the user ID from the error
    // (This is a temporary workaround for query endpoint authentication)

    // Query enrollment
    // TODO: Implement proper initData authentication without challenge creation
    res.status(501).json({ error: 'Query endpoint not yet implemented (requires auth refactor)' });
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
      signal: sessionInfo.signal,
    });
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
