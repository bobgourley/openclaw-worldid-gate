/**
 * Central user-editable configuration for openclaw-worldid-gate
 * 
 * Operators edit settings in this file without modifying business logic.
 * 
 * SECURITY: DO NOT commit secrets, API keys, or bot tokens to git.
 * Store secrets in environment variables or a secure credential vault.
 */

import type { GateConfig } from './types.js';

/**
 * Configuration bounds enforced at construction time
 * 
 * These bounds ensure safe operation and prevent misconfiguration.
 */
export const CONFIG_BOUNDS = {
  enrollmentTtl: {
    minimum: 60, // 1 minute
    default: 2592000, // 30 days
    maximum: 31536000, // 1 year
  },
} as const;

/**
 * User-editable gate configuration (IMPLEMENTED)
 * 
 * Edit these values to customize gate behavior:
 * - rpId: Your World ID relying party identifier
 * - action: Action string scoping proofs to this integration
 * - verifyEndpoint: World ID verification API endpoint
 * - requireProofOfHuman: True for Orb biometric only, false to allow selfie
 * - enrollmentTtlSeconds: How long enrollments remain valid (default 30 days)
 * - allowTestMode: Allow stub verifier (development/test only, NEVER production)
 */
export const gateConfig: GateConfig = {
  rpId: process.env.WORLDID_RP_ID || 'rp_REPLACE_WITH_YOUR_RP_ID',
  action: process.env.WORLDID_ACTION || 'openclaw-gate',
  verifyEndpoint:
    process.env.WORLDID_VERIFY_ENDPOINT ||
    'https://developer.world.org/api/v4/verify',
  requireProofOfHuman: process.env.WORLDID_REQUIRE_PROOF_OF_HUMAN !== 'false',
  enrollmentTtlSeconds: CONFIG_BOUNDS.enrollmentTtl.default,
  allowTestMode: process.env.NODE_ENV !== 'production',
};

/**
 * PLANNED: OpenClaw integration settings (NOT YET IMPLEMENTED)
 * 
 * These settings document the intended OpenClaw integration architecture.
 * They are INERT in the current implementation.
 * 
 * Implementation requires:
 * - Separate verification bot with DM /verify command
 * - Short-lived single-use enrollment link generator
 * - Telegram Mini App with initData HMAC validation
 * - Member tag management via setChatMemberTag (can_manage_tags permission)
 * - OpenClaw group allowlist integration (channels.telegram.groups)
 * - Registry-to-allowlist sync lifecycle (add/remove, atomic, fail-closed)
 */
export interface OpenClawIntegrationConfig {
  /**
   * PLANNED: Separate verification bot configuration
   */
  verificationBot: {
    enabled: boolean;
    botToken: string; // MUST be in environment variable, not git
    allowedStarterBotUserIds: number[]; // Which main bot user IDs this verifier serves
  };

  /**
   * PLANNED: Enrollment link settings
   */
  enrollmentLinks: {
    enabled: boolean;
    ttlSeconds: number; // Short-lived, single-use link lifetime
    baseUrl: string; // Mini App URL base
    hmacSecret: string; // MUST be in environment variable, not git
  };

  /**
   * PLANNED: Telegram member tag settings
   */
  memberTags: {
    enabled: boolean;
    tagText: string; // Max 16 characters, no emoji (Telegram API limit)
    requireAdminPermission: 'can_manage_tags'; // Required bot administrator right
  };

  /**
   * PLANNED: OpenClaw group allowlist integration
   */
  openclawSync: {
    enabled: boolean;
    configPath: string; // Path to openclaw.config.json5
    syncMode: 'periodic' | 'per-request';
    periodicSyncIntervalSeconds?: number; // For periodic mode
    failClosedOnSyncError: boolean; // Reject admissions if sync fails
  };
}

/**
 * PLANNED: OpenClaw integration configuration (INERT)
 */
export const openclawIntegrationConfig: OpenClawIntegrationConfig = {
  verificationBot: {
    enabled: false,
    botToken: process.env.VERIFICATION_BOT_TOKEN || '',
    allowedStarterBotUserIds: [],
  },
  enrollmentLinks: {
    enabled: false,
    ttlSeconds: 300, // 5 minutes
    baseUrl: process.env.ENROLLMENT_LINK_BASE_URL || '',
    hmacSecret: process.env.ENROLLMENT_LINK_HMAC_SECRET || '',
  },
  memberTags: {
    enabled: false,
    tagText: 'Human Verified', // 15 chars (within 16-char limit)
    requireAdminPermission: 'can_manage_tags',
  },
  openclawSync: {
    enabled: false,
    configPath: process.env.OPENCLAW_CONFIG_PATH || './openclaw.config.json5',
    syncMode: 'per-request',
    periodicSyncIntervalSeconds: 300, // 5 minutes
    failClosedOnSyncError: true,
  },
};

