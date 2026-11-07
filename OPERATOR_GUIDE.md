# Operator Guide: World ID Gated OpenClaw Setup

This guide walks through setting up and operating the World ID admission gate for OpenClaw Telegram bots.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Configuration](#configuration)
4. [Synthetic Dry Run (Testing)](#synthetic-dry-run-testing)
5. [Real Verification Setup (Future)](#real-verification-setup-future)
6. [OpenClaw Integration](#openclaw-integration)
7. [Monitoring and Maintenance](#monitoring-and-maintenance)
8. [Troubleshooting](#troubleshooting)

## Prerequisites

**Installed Software**:
- Node.js 18+ and npm
- Git
- (Future) PostgreSQL or Redis for durable enrollment storage

**Accounts and Credentials** (for future real setup):
- World ID Developer Portal account (https://developer.world.org/)
- Telegram Bot (via @BotFather)
- (Optional) Separate verification bot for enrollment

**Knowledge Requirements**:
- Basic TypeScript/Node.js development
- Telegram Bot API fundamentals
- OpenClaw configuration (JSON5 format)

## Initial Setup

### 1. Clone and Install

```bash
git clone https://github.com/bobgourley/openclaw-worldid-gate.git
cd openclaw-worldid-gate
npm install
```

### 2. Verify Installation

Run the test suite to confirm everything works:

```bash
npm test
```

Expected output:
```
# tests 66
# pass 66
# fail 0
```

### 3. Build TypeScript

```bash
npm run build
```

This compiles TypeScript sources from `src/` to `dist/`.

## Configuration

### Central Configuration File

Edit `src/config.ts` to customize gate behavior:

```typescript
export const gateConfig: GateConfig = {
  // World ID relying party identifier (get from https://developer.world.org/)
  rpId: process.env.WORLDID_RP_ID || 'rp_REPLACE_WITH_YOUR_RP_ID',
  
  // Action string scoping proofs to this integration
  action: process.env.WORLDID_ACTION || 'openclaw-gate',
  
  // Verification API endpoint
  verifyEndpoint: process.env.WORLDID_VERIFY_ENDPOINT || 
    'https://developer.world.org/api/v4/verify',
  
  // Require Orb biometric (true) or allow selfie (false)
  requireProofOfHuman: process.env.WORLDID_REQUIRE_PROOF_OF_HUMAN !== 'false',
  
  // Enrollment validity: 30 days (2592000 seconds)
  enrollmentTtlSeconds: 2592000,
  
  // Allow test mode (NEVER true in production)
  allowTestMode: process.env.NODE_ENV !== 'production',
};
```

### Environment Variables (RECOMMENDED)

Instead of editing `src/config.ts`, set environment variables:

```bash
export WORLDID_RP_ID="rp_your_actual_rp_id"
export WORLDID_ACTION="openclaw-gate-production"
export WORLDID_VERIFY_ENDPOINT="https://developer.world.org/api/v4/verify"
export WORLDID_REQUIRE_PROOF_OF_HUMAN="true"
export NODE_ENV="production"
```

**SECURITY**: NEVER commit real RP IDs, API keys, or bot tokens to git.

### Configuration Validation

The gate validates configuration at construction time:

- `rpId`: Must start with `rp_` prefix
- `action`: Non-empty string
- `verifyEndpoint`: HTTPS URL
- `enrollmentTtlSeconds`: Between 60 seconds (1 minute) and 31536000 seconds (1 year)

Invalid configuration throws an error immediately:

```
AdmissionGate configuration validation failed:
  - enrollmentTtlSeconds must be at least 60 seconds (1 minutes)
  - verifyEndpoint must be a valid HTTPS URL
```

### Configuration Bounds

| Setting | Minimum | Default | Maximum |
|---------|---------|---------|---------|
| `enrollmentTtlSeconds` | 60 (1 minute) | 2592000 (30 days) | 31536000 (1 year) |

### Config Editing Semantics

**Important**: Changing `enrollmentTtlSeconds` affects NEW enrollments only.

- Existing enrollments keep their original `expiresAt` timestamp
- Config changes do NOT retroactively extend or shorten existing enrollments
- To bulk-update enrollments, export/modify/re-import from durable store

## Synthetic Dry Run (Testing)

This section covers TESTING with synthetic fixtures. NO real credentials or verification needed.

### 1. Run Existing Test Suite

```bash
npm test
```

This runs 66 tests covering:
- Fail-closed admission checks
- Configuration validation
- Action-model gap validation
- Enrollment lifecycle
- Trust boundary checks

### 2. Create Custom Test Scenario

Create a new test file `test/custom.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionGate } from '../src/admission-gate.js';
import { WorldIdVerifierStub } from '../src/verifier-stub.js';
import { InMemoryEnrollmentStore } from '../src/enrollment-store.js';
import { createTelegramUpdate, createWorldIdProof } from '../src/fixtures.js';
import { gateConfig } from '../src/config.js';

describe('Custom operator test', () => {
  it('simulates enrollment and admission', async () => {
    // Setup: Use test config with stub verifier
    const testConfig = { ...gateConfig, allowTestMode: true };
    const verifier = new WorldIdVerifierStub();
    const store = new InMemoryEnrollmentStore();
    const gate = new AdmissionGate(testConfig, verifier, store);
    
    // Simulate World ID proof for Telegram user 123456789
    const telegramUserId = 123456789;
    const proof = createWorldIdProof({ action: testConfig.action });
    verifier.addValidNullifier(proof.responses[0].nullifier);
    
    // Enroll user
    const enrollResult = await gate.enroll(telegramUserId, proof);
    assert.equal(enrollResult.success, true);
    
    // Check admission
    const update = createTelegramUpdate(telegramUserId, 'Hello bot');
    const admissionResult = await gate.checkAdmission({
      telegramUpdate: update,
      timestamp: Date.now(),
    });
    
    assert.equal(admissionResult.allowed, true);
    console.log('Admission successful:', admissionResult);
  });
});
```

Run your custom test:

```bash
npm test test/custom.test.ts
```

### 3. Synthetic Orchestrator Integration

Test the full orchestration flow with synthetic updates:

```typescript
import { TestOrchestrator } from '../src/orchestrator.test.js';

// Create orchestrator with test gate
const orchestrator = new TestOrchestrator();

// Enroll synthetic user
await orchestrator.enrollUser(123456789);

// Process synthetic message
const result = await orchestrator.processMessage(123456789, 'Hello');
console.log('Processing result:', result);
```

### 4. Dry Run Verification

Verify the following behaviors work correctly:

- [ ] Unknown user is rejected (ZERO LLM calls)
- [ ] Enrolled user is admitted
- [ ] Expired enrollment is rejected
- [ ] Revoked enrollment is rejected
- [ ] Malformed update is rejected
- [ ] Action mismatch is rejected

All of these should pass in the existing test suite.

## Real Verification Setup (Future)

This section describes FUTURE steps for real World ID verification. These are NOT IMPLEMENTED in the current starter.

### Step 1: Register World ID Application

**DO NOT PERFORM THESE STEPS NOW** (requires World ID Developer Portal account and real integration planning).

When ready for production:

1. Visit https://developer.world.org/
2. Sign in and create new application
3. Configure application settings:
   - App name: "OpenClaw Telegram Gate"
   - App type: "Server-side verification"
   - Action: "openclaw-gate-production" (or your chosen action string)
4. Copy your RP ID (starts with `rp_`)
5. Set `WORLDID_RP_ID` environment variable

### Step 2: Create Verification Bot

**DO NOT CREATE THIS BOT NOW** (requires separate bot and integration code not yet implemented).

When implementing separate verification bot:

1. Message @BotFather on Telegram
2. Send `/newbot`
3. Choose name: "MyApp Verification Bot"
4. Choose username: "myapp_verify_bot"
5. Copy bot token
6. Set `VERIFICATION_BOT_TOKEN` environment variable
7. Configure bot to only accept DMs: `/setprivacy` → Disable

### Step 3: Implement Enrollment Mini App

**NOT YET IMPLEMENTED** (requires Telegram Mini App development).

Implementation checklist:
- [ ] Build web UI with World ID IDKit integration
- [ ] Validate Telegram `initData` HMAC-SHA256 with bot token
- [ ] Generate short-lived single-use enrollment links
- [ ] Bind enrollment links to requesting Telegram user ID
- [ ] Submit validated proof to backend
- [ ] Create enrollment in durable store

### Step 4: Implement Production Verifier

**NOT YET IMPLEMENTED** (requires production World ID API client).

Replace `WorldIdVerifierStub` with `WorldIdVerifierProduction`:

```typescript
import { WorldIdVerifierProduction } from './src/verifier-stub.js';

const verifier = new WorldIdVerifierProduction(
  process.env.WORLDID_RP_ID!,
  process.env.WORLDID_VERIFY_ENDPOINT
);
```

Implementation requirements:
- Real HTTPS client (fetch or axios)
- Error handling (network failures, timeouts)
- Retry logic with exponential backoff
- Nullifier caching to prevent replay attacks

### Step 5: Implement Durable Enrollment Store

**NOT YET IMPLEMENTED** (requires database integration).

Replace `InMemoryEnrollmentStore` with `PostgreSQLEnrollmentStore` or similar:

```typescript
import { PostgreSQLEnrollmentStore } from './src/enrollment-store.js';

const store = new PostgreSQLEnrollmentStore({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
```

Database schema (example for PostgreSQL):

```sql
CREATE TABLE enrollments (
  telegram_user_id BIGINT PRIMARY KEY,
  world_id_nullifier TEXT NOT NULL UNIQUE,
  enrolled_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_expires_at ON enrollments(expires_at);
CREATE INDEX idx_nullifier ON enrollments(world_id_nullifier);
```

### Step 6: Self-Verification (Real)

**DO NOT PERFORM THIS STEP NOW** (requires all previous steps completed).

When all implementation is complete:

1. Start verification bot: `npm run start:verify-bot`
2. Send `/verify` to your verification bot in Telegram DM
3. Click enrollment link (opens Mini App)
4. Complete World ID verification via IDKit
5. Verify enrollment created in database:
   ```bash
   psql $DATABASE_URL -c "SELECT * FROM enrollments WHERE telegram_user_id = YOUR_ID;"
   ```
6. Test admission with your main bot
7. Verify "Human Verified" tag appears in group (if enabled)

## OpenClaw Integration

### Current Status: Manual Allowlist Management

The current starter does NOT automatically sync enrollments to OpenClaw config. Operators must manually update `openclaw.config.json5`.

### Manual Allowlist Update

1. Get enrolled Telegram user IDs from store:
   ```typescript
   const enrollments = await store.listValid();
   const userIds = enrollments.map(e => e.telegramUserId);
   console.log(userIds); // [123456789, 987654321, ...]
   ```

2. Edit OpenClaw config (`openclaw.config.json5`):
   ```json5
   {
     channels: {
       telegram: {
         enabled: true,
         dmPolicy: "allowlist",
         allowFrom: [YOUR_OPERATOR_ID],
         groupPolicy: "allowlist",
         groups: {
           "-1001234567890": {
             requireMention: true,
             groupAllowFrom: [123456789, 987654321] // Copy enrolled IDs here
           }
         }
       }
     }
   }
   ```

3. Restart OpenClaw to apply changes:
   ```bash
   openclaw restart
   ```

### Future Automatic Sync

See `ARCHITECTURE.md` for proposed registry-to-allowlist sync lifecycle (PLANNED but NOT IMPLEMENTED).

Implementation options:
- **Per-request ingress enforcement**: Check enrollment validity at every admission
- **Periodic sync**: Update allowlist every N minutes (bounded staleness)
- **Hybrid**: Periodic sync + real-time expiry checks

## Monitoring and Maintenance

### Metrics to Track

**Enrollment Metrics**:
- Total enrollments
- Active enrollments (not expired, not revoked)
- Enrollment rate (per hour/day)
- Expiry rate (per hour/day)
- Revocation rate (per hour/day)

**Admission Metrics**:
- Total admission requests
- Admitted requests (allowed=true)
- Rejected requests (allowed=false)
- Rejection reasons breakdown
- Average admission check latency

**System Health**:
- World ID API response time
- World ID API error rate
- Enrollment store query latency
- Sync success/failure rate (when implemented)

### Log Monitoring

Key log events to monitor:

```typescript
// Admission rejection
{
  level: 'info',
  event: 'admission_rejected',
  telegramUserId: 123456789,
  reason: 'Enrollment has expired'
}

// Enrollment creation
{
  level: 'info',
  event: 'enrollment_created',
  telegramUserId: 123456789,
  nullifier: 'nullifier_abc123',
  expiresAt: 1234567890
}

// World ID verification failure
{
  level: 'warn',
  event: 'verification_failed',
  code: 'revoked',
  detail: 'Credential has been revoked'
}

// Configuration validation error
{
  level: 'error',
  event: 'config_validation_failed',
  errors: ['enrollmentTtlSeconds must be at least 60 seconds']
}
```

### Alerting Rules

Set up alerts for:

1. **High rejection rate** (>50% of admission requests)
   - Possible cause: Mass expiry, sync failure, config error
   - Action: Check enrollment store and sync status

2. **World ID API errors** (>1% error rate)
   - Possible cause: Network issue, API outage, rate limiting
   - Action: Check World ID API status, verify RP ID

3. **Sync failures** (when implemented)
   - Possible cause: Database connection, OpenClaw config write error
   - Action: Check database connectivity, OpenClaw process status

4. **Zero enrollments** (for extended period)
   - Possible cause: Verification bot down, enrollment link generator broken
   - Action: Check verification bot status, test enrollment flow

### Maintenance Tasks

**Daily**:
- Review rejection rate and reasons
- Check for enrollment expiry spikes

**Weekly**:
- Review World ID API latency trends
- Verify enrollment renewal flow works
- Check for stale enrollments (expired but not removed from allowlist)

**Monthly**:
- Audit enrolled users vs expected users
- Review and archive old logs
- Test disaster recovery procedures (backup restore)

## Troubleshooting

### Issue: "Configuration validation failed" on startup

**Symptoms**:
```
AdmissionGate configuration validation failed:
  - rpId must start with rp_ prefix
  - enrollmentTtlSeconds must be at least 60 seconds
```

**Solution**:
1. Check `src/config.ts` or environment variables
2. Ensure `WORLDID_RP_ID` starts with `rp_`
3. Ensure `enrollmentTtlSeconds` is between 60 and 31536000
4. Verify `verifyEndpoint` is an HTTPS URL

### Issue: Test suite fails with "action_mismatch"

**Symptoms**:
```
AssertionError: Expected admission to be allowed
  actual: { allowed: false, reason: 'Enrollment action mismatch' }
```

**Solution**:
1. Check proof action matches config action
2. Verify test config `action` field
3. Ensure `createWorldIdProof({ action: testConfig.action })`

### Issue: Unknown user not rejected (security concern)

**Symptoms**:
User without enrollment is admitted to bot.

**Solution**:
1. Verify admission gate is called BEFORE agent processing
2. Check OpenClaw integration: gate must be at ingress
3. Review OpenClaw config: ensure `groupPolicy: "allowlist"`
4. Verify `groupAllowFrom` contains only enrolled user IDs

### Issue: Enrolled user rejected with "Enrollment has expired"

**Symptoms**:
User with valid enrollment is rejected.

**Solution**:
1. Check enrollment `expiresAt` timestamp:
   ```typescript
   const enrollment = await store.get(telegramUserId);
   console.log('Expires at:', new Date(enrollment.expiresAt * 1000));
   ```
2. Compare with current time
3. If expired: User must re-verify
4. If NOT expired: Check system clock skew

### Issue: World ID API returns 401 Unauthorized

**Symptoms**:
```
World ID API error: 401 Unauthorized
```

**Solution**:
1. Verify `WORLDID_RP_ID` is correct
2. Check RP ID is active in World ID Developer Portal
3. Verify endpoint URL matches RP ID environment (production vs staging)

### Issue: Member tag not applied

**Symptoms**:
Enrolled user does not have "Human Verified" tag in group.

**Solution**:
1. Verify bot has administrator rights in group
2. Verify bot has `can_manage_tags` permission
3. Check target user is regular member (not admin, creator, or bot)
4. Verify tag text is 0-16 characters with no emoji
5. Note: Member tags NOT YET IMPLEMENTED in current starter

### Issue: Sync not updating allowlist

**Symptoms**:
New enrollments not appearing in OpenClaw config.

**Solution**:
1. Note: Automatic sync NOT YET IMPLEMENTED in current starter
2. Manually update `openclaw.config.json5` with enrolled user IDs
3. Restart OpenClaw to apply changes

## Getting Help

**Repository Issues**: https://github.com/bobgourley/openclaw-worldid-gate/issues

**OpenClaw Documentation**: https://docs.openclaw.ai/

**World ID Documentation**: https://docs.world.org/

**Telegram Bot API**: https://core.telegram.org/bots/api

## Appendix A: Test Configuration

Example test config for local development:

```typescript
export const testConfig: GateConfig = {
  rpId: 'rp_test123',
  action: 'test-action',
  verifyEndpoint: 'https://developer.world.org/api/v4/verify',
  requireProofOfHuman: true,
  enrollmentTtlSeconds: 86400, // 1 day for testing
  allowTestMode: true,
};
```

## Appendix B: Production Checklist

Before deploying to production:

- [ ] Set `allowTestMode: false`
- [ ] Use production World ID RP ID
- [ ] Implement production World ID verifier (replace stub)
- [ ] Implement durable enrollment store (replace in-memory)
- [ ] Set up database backups
- [ ] Configure monitoring and alerting
- [ ] Test disaster recovery procedures
- [ ] Document runbook for on-call operator
- [ ] Implement separate verification bot
- [ ] Implement enrollment Mini App with HMAC validation
- [ ] Implement registry-to-allowlist sync
- [ ] Implement member tag management
- [ ] Review and test fail-closed behavior
- [ ] Conduct security audit
- [ ] Set up rate limiting on verification endpoint
- [ ] Configure secrets in secure vault (not environment variables)
