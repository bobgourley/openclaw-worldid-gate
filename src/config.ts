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
    default: 432000, // 5 days
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
 * - enrollmentTtlSeconds: How long enrollments remain valid (default 5 days, configurable via WORLDID_ENROLLMENT_TTL_DAYS)
 * - allowTestMode: Allow stub verifier (development/test only, NEVER production)
 */
export const gateConfig: GateConfig = {
  rpId: process.env.WORLDID_RP_ID || 'rp_REPLACE_WITH_YOUR_RP_ID',
  action: process.env.WORLDID_ACTION || 'openclaw-gate',
  verifyEndpoint:
    process.env.WORLDID_VERIFY_ENDPOINT ||
    'https://developer.world.org/api/v4/verify',
  requireProofOfHuman: process.env.WORLDID_REQUIRE_PROOF_OF_HUMAN !== 'false',
  enrollmentTtlSeconds: process.env.WORLDID_ENROLLMENT_TTL_DAYS
    ? parseInt(process.env.WORLDID_ENROLLMENT_TTL_DAYS, 10) * 86400
    : CONFIG_BOUNDS.enrollmentTtl.default,
  allowTestMode: process.env.NODE_ENV !== 'production',
};

/**
 * Environment interface for testability
 */
export interface EnvLike {
  [key: string]: string | undefined;
}

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
    targetChatId: number | string; // Telegram chat ID or @username for tag operations
    sweepIntervalHours: number; // How often to run expiry sweeper (default 24 hours)
  };

  /**
   * PLANNED: Private status socket for OpenClaw integration
   */
  statusSocket: {
    enabled: boolean;
    socketPath: string;
    secretFile: string;
  };

  /**
   * PLANNED: Selected Telegram groups/supergroups for gate enforcement
   * 
   * Specifies which groups the admission gate applies to. When registry-to-allowlist
   * sync is implemented, these group IDs determine which OpenClaw group allowlists
   * to update.
   * 
   * **Group ID Format**: Numeric Telegram group/supergroup chat IDs (negative values)
   * - Groups: IDs like `-123456789`
   * - Supergroups: IDs like `-1001234567890`
   * 
   * **Selection Lifecycle Considerations**:
   * - Adding a group: Sync adds verified enrollments to that group's allowlist
   * - Removing a group: Consider whether to clear gate-managed entries or leave unchanged
   * - Group ID changes: Telegram may change chat IDs (e.g., group upgraded to supergroup)
   * - Bot must be member and have appropriate permissions in each selected group
   * 
   * **NO FUNCTIONING GATE SETTING**: This is inert configuration. The gate does NOT
   * currently filter by group ID. All admission checks apply uniformly regardless of
   * this setting.
   * 
   * Reference: https://docs.openclaw.ai/channels/telegram/access-control
   */
  selectedGroupIds: {
    enabled: boolean;
    groups: {
      [chatId: string]: {
        /**
         * Human-readable name for this group (documentation only, not used by gate)
         */
        name: string;
        /**
         * Numeric Telegram chat ID (negative for groups/supergroups)
         */
        chatId: number;
        /**
         * Whether to enforce admission gate in this group
         */
        enforceGate: boolean;
      };
    };
  };

  /**
   * PLANNED: OpenClaw group allowlist sync integration
   */
  openclawSync: {
    enabled: boolean;
    configPath: string; // Path to OpenClaw config file
    syncMode: 'periodic' | 'per-request';
    periodicSyncIntervalSeconds?: number; // For periodic mode
    failClosedOnSyncError: boolean; // Reject admissions if sync fails
  };
}

/**
 * Load OpenClaw integration config from environment
 * 
 * @param env - Environment object (defaults to process.env)
 * @returns OpenClaw integration configuration
 */
export function loadOpenClawConfig(env: EnvLike = process.env): OpenClawIntegrationConfig {
  // Validate sweep interval if tags are enabled
  const tagsEnabled = env.MEMBER_TAGS_ENABLED === 'true';
  let sweepIntervalHours = 24; // Default
  
  if (tagsEnabled && env.MEMBER_TAG_SWEEP_INTERVAL_HOURS) {
    const val = parseInt(env.MEMBER_TAG_SWEEP_INTERVAL_HOURS, 10);
    if (isNaN(val) || !Number.isInteger(val) || val < 1 || val > 168) {
      throw new Error(`MEMBER_TAG_SWEEP_INTERVAL_HOURS must be 1-168 (got: ${env.MEMBER_TAG_SWEEP_INTERVAL_HOURS})`);
    }
    sweepIntervalHours = val;
  } else if (tagsEnabled) {
    sweepIntervalHours = 24; // Default when enabled but not specified
  }
  
  return {
    verificationBot: {
      enabled: env.VERIFICATION_BOT_ENABLED === 'true',
      botToken: env.VERIFICATION_BOT_TOKEN || '',
      allowedStarterBotUserIds: env.ALLOWED_STARTER_BOT_USER_IDS
        ? env.ALLOWED_STARTER_BOT_USER_IDS.split(',').map((id) => parseInt(id.trim(), 10))
        : [],
    },
    enrollmentLinks: {
      enabled: env.ENROLLMENT_LINKS_ENABLED === 'true',
      ttlSeconds: parseInt(env.ENROLLMENT_LINK_TTL_SECONDS || '300', 10),
      baseUrl: env.ENROLLMENT_LINK_BASE_URL || '',
      hmacSecret: env.ENROLLMENT_LINK_HMAC_SECRET || '',
    },
    memberTags: {
      enabled: tagsEnabled,
      tagText: env.MEMBER_TAG_TEXT || 'Human Verified',
      requireAdminPermission: 'can_manage_tags',
      targetChatId: env.OPENCLAW_ALLOWED_GROUP || '',
      sweepIntervalHours,
    },
    selectedGroupIds: {
      enabled: false,
      groups: {},
    },
    openclawSync: {
      enabled: false,
      configPath: env.OPENCLAW_CONFIG_PATH || '',
      syncMode: 'per-request',
      periodicSyncIntervalSeconds: 300,
      failClosedOnSyncError: true,
    },
    statusSocket: {
      enabled: !!(env.WORLDID_STATUS_SOCKET && env.WORLDID_STATUS_SECRET_FILE),
      socketPath: env.WORLDID_STATUS_SOCKET || '',
      secretFile: env.WORLDID_STATUS_SECRET_FILE || '',
    },
  };
}

/**
 * PLANNED: OpenClaw integration configuration (INERT)
 */
export const openclawIntegrationConfig: OpenClawIntegrationConfig = loadOpenClawConfig();

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

  // Verify endpoint validation with URL parsing
  if (!config.verifyEndpoint || typeof config.verifyEndpoint !== 'string') {
    errors.push('verifyEndpoint is required and must be a string');
  } else {
    try {
      const url = new URL(config.verifyEndpoint);
      
      if (url.protocol !== 'https:') {
        errors.push('verifyEndpoint must use HTTPS protocol');
      }
      
      if (!url.hostname || url.hostname.trim().length === 0) {
        errors.push('verifyEndpoint must have a valid non-empty hostname');
      }
      
      if (url.username || url.password) {
        errors.push('verifyEndpoint must not contain userinfo/credentials in URL');
      }
    } catch (e) {
      errors.push(`verifyEndpoint is not a valid URL: ${e instanceof Error ? e.message : 'parse error'}`);
    }
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