/**
 * Configuration validation with bounded checks
 * 
 * Validates all user-editable settings at construction time.
 * Returns empty array if valid, or array of error strings if invalid.
 */
export function validateConfig(config: GateConfig): string[] {
  const errors: string[] = [];

  // RP ID validation
  if (!config.rpId || typeof config.rpId !== 'string') {
    errors.push('rpId is required and must be a string');
  } else if (!config.rpId.startsWith('rp_')) {
    errors.push('rpId must start with rp_ prefix');
  } else if (config.rpId === 'rp_REPLACE_WITH_YOUR_RP_ID') {
    errors.push('rpId has not been configured (still using placeholder value)');
  }

  // Action validation
  if (!config.action || typeof config.action !== 'string') {
    errors.push('action is required and must be a string');
  } else if (config.action.trim().length === 0) {
    errors.push('action cannot be empty or whitespace-only');
  }

  // Verify endpoint validation
  if (!config.verifyEndpoint || typeof config.verifyEndpoint !== 'string') {
    errors.push('verifyEndpoint is required and must be a string');
  } else if (!config.verifyEndpoint.startsWith('https://')) {
    errors.push('verifyEndpoint must be a valid HTTPS URL');
  }

  // requireProofOfHuman validation
  if (typeof config.requireProofOfHuman !== 'boolean') {
    errors.push('requireProofOfHuman must be a boolean');
  }

  // Enrollment TTL validation with bounded checks
  if (typeof config.enrollmentTtlSeconds !== 'number') {
    errors.push('enrollmentTtlSeconds must be a number');
  } else if (!Number.isFinite(config.enrollmentTtlSeconds)) {
    errors.push('enrollmentTtlSeconds must be finite (not Infinity or NaN)');
  } else if (!Number.isSafeInteger(config.enrollmentTtlSeconds)) {
    errors.push(
      `enrollmentTtlSeconds must be a safe integer (within ${Number.MIN_SAFE_INTEGER} to ${Number.MAX_SAFE_INTEGER})`
    );
  } else if (config.enrollmentTtlSeconds <= 0) {
    errors.push('enrollmentTtlSeconds must be positive');
  } else if (config.enrollmentTtlSeconds < CONFIG_BOUNDS.enrollmentTtl.minimum) {
    errors.push(
      `enrollmentTtlSeconds must be at least ${CONFIG_BOUNDS.enrollmentTtl.minimum} seconds (${CONFIG_BOUNDS.enrollmentTtl.minimum / 60} minutes)`
    );
  } else if (config.enrollmentTtlSeconds > CONFIG_BOUNDS.enrollmentTtl.maximum) {
    errors.push(
      `enrollmentTtlSeconds must be at most ${CONFIG_BOUNDS.enrollmentTtl.maximum} seconds (${CONFIG_BOUNDS.enrollmentTtl.maximum / 86400} days)`
    );
  }

  // allowTestMode validation
  if (typeof config.allowTestMode !== 'boolean') {
    errors.push('allowTestMode must be a boolean');
  }

  return errors;
}

/**
 * Validate configuration and throw on errors
 * 
 * Use this at application startup to fail fast on misconfiguration.
 */
export function assertValidConfig(config: GateConfig): void {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(
      `Configuration validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`
    );
  }
}

/**
 * Config editing semantics for enrollment expiry:
 * 
 * When enrollmentTtlSeconds is changed in config:
 * - NEW enrollments use the new TTL value
 * - EXISTING enrollments keep their original expiresAt timestamp
 * - Config changes do NOT retroactively extend or shorten existing enrollments
 * 
 * Enrollment expiry is checked at admission time against the stored expiresAt
 * timestamp. Changing the config TTL does not affect enrollments that were
 * already created with a different TTL.
 * 
 * To bulk-update existing enrollments, the operator must:
 * 1. Export current enrollments from the durable store
 * 2. Modify expiresAt timestamps as needed
 * 3. Re-import enrollments into the store
 * 
 * This is an intentional design choice to prevent config edits from
 * unexpectedly invalidating or extending active enrollments.
 */
