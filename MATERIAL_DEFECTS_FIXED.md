# Material Defects Fixed - Evidence Summary

## Current HEAD

**Commit**: `e5179ae`  
**Branch**: `cursor/worldid-gate-starter-9717`

## Verified Build/Test Commands (2026-11-07)

```bash
git clone https://github.com/bobgourley/openclaw-worldid-gate.git
cd openclaw-worldid-gate
git checkout cursor/worldid-gate-starter-9717
npm install
npm test        # 68 tests, 19 suites, 68 pass, 0 fail
npm run build   # passes
npm run typecheck  # passes
```

## Runnable Dry Run (Synthetic Only)

```bash
# Run existing test suite (no real credentials needed)
npm test

# Custom test example (create src/custom.test.ts):
import { AdmissionGate } from './admission-gate.js';
import { WorldIdVerifierStub } from './verifier-stub.js';
import { InMemoryEnrollmentStore } from './enrollment-store.js';
import { createTelegramUpdate, createWorldIdProof } from './fixtures.js';

# Note: createTelegramUpdate uses options object:
createTelegramUpdate({ userId: 123, text: 'hello' })
# NOT positional: createTelegramUpdate(123, 'hello')
```

## Real Verification Blockers (NOT IMPLEMENTED)

**DO NOT attempt these steps** - implementation does not exist:

1. **World ID Registration**: Requires HTTPS production hosting
2. **Verification Bot**: No `/verify` command handler implemented
3. **Enrollment Mini App**: No Mini App exists
4. **Production Verifier**: `WorldIdVerifierProduction` throws "not implemented"
5. **Durable Store**: No `PostgreSQLEnrollmentStore` class exists
6. **OpenClaw Sync**: No automatic registry-to-allowlist sync
7. **Self-Verification**: No end-to-end flow implemented

## Official Source Anchors

### Telegram Bot API

- **setChatMemberTag**: https://core.telegram.org/bots/api/methods/setchatmembertag.md
  - Requirements: Administrator right `can_manage_tags`, 0-16 characters, no emoji
  - Verified: 2026-11-07
- **Privacy Mode**: https://core.telegram.org/bots/features#privacy-mode
  - Disable = bot sees ALL group messages (broadens visibility)
  - Enable = bot sees only addressed messages (default)

### World ID

- **Verify API OpenAPI**: https://docs.world.org/api-reference/developer-portal/verify
  - Servers include `https://staging-developer.worldcoin.org` (accessed 2026-11-07)
  - Staging endpoint verified in official OpenAPI spec servers array
- **Mini App initData Validation**: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
  - **Backend only** validates HMAC-SHA256 with bot token
  - Frontend never has access to bot token

### OpenClaw

- **Access Control**: https://docs.openclaw.ai/channels/telegram/access-control (accessed 2026-11-07)
  - Schema: `channels.telegram.groupAllowFrom` (global), `groups[chatId].allowFrom` (per-group override)
  - **Version**: Current live docs, NOT 2026.9.8 specific verification

## OpenClaw 2026.9.8 Compatibility: NOT ESTABLISHED

No 2026.9.8 specific verification performed:
- No official 2026.9.8 release tag/commit checked
- No 2026.9.8 source code inspection
- No installed 2026.9.8 instance testing
- Config examples from current docs, not version-specific

**Operators must verify** 2026.9.8 compatibility independently.

## Key Documentation Fixes

### ARCHITECTURE.md

1. **Mini App HMAC**: Backend validates HMAC, frontend never has token access
2. **OpenClaw Schema**: Fixed `groupAllowFrom` vs per-group `allowFrom` consistency
3. **Fail-Closed Sync**: Periodic static allowlist insufficient for exact expiry
4. **Character Count**: "Human Verified" is 14 characters (not 15)
5. **Tag Failure**: Display-only UX, cannot grant access
6. **2026.9.8 Claims**: Removed unverified claims, marked as NOT ESTABLISHED
7. **Evidence Citations**: Added specific official source links

### OPERATOR_GUIDE.md

1. **Clone Branch**: Explicit `git checkout cursor/worldid-gate-starter-9717`
2. **API Usage**: Fixed `createTelegramUpdate` options object example
3. **Pseudocode Marked**: TestOrchestrator, store.listValid(), PostgreSQLEnrollmentStore clearly non-runnable
4. **BotFather Privacy**: Corrected Disable/Enable semantics
5. **Prerequisites**: Added HTTPS hosting requirement
6. **Removed Invented**: No "Server-side verification" app type, no npm run start:verify-bot
7. **Privacy Note**: Plaintext nullifier logging concern documented
8. **Policy Pending**: UNIQUE nullifier constraint marked as pending Bob's decision

## Code Fixes

### Expiry Boundary Logic

**Changed**: `enrollment.expiresAt <= now` (was `<`)

**Test Coverage**:
- Exact boundary test: `expiresAt == now` → rejected
- Before expiry test: `expiresAt - 1` → admitted
- After expiry test: `expiresAt + 1` → rejected

### Test Additions

- 2 new exact-boundary tests added
- Total: 68 tests (was 66)
- All passing

## Test Breakdown (68 Total)

- **Admission Gate Unit**: 22 tests (was 20, added 2 exact-boundary)
- **Config Validation**: 23 tests
- **Action-Model Gap**: 6 tests
- **Constructor Validation**: 6 tests
- **Orchestrator Integration**: 10 tests
- **Clock/Fixtures**: 1 test

**Suites**: 19

## Schema Corrections

### OpenClaw Config (Verified from Official Docs)

```json5
{
  channels: {
    telegram: {
      groupAllowFrom: [123, 456],  // Global sender allowlist
      groups: {
        "-1001234567890": {
          allowFrom: [123]  // Per-group override (NOT groupAllowFrom)
        }
      }
    }
  }
}
```

### Database Schema (Proposed, NOT Policy-Approved)

```sql
CREATE TABLE enrollments (
  telegram_user_id BIGINT PRIMARY KEY,
  world_id_nullifier TEXT NOT NULL,  -- UNIQUE constraint pending policy
  ...
);
```

**Privacy**: Plaintext logging strategy unresolved.

## Sync Mode Fail-Closed Analysis

### Mode 1 (Recommended): Per-Request Enforcement

- Queries registry on EVERY admission
- Exact expiry enforcement
- No stale grants

### Mode 2 (Insufficient): Periodic Static Allowlist

- **NO mechanism stops stale authorized senders** between syncs
- Short interval reduces but never eliminates staleness
- Unsafe for required expiry guarantees
- Requires additional per-request lease checks OR fail-closed channel disable

### Fail-Closed Options

- **Option A (static allowlist)**: DEFECT - cannot stop stale senders
- **Option B (channel disable)**: Safest but most disruptive
- **Option C (per-request)**: Mode 1 architecture required

## Manual Bypass Risk

Manual allowlist entries outside managed namespace would bypass gate enforcement unless explicitly separated from managed policy.

## Concise Summary

**Fixed**: 20+ material defects across documentation and code  
**Added**: Exact boundary tests, expiry logic correction  
**Verified**: All official sources cited with specific URLs  
**Tested**: 68/68 passing, build/typecheck clean  
**Blockers**: Real verification requires unimplemented components  
**HEAD**: `e5179ae`

All claims verified, pseudocode marked, invented APIs removed, official sources cited, exact boundary tests added.
