/**
 * Example configuration for openclaw-worldid-gate
 * 
 * DO NOT commit real credentials, RP IDs, or API keys.
 * This is a sanitized example for reference only.
 */

import type { GateConfig } from './src/types.js';

/**
 * Test configuration (use with stub verifier only)
 */
export const testConfig: GateConfig = {
  // Replace with your RP ID from https://developer.world.org/
  rpId: 'rp_YOUR_RP_ID_HERE',

  // Action string scopes the proof to this specific use case
  // Must match between enrollment and admission checks
  // Example: 'openclaw-gate-production'
  action: 'YOUR_ACTION_STRING_HERE',

  // World ID verification endpoint
  verifyEndpoint: 'https://developer.world.org/api/v4/verify',

  // Require proof_of_human credential (Orb verification)
  // Set to false to accept selfie credentials as well
  requireProofOfHuman: true,

  // Enrollment time-to-live in seconds (default 30 days)
  enrollmentTtlSeconds: 86400 * 30,

  // Allow test mode (stub verifier)
  // MUST be false in production
  allowTestMode: true,
};

/**
 * Production configuration example (UNIMPLEMENTED)
 * 
 * Production requires:
 * - Real RP ID from World ID Developer Portal
 * - Production-grade HTTPS client
 * - Durable enrollment storage
 * - Authenticated Telegram updates
 * - Monitoring and alerting
 */
export const productionConfig: GateConfig = {
  rpId: 'rp_YOUR_PRODUCTION_RP_ID',
  action: 'openclaw-gate-production',
  verifyEndpoint: 'https://developer.world.org/api/v4/verify',
  requireProofOfHuman: true,
  enrollmentTtlSeconds: 86400 * 30,
  allowTestMode: false, // NEVER true in production
};

/**
 * OpenClaw integration example (UNIMPLEMENTED)
 * 
 * This pseudocode shows how the gate would integrate with OpenClaw.
 * Actual integration requires OpenClaw gateway modifications.
 */
/*
import { AdmissionGate } from './src/admission-gate.js';
import { WorldIdVerifierProduction } from './src/verifier-stub.js';
import { DurableEnrollmentStore } from './src/enrollment-store.js';

// Initialize gate with production components
const gate = new AdmissionGate(
  productionConfig,
  new WorldIdVerifierProduction(productionConfig.rpId),
  new DurableEnrollmentStore()
);

// OpenClaw gateway integration
openclaw.on('telegram:update', async (update) => {
  const admissionResult = await gate.checkAdmission({
    telegramUpdate: update,
    timestamp: Date.now(),
  });

  if (!admissionResult.allowed) {
    await telegram.sendMessage(
      update.message.chat.id,
      `Access denied: ${admissionResult.reason}. Please enroll at https://your-enrollment-url.example`
    );
    return; // NO FURTHER PROCESSING
  }

  // Only admitted users reach this point
  await agent.process(update);
});
*/

/**
 * Environment-specific configurations
 */

export const stagingConfig: GateConfig = {
  rpId: 'rp_YOUR_STAGING_RP_ID',
  action: 'openclaw-gate-staging',
  verifyEndpoint: 'https://staging-developer.worldcoin.org/api/v4/verify',
  requireProofOfHuman: false, // Allow both orb and selfie in staging
  enrollmentTtlSeconds: 86400 * 7, // 7 days in staging
  allowTestMode: false,
};

export const developmentConfig: GateConfig = {
  rpId: 'rp_YOUR_DEV_RP_ID',
  action: 'openclaw-gate-dev',
  verifyEndpoint: 'https://developer.world.org/api/v4/verify',
  requireProofOfHuman: false,
  enrollmentTtlSeconds: 86400, // 1 day in dev
  allowTestMode: true, // Allow stub verifier in development
};

/**
 * Configuration validation
 */

export function validateConfig(config: GateConfig): string[] {
  const errors: string[] = [];

  if (!config.rpId || !config.rpId.startsWith('rp_')) {
    errors.push('Invalid or missing rpId (must start with rp_)');
  }

  if (!config.action || config.action.trim().length === 0) {
    errors.push('Action string is required');
  }

  if (!config.verifyEndpoint || !config.verifyEndpoint.startsWith('https://')) {
    errors.push('Verify endpoint must be a valid HTTPS URL');
  }

  if (config.enrollmentTtlSeconds < 3600) {
    errors.push('Enrollment TTL must be at least 1 hour (3600 seconds)');
  }

  if (config.enrollmentTtlSeconds > 86400 * 365) {
    errors.push('Enrollment TTL must be less than 1 year');
  }

  return errors;
}
