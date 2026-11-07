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

**IMPORTANT**: The unmerged starter is on feature branch `cursor/worldid-gate-starter-9717`, NOT main.

```bash
git clone https://github.com/bobgourley/openclaw-worldid-gate.git
cd openclaw-worldid-gate
git checkout cursor/worldid-gate-starter-9717
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

Create a new test file `src/custom-operator-example.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionGate } from './admission-gate.js';
import { WorldIdVerifierStub } from './verifier-stub.js';
import { InMemoryEnrollmentStore } from './enrollment-store.js';
import { createTelegramUpdate, createWorldIdProof } from './fixtures.js';
import type { GateConfig } from './types.js';

describe('Custom operator test (documented example)', () => {
  it('simulates enrollment and admission', async () => {
    // Explicit synthetic test config (not placeholder)
    const testConfig: GateConfig = {
      rpId: 'rp_test_synthetic_123',
      action: 'test-action-synthetic',
      verifyEndpoint: 'https://developer.world.org/api/v4/verify',
      requireProofOfHuman: true,
      enrollmentTtlSeconds: 2592000,
      allowTestMode: true,
    };

    const verifier = new WorldIdVerifierStub();
    const store = new InMemoryEnrollmentStore();
    const gate = new AdmissionGate(testConfig, verifier, store);
    
    // Simulate World ID proof for Telegram user 123456789
    const telegramUserId = 123456789;
    const nullifier = '0xtest_nullifier_123';
    verifier.addValidNullifier(nullifier);
    const proof = createWorldIdProof({ 
      nullifier, 
      action: testConfig.action 
    });
    
    // Enroll user
    const enrollResult = await gate.enroll(telegramUserId, proof);
    assert.equal(enrollResult.success, true);
    
    // Check admission (createTelegramUpdate uses options object)
    const update = createTelegramUpdate({
      userId: telegramUserId,
      text: 'Hello bot',
    });
    const admissionResult = await gate.checkAdmission({
      telegramUpdate: update,
      timestamp: Date.now(),
    });
    
    assert.equal(admissionResult.allowed, true);
    console.log('Admission successful:', admissionResult);
  });
});
```

Run your custom test (tsx discovers .test.ts files in src/):

```bash
npm test src/custom-operator-example.test.ts
# Output: tests 1, pass 1, fail 0
```

### 3. Synthetic Orchestrator Integration (PLANNED PSEUDOCODE, NOT RUNNABLE)

The existing test suite demonstrates orchestration wiring. A future helper API might look like:

```typescript
// PSEUDOCODE EXAMPLE (NOT IMPLEMENTED)
// The actual TestOrchestrator requires gate and processor constructor arguments
// See src/orchestrator.test.ts for runnable test examples

import { TestOrchestrator } from './orchestrator.test.js';

// Would require: gate + processor instances
const orchestrator = new TestOrchestrator(gate, processor);

