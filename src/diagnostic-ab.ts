/**
 * Diagnostic A/B device tests (off unless explicitly configured).
 *
 * Purpose: tell apart why the World app fails for one person, without touching
 * enrollment state.
 *   Test A: v4-only uniqueness proof with NO session, on a throwaway action.
 *   Test B: session creation only (IDKit.createSession), no action.
 *
 * Guarantees:
 * - Writes nothing to the enrollment database. The page never sends the proof
 *   anywhere; the server only receives an outcome and fixed-vocabulary codes.
 * - Reachable only through a one-time link the bot sends in a private chat.
 *   The token is 128 random bits, expires after 15 minutes, is bound to the
 *   Telegram user it was issued to (checked against signed initData), and each
 *   test can be started once per token.
 * - The throwaway action must differ from the enrollment action(s), so a test
 *   proof can never consume an enrollment nullifier.
 */

import { randomBytes } from 'node:crypto';
import type { WorldIdChallengeAdapter, SignedRpChallenge } from './worldid-challenge-adapter.js';

export type DiagTest = 'A' | 'B';
export const DIAG_TESTS: readonly DiagTest[] = ['A', 'B'];
export const DIAG_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Minimum time between links for one user. */
export const DIAG_LINK_COOLDOWN_MS = 2 * 60 * 1000;
/** Fixed signal for Test A, so no Telegram id ever goes into a test proof. */
export const DIAG_SIGNAL = 'openclaw-diagnostic';

interface DiagTokenRecord {
  userId: number;
  createdAt: number;
  started: Set<DiagTest>;
}

export class DiagnosticTokenStore {
  private tokens = new Map<string, DiagTokenRecord>();
  private lastIssued = new Map<number, number>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Issue a fresh token for a user, or null while the cooldown is running. */
  issue(userId: number): string | null {
    this.sweep();
    const t = this.now();
    const last = this.lastIssued.get(userId);
    if (last !== undefined && t - last < DIAG_LINK_COOLDOWN_MS) return null;
    // One live token per user: drop older ones
    for (const [k, v] of this.tokens) if (v.userId === userId) this.tokens.delete(k);
    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, { userId, createdAt: t, started: new Set() });
    this.lastIssued.set(userId, t);
    return token;
  }

  /** Mark a test started; true only once per test per live token owned by userId. */
  start(token: unknown, test: unknown, userId: number): boolean {
    this.sweep();
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return false;
    if (test !== 'A' && test !== 'B') return false;
    const rec = this.tokens.get(token);
    if (!rec || rec.userId !== userId || rec.started.has(test)) return false;
    rec.started.add(test);
    return true;
  }

  /** True if the token is live, owned by userId, and the test was started. */
  wasStarted(token: unknown, test: unknown, userId: number): boolean {
    this.sweep();
    if (typeof token !== 'string' || (test !== 'A' && test !== 'B')) return false;
    const rec = this.tokens.get(token);
    return !!rec && rec.userId === userId && rec.started.has(test);
  }

  isLive(token: unknown): boolean {
    this.sweep();
    return typeof token === 'string' && this.tokens.has(token);
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.tokens) if (t - v.createdAt >= DIAG_TOKEN_TTL_MS) this.tokens.delete(k);
    for (const [u, at] of this.lastIssued) if (t - at >= DIAG_TOKEN_TTL_MS) this.lastIssued.delete(u);
  }
}

export interface DiagnosticAbConfig {
  store: DiagnosticTokenStore;
  adapter: WorldIdChallengeAdapter;
  /** Throwaway portal action for Test A. */
  actionA: string;
  /** Returns the Telegram user id from signed initData, or null if invalid. */
  verifyInitDataUserId: (initData: unknown) => number | null;
}

/** Throws if the throwaway action could collide with a real enrollment action. */
export function assertSafeDiagAction(actionA: string, protectedActions: string[]): void {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(actionA)) throw new Error('Invalid diagnostic action format');
  if (protectedActions.includes(actionA)) throw new Error('Diagnostic action must differ from enrollment actions');
  if (!actionA.includes('diag')) throw new Error('Diagnostic action name must contain "diag"');
}

/** Challenge payload for the page: only what IDKit needs to build the request. */
export function buildDiagChallenge(cfg: DiagnosticAbConfig, test: DiagTest): {
  test: DiagTest; appId: string; rpContext: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
  action?: string; signal?: string;
} {
  let sc: SignedRpChallenge;
  if (test === 'A') {
    sc = cfg.adapter.createChallenge(cfg.actionA, DIAG_SIGNAL).signedChallenge;
  } else {
    sc = cfg.adapter.createSessionChallenge().signedChallenge;
  }
  const out: ReturnType<typeof buildDiagChallenge> = {
    test,
    appId: sc.appId,
    rpContext: { rp_id: sc.rpId, nonce: sc.nonce, created_at: sc.createdAt, expires_at: sc.expiresAt, signature: sc.signature },
  };
  if (test === 'A') { out.action = cfg.actionA; out.signal = DIAG_SIGNAL; }
  return out;
}