// Enroll and process (methods do not exist on current TestOrchestrator)
await orchestrator.enrollUser(123456789);
await orchestrator.processMessage(123456789, 'Hello');
```

**Runnable tests**: See existing test suite in `src/orchestrator.test.ts` for actual working examples.

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

**DO NOT PERFORM THESE STEPS NOW** (requires World ID Developer Portal account, HTTPS production hosting, and real integration planning).

**Prerequisites for World ID Registration**:
- HTTPS-hosted production server (World ID requires HTTPS for security)
- World App installed on device OR Orb access for proof generation
- Understanding of action strings and nullifier scope

When ready for production:

1. Visit https://developer.world.org/
2. Sign in and create new application
3. Configure application (specific setup steps depend on Developer Portal UI)
4. Define action string (e.g., "openclaw-gate-production")
5. Copy your RP ID (starts with `rp_`)
6. Store RP ID securely (environment variable, not git)

**Blockers for NOW**:
- No HTTPS production hosting configured
- No enrollment Mini App implemented
- No production verification backend
- Integration architecture not finalized

**DO NOT collect or configure secrets in this synthetic dry-run phase.**

### Step 2: Register Verification Bot with @BotFather

**Verification bot handler ALREADY IMPLEMENTED** (tested at commit 040e904).

**Components Existing**:
- ✅ Telegram bot handler with `/verify`, `/status`, `/help`, `/start` commands
- ✅ Challenge session management with requester binding
- ✅ Local HTTP service for enrollment API

**NOT Tested** (require live integration):
- Real Telegram webhook/polling with authentic update signatures
- Real World App proof generation on device
- Public HTTPS hosting with valid TLS certificate

**Live Bot Registration Steps** (when ready):
1. Message @BotFather on Telegram
2. Send `/newbot`
3. Choose name: "MyApp Verification Bot"
4. Choose username: "myapp_verify_bot"
5. Copy bot token
6. Configure `TELEGRAM_BOT_TOKEN` environment variable
7. **Bot Privacy and Group Messages**:
   - `/setprivacy` → **Enable** (default): Bot sees only messages addressed to it
   - Reference: https://core.telegram.org/bots/features#privacy-mode

### Step 3: Deploy Enrollment Mini App

**Telegram Mini App UI ALREADY IMPLEMENTED** (tested at commit 040e904).

**Components Existing**:
- ✅ Enrollment UI with World ID IDKit SDK integration
- ✅ Telegram `initData` HMAC-SHA256 validation
- ✅ Challenge session binding to requesting Telegram user ID
- ✅ 3 browser tests passing

**NOT Tested** (require live integration):
- Real World App proof generation on device
- Public HTTPS endpoint with valid TLS certificate (provider NOT YET SELECTED)

**Live Deployment Prerequisites**:
- [ ] Select HTTPS provider (Cloudflare Tunnel / ngrok / custom domain)
- [ ] Provision public HTTPS endpoint for Mini App
- [ ] Configure TLS certificate

### Step 4: Configure Production Verifier

**World ID HTTP verification client ALREADY IMPLEMENTED** (tested at commit 040e904).

**Components Existing**:
- ✅ Production World ID API client (production and staging endpoints)
- ✅ Error handling, retries, timeouts
- ✅ Nullifier validation and replay prevention
- ✅ 354 unit tests passing

**NOT Tested** (require live integration):
- Live World ID Developer Portal API calls with registered app credentials

**Live Configuration Steps**:
1. Register World ID application at https://developer.worldcoin.org/
2. Obtain production `app_id` and `action`
3. Configure `WORLDID_APP_ID` and `WORLDID_ACTION` environment variables
4. Select verification level (device / orb)

### Step 5: Configure Durable Enrollment Store

**SQLite enrollment store ALREADY IMPLEMENTED** (tested at commit 040e904).

**Components Existing**:
- ✅ Durable transactional SQLite store
- ✅ Revocation lifecycle management
- ✅ Atomic operations for enrollment CRUD
- ✅ Single atomic transaction: challenge consume + enrollment create
- ✅ 354 unit tests passing

**Production Configuration**:

```typescript
// Current implementation (SQLite)
import { SQLiteEnrollmentStore } from './src/enrollment-store.js';

const store = new SQLiteEnrollmentStore({
  // Configuration TBD
});
```

**Proposed database schema** (illustrative, NOT policy-approved):

```sql
CREATE TABLE enrollments (
  telegram_user_id BIGINT PRIMARY KEY,
  world_id_nullifier TEXT NOT NULL,  -- UNIQUE constraint pending policy decision
  enrolled_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_expires_at ON enrollments(expires_at);
-- Unique nullifier constraint pending Bob's uniqueness policy decision
```

**Privacy note**: Logging plaintext nullifiers and user IDs raises privacy concerns. Minimization strategy unresolved.

### Step 6: Self-Verification (Real)

**DO NOT PERFORM THIS STEP NOW** (requires all previous steps completed).

**PLANNED PROCEDURE (NOT RUNNABLE, NO IMPLEMENTATION)**:

When all components are implemented and deployed:

1. Start verification bot (command TBD, no `npm run start:verify-bot` script exists)
2. Send `/verify` to your verification bot in Telegram DM
3. Click enrollment link (opens Mini App)
4. Complete World ID verification via IDKit
5. Verify enrollment created in database (query depends on final schema)
6. Test admission with your main bot
7. Check for "Human Verified" tag in group (if implemented)

**Current blockers**:
- No verification bot implementation
- No enrollment Mini App
- No durable database
- No OpenClaw integration
- No tag management implementation

## OpenClaw Integration

### Integration Design Status

**Current Status**: Integration requirements documented in `ARCHITECTURE.md`.  
**Approval Status**: Bob has NOT approved any upstream OpenClaw modifications.  
**Verified Source**: OpenClaw commit `fc23bc864e4553c2d215e479eeec47b67a0bf943`

### UNAPPROVED Integration Requirements

**UNRESOLVED Technical Scope**:
- OpenClaw middleware injection mechanism (no public plugin API exists)
- Human actor extraction utility (not yet implemented)
- Protected group scope configuration (format NOT DEFINED)
- Fresh recheck for queued/debounced updates (seam locations NOT TRACED)

**Known Limitations**:
- Poll registry reads content BEFORE any proposed gate (line 212)
- Content-free poll classification policy NOT YET ESTABLISHED
- Callback/native command separate authorization paths NOT YET UNIFIED
- Fail-closed guarantees depend on recheck frequency (NOT YET DEFINED)

### Operator Configuration Requirements (UNRESOLVED)

**Prerequisites BEFORE Configuration**:
1. Bob approval for upstream OpenClaw modifications
2. OpenClaw middleware injection API implemented
3. Poll registry content read policy selected (Option A vs B)
4. Fresh recheck seam locations identified and verified

**Protected Group Identification**:
- Obtain numeric chat IDs for protected groups (e.g., `-1001234567890`)
- Document out-of-scope groups (pass-through behavior)
- Define DM policy (enforce verification or allow) - NOT YET ESTABLISHED

**Configuration Mechanism** (NOT YET DEFINED):
- OpenClaw plugin/middleware registration format UNKNOWN
- Protected group scope configuration interface UNKNOWN
- Registry connection specification UNKNOWN
- Fresh recheck trigger configuration UNKNOWN

**Test Requirements** (AFTER implementation):

Critical test cases required BEFORE production:
1. Protected group + verified human → history/model called
2. Protected group + expired enrollment → zero history/model/tools
3. Protected group + revoked enrollment → zero history/model/tools
4. Protected group + channel actor (sender_chat) → zero history/model/tools
5. Protected group + missing actor → zero history/model/tools
6. Out-of-scope group + any actor → pass-through (existing behavior)
7. Registry timeout → fail-closed behavior (policy NOT YET DEFINED)
8. Unknown poll in protected group → policy NOT YET ESTABLISHED

**UNPROVEN Test Coverage**:
- Fresh recheck for queued updates (seam location NOT TRACED)
- Fresh recheck for debounced updates (seam location NOT TRACED)
- Fresh recheck for media album buffer (seam location NOT TRACED)
- Callback query authorization unified with gate (NOT YET UNIFIED)
- Native command authorization unified with gate (NOT YET UNIFIED)

**Monitoring Requirements**:
- Admission attempts (allowed vs denied)
- Denial reasons distribution
- Registry query latency (P50, P95, P99)
- Registry errors and timeouts
- Alert on high denial rate, registry unavailable, or timeout spikes

### Rollback and Recovery

**UNSAFE Rollback Practice** (documented for awareness):

❌ **DO NOT restore old database backup without verification**
- Old backup resurrects revoked enrollments
- Post-backup revocations are LOST
- Separate revocation table in SAME restored DB is NOT independent protection

**SAFE Rollback Options**:

#### Option A: Protected Admissions Remain Fail-Closed During Uncertain Restore

```bash
# 1. Keep gate active with deny-all for protected groups
# NEVER disable gate or bypass protected admission enforcement
# Out-of-scope groups continue unchanged

# 2. Restore database backup
cp enrollments-backup.db enrollments.db

# 3. Verify trustworthy revocation state
# CRITICAL: World ID API CANNOT recover local revocation history
# World API verifies proof validity, NOT enrollment revocation status
# Local registry maintains revocation lifecycle independently

# Option 3a: Apply fresh post-revoke enrollment policy
# - Require new challenge + proof for ALL restored enrollments
# - Pre-revoke challenges CANNOT restore

# Option 3b: Reconcile from separate immutable revocation log (not yet built)

# 4. Resume protected admissions only after reconciliation
# Uncertain restored state MUST remain deny-all until trustworthy
```

#### Option B: Immutable Revocation Log (NOT YET IMPLEMENTED)

**Future enhancement**:
- Separate append-only revocation log outside main DB
- Query revocations independently after DB restore
- Requires implementation of separate log storage

#### Option C: Fresh Post-Revoke Enrollment Policy

**CRITICAL**: World ID API CANNOT recover local revocation history.

```bash
# World API verifies proof validity, NOT enrollment revocation status
# Local registry maintains revocation lifecycle independently

# Require fresh challenge + proof for ALL restored enrollments
# Pre-revoke challenges CANNOT restore
```

**Recommended**: Use Option A (fail-closed during restore) until Option B (immutable log) is implemented.

### Unresolved Decisions (Awaiting Bob's Approval)

1. **OpenClaw Ingress Gate Design**
   - Bob has NOT approved any upstream OpenClaw modifications
   - No public middleware injection API exists
   - Fresh recheck seam locations NOT YET TRACED

2. **Poll Registry Content Read Policy**
   - Option A: Content-free index (metadata-only routing)
   - Option B: Deny unknown polls in protected groups
   - Current: Registry reads poll question/options BEFORE any proposed gate (line 212)

3. **Retention Policy**
   - How long to retain expired/revoked enrollments?
   - Options: indefinite / 90-day / explicit deletion
   - Current: soft-expire (no auto-delete)

4. **HTTPS Provider Selection**
   - Options: Cloudflare Tunnel / ngrok / custom domain
   - Current: NOT YET PROVISIONED

### Settled Policies (NOT reopened for Bob decision)

1. **Multiple Accounts Per Nullifier**: ALLOWED - same verified human may enroll multiple Telegram accounts, each requires fresh authenticated proof per account

2. **Post-Revocation Restoration**: ALLOWED - revoked accounts may restore via fresh post-revoke challenge + proof; pre-revoke challenges CANNOT restore

3. **Default TTL**: 30 days (2592000 seconds), bounded [60s, 31536000s]

4. **TTL Configuration Changes**: Do NOT retroactively alter stored `expiresAt` timestamps; apply to NEW enrollments only

### Operator Pre-Deployment Checklist

**Existing Components** (built and tested at 040e904):
- [x] Telegram bot handler with `/verify`, `/status`, `/help`, `/start` commands
- [x] Telegram Mini App enrollment UI with World ID IDKit SDK integration
- [x] World ID HTTP verification client (production and staging endpoints)
- [x] SQLite enrollment store with revocation lifecycle
- [x] Challenge session management with requester binding
- [x] 354 unit tests + 3 browser tests passing

**Unresolved Prerequisites** (awaiting Bob approval):
- [ ] Bob approved upstream OpenClaw modifications
- [ ] Poll registry content read policy selected (Option A vs B)
- [ ] Fresh recheck seam locations identified and verified
- [ ] HTTPS provider selected and provisioned (Cloudflare Tunnel / ngrok / custom)

**Deployment Prerequisites** (AFTER Bob approval):
- [ ] OpenClaw ingress gate implemented
- [ ] Protected group numeric chat IDs documented
- [ ] Registry connection configured
- [ ] Monitoring and alerting configured
- [ ] Rollback procedure tested with fail-closed guarantees
- [ ] Test matrix executed (8+ critical test cases)
- [ ] Out-of-scope groups tested (pass-through unchanged)

### Alternative: Periodic Allowlist Sync (NOT RECOMMENDED)

**Status**: INSUFFICIENT for exact expiry/revocation guarantees.

**Problem**: Static allowlist has NO mechanism to stop stale authorized senders between syncs.

**If Required Despite Limitations**:
- Sync OpenClaw `groupAllowFrom` config every 1-5 minutes
- **MUST add independent per-request lease check** to bound staleness
- Monitor sync failures with fail-closed fallback
- Accept staleness window (up to sync interval)

**Recommended**: Use pre-history ingress gate instead.

### Operator Troubleshooting

**High Denial Rate**:
1. Check World ID registry availability
2. Verify protected group IDs configured correctly
3. Review denial reasons distribution (not-enrolled vs expired vs revoked)
4. Check for enrollment service outage

**Registry Query Timeouts**:
1. Check database connection pool exhaustion
2. Verify database file not corrupted
3. Check disk I/O performance
4. Review query optimization (indexes on telegram_user_id)

**All Admissions Denied**:
1. Check registry service health
2. Verify fail-closed mode not accidentally enabled
3. Check database connection string
4. Review recent configuration changes

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

**Existing Components** (tested at commit 040e904):
- [x] Production World ID HTTP verifier (production and staging endpoints)
- [x] Durable SQLite enrollment store with revocation lifecycle
- [x] Telegram bot handler with `/verify`, `/status`, `/help`, `/start`
- [x] Enrollment Mini App with World ID IDKit SDK integration
- [x] Telegram `initData` HMAC-SHA256 validation
- [x] 354 unit tests + 3 browser tests passing

**Unresolved Prerequisites** (awaiting Bob approval):
- [ ] Bob approved upstream OpenClaw modifications
- [ ] Poll registry content read policy selected (Option A vs B)
- [ ] Fresh recheck seam locations identified and verified
- [ ] HTTPS provider selected and provisioned

**Live Integration** (NOT tested):
- [ ] Real Telegram webhook/polling with authentic update signatures
- [ ] Real World App proof generation on device
- [ ] Live World ID Developer Portal API calls
- [ ] Public HTTPS endpoint with valid TLS certificate

**Production Deployment**:
- [ ] Set `allowTestMode: false`
- [ ] Use production World ID app ID and action
- [ ] Set up database backups with fail-closed restore procedures
- [ ] Configure monitoring and alerting
- [ ] Test disaster recovery procedures (deny-all during uncertain restore)
- [ ] Document runbook for on-call operator
- [ ] OpenClaw ingress gate integration (AFTER Bob approval)
- [ ] Member tag management (optional)
- [ ] Review and test fail-closed behavior
- [ ] Conduct security audit
- [ ] Set up rate limiting on verification endpoint
- [ ] Configure secrets in secure vault (not environment variables)
