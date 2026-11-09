
# Architecture: World ID Gated OpenClaw

This document describes the INITIAL small-group architecture for World ID-based human verification admission control on OpenClaw Telegram bots.

## Implementation Status

**IMPLEMENTED Production Components** (commit 382f240 + current):
- ✅ Production Telegram Mini App `initData` backend validator (`src/telegram-initdata.ts`)
  - HMAC-SHA256 validation per official Telegram algorithm
  - Duplicate query key rejection (prevents parameter pollution)
  - Freshness check (auth_date within configurable window, exact boundary validation)
  - Clock injection for deterministic testing
  - Secure user extraction from validated initData
  - 15 comprehensive unit tests
- ✅ Production World ID v4.0 proof verification client (`src/worldid-client.ts`)
  - Server-side proof verification against Developer Portal API
  - Server-trusted expected context validation (action/nonce/signal)
  - Strict credential enforcement (proof_of_human with issuer_schema_id: 1)
  - Unambiguous single credential policy (rejects multi-response batches)
  - Bounded timeout through complete body consumption
  - Runtime validation of unknown input structures
  - Exact boolean success check (rejects truthy non-boolean)
  - Environment validation (production/staging)
  - 20 comprehensive unit tests
- ✅ Production enrollment store abstraction (`src/enrollment-store.ts`)
  - Challenge session interface for single-use nonce binding
  - Enrollment interface with transactional semantics
  - In-memory implementation for development (NOT for production)
  - 25 comprehensive unit tests
- ✅ SQLite challenge and enrollment stores (`src/enrollment-service-production.ts`)
  - Durable persistence with WAL mode and schema migrations
  - Per-account enrollment lifecycle (PRIMARY KEY: telegram_user_id, action)
  - Multiple accounts can share same nullifier (same verified person, different Telegram accounts)
  - Revocation with generation timestamps for post-revoke restoration
  - Restart persistence (survives process restart)
  - WAL mode for better concurrency
  - Portable to Mac Node24
  - 24 comprehensive behavioral tests
  - NOTE: Stores use separate connections, NOT fully transactional requester-bound completion
- ✅ Transactional enrollment service (`src/enrollment-service.ts`)
  - Single shared database connection for atomic operations
  - Transactional requester-bound completion (challenge consume + enrollment create together)
  - Authenticated requester validation against stored challenge
  - Signal binding (telegram:{userId}:{action} hashed to prevent proof replay)
  - Invalid proof/account mismatch do not burn legitimate requester's challenge
  - Per-action nullifier scoping (composite primary key: nullifier + action)
  - Dependency-injected proof verification (no live HTTP calls in tests)
  - 9 comprehensive behavioral tests (account mismatch, atomic transaction, proof replay protection)
- ✅ Fail-closed admission gate with enrollment registry (`src/admission-gate.ts`)
  - Zero LLM/history/tool calls for rejected senders
  - Deterministic clock injection for testing
  - Action-scoping validation
  - 44 unit tests proving fail-closed guarantees
- ✅ Constructor-level configuration validation with bounded safety checks

- ✅ HTTP service with enrollment endpoints (`src/http-service.ts`)
  - Localhost-only binding (127.0.0.1:3000)
  - Body size limits (max 2MB, World ID proofs ~10-50KB)
  - Request timeouts (30 seconds default)
  - Generic error responses (no identity leaks)
  - Health and readiness probes
  - Challenge creation, enrollment completion, and query endpoints
  - 8 comprehensive integration tests
- ✅ Telegram bot handler (`src/telegram-bot-handler.ts`)
  - Webhook secret validation (X-Telegram-Bot-Api-Secret-Token)
  - Fail-closed on malformed updates, bot messages, group messages
  - Commands: /verify, /status, /help, /start
  - Session-based enrollment flow (requester-bound, single-use, 5-minute expiry)
  - Injectable transport for testing (no live Telegram API calls in tests)
  - 25 comprehensive security tests
- ✅ Enrollment UI (`src/ui/enrollment.html`)
  - Self-contained HTML with no secrets in client code
  - Official IDKit SDK integration via CDN (v4.6.0)
  - Session validation before displaying verification UI
  - Proof submission to backend enrollment API
  - Clear user feedback for errors, expiry, success states

**NOT YET IMPLEMENTED (require deployment/live integration):**
- ❌ OpenClaw pre-history ingress authorization hook
- ❌ Member tag management via `setChatMemberTag`
- ❌ OpenClaw group allowlist integration
- ❌ Registry-to-allowlist sync lifecycle
- ❌ Mac mini deployment supervision/monitoring

## Official SDK Integration (Completed)

**Authentic World ID v4 Protocol Implementation** using official SDKs:
- ✅ Installed `@worldcoin/idkit-core@4.6.0` and `@worldcoin/idkit-server@1.2.0`
- ✅ `WorldIdChallengeAdapter` (`src/worldid-challenge-adapter.ts`)
  - Official SDK signal hashing: Keccak256 + field reduction (`hashSignal()`)
  - Official RP challenge signing: ECDSA EIP-191 message signing (`signRequest()`)
  - Runtime configuration: App ID, RP ID, signing key (not hardcoded)
  - Per-action uniqueness proofs (not sessions)
  - 27 comprehensive unit tests with throwaway test keys
- ✅ `EnrollmentServiceV2` (`src/enrollment-service-v2.ts`)
  - Full SDK integration replacing handwritten SHA-256
  - Stable action scope (service-level, not per-user)
  - Signal binds proof to requester (telegram:{userId})
  - Expected context stored with signal hash
  - 14 integration tests with SDK-signed contexts
- ✅ SDK-based type contracts (`src/worldid-types.ts`)
  - Frontend IDKit configuration (RpContext, FrontendIDKitConfig)
  - IDKitResult from World App
  - Developer Portal API request/response
  - Expected verification context
- ✅ **World ID v4 Protocol Reference** (consolidated in ARCHITECTURE.md)
  
### Uniqueness Semantics (from Official SDK)

**Nullifier Generation**:
- World ID generates RP-scoped nullifiers: `hash(credential, rp_id, action)`
- Same human + same action → same nullifier (deterministic)
- Different actions → different nullifiers (per-action isolation)

**One-Time Per Action**:
- World cryptographically generates nullifiers but does NOT prevent replay at API level
- Backend MUST enforce nullifier uniqueness in enrollment registry
- "One-time per action" = backend check, not World cryptographic refusal
- Same nullifier submitted twice → second attempt rejected by backend (UNIQUE constraint)

**Action Scope Requirements**:
- Action MUST be stable service/group scope (e.g., "telegram-bot-human-verification")
- Action MUST NOT be per-user (e.g., "enroll-user-{userId}") - breaks one-human policy
- Signal binds proof to requester context without changing nullifier scope
- Nonce binds challenge to session without changing nullifier scope

**Session Proofs vs Uniqueness Proofs**:
- Uniqueness proofs: One-time per action, requires action field
- Session proofs: Recurring authentication, no action field, generates session_id
- Our integration uses uniqueness proofs only
- 30-day recurring renewal requires session proofs (different flow, not yet implemented)

### Signal Hashing (Keccak256 + Field Reduction)

The SDK uses Keccak256 (not SHA-256) with field reduction:

```typescript
function hashToField(input: Uint8Array): Uint8Array {
  const hash = BigInt('0x' + bytesToHex(keccak_256(input))) >> 8n;
  return hexToBytes(hash.toString(16).padStart(64, '0'));
}

function hashSignal(signal: string | Uint8Array): string {
  // UTF-8 encoding for strings, hex decoding for 0x-prefixed hex strings
  return '0x' + bytesToHex(hashToField(input));
}
```

**Key differences from SHA-256**:
- Keccak256 (not SHA-256/SHA3-256)
- Right-shift by 8 bits for field reduction
- Returns 0x-prefixed 64-character hex
- UTF-8 encoding for string signals

### RP Challenge Signing (ECDSA EIP-191)

```typescript
function signRequest({ signingKeyHex, action?, ttl? }): RpSignature {
  // Message: version(1) || nonce(32) || createdAt(8 BE) || expiresAt(8 BE) || [actionHash(32)]
  // Ethereum EIP-191 message signing
  // Returns: { sig: '0x...' (65 bytes), nonce: '0x...' (32 bytes), createdAt, expiresAt }
}
```

**Signed message structure**:
- Version: Always `0x01`
- Nonce: 32-byte cryptographically secure random, hashed to field
- Timestamps: Unix seconds, 8-byte big-endian
- Action hash: Appended for uniqueness proofs, omitted for sessions
- Signature: 65-byte ECDSA with recovery byte (v) at offset 64

### Runtime Configuration

**Environment variables (production)**:
```bash
WORLDID_APP_ID=app_staging_0123456789abcdef0123456789ab
WORLDID_RP_ID=rp_0123456789abcdef
WORLDID_SIGNING_KEY_HEX=<32-byte ECDSA private key, hex>
WORLDID_ENVIRONMENT=production
WORLDID_ACTION=telegram-bot-human-verification
TELEGRAM_BOT_TOKEN=<bot token from BotFather>
```

**Security**:
- Signing key MUST be loaded from secure secret management
- NEVER commit signing keys to version control
- Test keys in tests are throwaway (NEVER use in production)
- Bob retains production signing key

### Developer Portal API

**Verification endpoint**: `https://developer.worldcoin.org/api/v2/verify/{app_id}`

**Request body**:
```json
{
  "action": "telegram-bot-human-verification",
  "nullifier_hash": "nil_<64-hex>",
  "merkle_root": "0x<64-hex>",
  "proof": "0x<long-hex>",
  "credential_type": "proof_of_human",
  "signal_hash": "0x<64-hex>"
}
```

**Response (success)**:
```json
{
  "success": true,
  "action": "telegram-bot-human-verification",
  "nullifier_hash": "nil_<64-hex>",
  "created_at": "2026-11-07T04:00:00.000Z",
  "credential_type": "proof_of_human"
}
```

**Response (failure)**:
```json
{
  "success": false,
  "code": "invalid_proof",
  "detail": "Proof verification failed"
}
```

**Success validation**:
- MUST be exact boolean `true` (not truthy)
- Response does NOT contain credential details (those are in request)
- Backend extracts nullifier from original IDKitResult, not API response

## Production Service Status (Current)

**Runnable**: Yes (local HTTP service, localhost-bound, ephemeral DB, throwaway keys)
**Production Ready**: No (blocked by policy decisions and configuration)

### Implemented (Canonical)
- `EnrollmentService` (`src/enrollment-service-production.ts`): Clock injection, TTL bounds (60-3600s/1-365d), revocation lifecycle
- `WorldIdHttpVerifier` (`src/worldid-verifier-http.ts`): Forwards IDKitResult intact to Developer Portal API
- `HttpService` (`src/http-service.ts`): Localhost binding (127.0.0.1:3000), body limits (max 2mb), generic errors

### Material Defects Fixed
1. Clock injection for deterministic testing
2. TTL bounds enforced in constructor (not stored unused)
3. Revocation: UPDATE not DELETE, blocks in-flight + future enrollment
4. Fail-closed validation: malformed requests return errors without throwing
5. Schema migrations: version tracking prevents CREATE TABLE conflicts

### Test Coverage
- **260 tests, 259 passing, 0 failures, 1 skipped**
- NEW tests (33 added):
  * EnrollmentService Production: 26 tests (TTL bounds, initData auth, expiry with fake clock, revocation lifecycle, cross-connection races, schema migrations)
  * WorldIdHttpVerifier: 9 tests (SDK structure validation, boundary checks)
- Old implementations removed: enrollment-service.ts, enrollment-service-v2.ts (obsolete SHA-256 path retired)

### Blocking Policy Decisions
1. Multiple account enrollment: Same human (nullifier), different Telegram accounts?
2. Re-enrollment after revoke: Explicit restoration workflow?
3. Session proofs for renewal: When to implement vs re-enrollment?
4. Retention policy: How long to retain expired/revoked records?

### Configuration Required
- Runtime secrets (app ID, RP ID, signing key, bot token) from secure storage
- Database path (persistent vs ephemeral)
- HTTP binding (localhost vs network)
- TLS termination (reverse proxy)

### Remaining Implementation Gaps
- Enrollment query endpoint (returns 501, needs auth refactor)
- Administrative restore API (requires separate authenticated channel)
- Session proofs (pending policy decision)
- Telegram Mini App frontend

## Deployment Architecture Decision

**Hosting**: Mac mini backend for verification service, separate from live OpenClaw workspace.

**Network Topology**:
- Public HTTPS endpoint exposes verification service only (challenge initiation, Mini App backend, enrollment completion)
- OpenClaw main bot remains private (no public exposure)
- Verification service communicates with OpenClaw via local/VPN connection to sync allowlist

**Rationale**:
- Separate verification service reduces attack surface on main OpenClaw bot
- Public HTTPS required only for Telegram Mini App (Telegram validates TLS certificate)
- Transactional registry can use local SQLite or PostgreSQL on Mac mini
- Mac mini provides durable storage and reliable uptime for enrollment registry

## Small-Group Architecture

The architecture is designed for small trusted groups with human-verified member admission control.

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Workflow                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. User sends DM to VERIFICATION BOT                           │
│     /verify                                                      │
│                                                                  │
│  2. Bot generates short-lived single-use enrollment link        │
│     - Bound to requesting numeric Telegram user ID              │
│     - 5-minute TTL                                              │
│     - HMAC-signed initData for Mini App validation              │
│                                                                  │
│  3. User opens Telegram Mini App (enrollment link)              │
│     - Mini App validates initData HMAC                          │
│     - User completes World ID verification (IDKit)              │
│     - Proof is bound to Telegram user ID via challenge          │
│                                                                  │
│  4. Backend validates proof and creates enrollment              │
│     - Validates World ID proof via API                          │
│     - Creates enrollment with 30-day default TTL                │
│     - Adds numeric Telegram user ID to registry                 │
│                                                                  │
│  5. Registry-to-allowlist sync (periodic or per-request)        │
│     - Verified enrollments → add to OpenClaw allowlist          │
│     - Expired/revoked enrollments → remove from allowlist       │
│     - Atomic, idempotent, fail-closed                           │
│                                                                  │
│  6. User joins MAIN BOT group                                   │
│     - OpenClaw checks numeric sender ID against allowlist       │
│     - Admitted users can interact with agent                    │
│     - Bot applies "Human Verified" member tag (if enabled)      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Verification Bot (PLANNED)

**Purpose**: Separate bot handling enrollment via DM `/verify` command.

**Responsibilities**:
- Receive `/verify` command from users in DM
- Generate short-lived single-use enrollment links
- Bind enrollment links to requesting Telegram user ID
- Validate enrollment completions
- Update enrollment registry

**Telegram Bot API Methods**:
- `getUpdates` or `setWebhook` for receiving `/verify` commands
- `sendMessage` to send enrollment link to user
- Authentication via bot token (polling) or webhook `secret_token` + `X-Telegram-Bot-Api-Secret-Token` header

**Configuration**:
```typescript
{
  verificationBot: {
    enabled: true,
    botToken: process.env.VERIFICATION_BOT_TOKEN, // MUST be in environment
    allowedStarterBotUserIds: [123456789] // Which main bot(s) this verifier serves
  }
}
```

### Enrollment Links (PLANNED)

**Purpose**: Short-lived single-use links for World ID verification bound to requesting Telegram user.

**Security Properties**:
- TTL: 5 minutes (configurable)
- Single-use: Link invalidated after one successful verification
- User-bound: Backend validates that completion comes from the user who requested the link
- Links CAN be copied/forwarded, but backend validation prevents authorization transfer

**Telegram Mini App Integration**:
- **BACKEND ONLY** validates `initData` via HMAC-SHA256 with bot token
- Frontend NEVER has access to bot token, NEVER validates HMAC
- Backend validates `auth_date` within acceptable window (e.g., 1 hour)
- Backend extracts authenticated `user.id` from Telegram-provided `initData`
- Bot does NOT mint `initData`; Telegram provides it with each Mini App launch
- Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

**Implementation Steps**:
1. User requests `/verify` in DM to verification bot
2. Backend generates random enrollment session ID
3. Backend stores session with (sessionId, requestingTelegramUserId, expiresAt, used=false)
4. Backend constructs Mini App URL with sessionId parameter
5. User opens link; Telegram launches Mini App with fresh signed `initData`
6. **Mini App frontend** shows World ID IDKit verification UI (does NOT validate HMAC)
7. **Backend** receives completion with `initData` + World ID proof
8. **Backend** validates Telegram-provided `initData` HMAC-SHA256 with bot token
9. **Backend** validates `auth_date` is recent
10. **Backend** validates extracted `user.id` matches session's requestingTelegramUserId
11. **Backend** validates World ID proof via World ID API
12. **Backend** creates enrollment only if ALL validations pass
13. **Backend** marks session as used (prevent reuse)

### Member Tags (PLANNED)

**Purpose**: Display-only "Human Verified" tag on group members who completed verification.

**Telegram Bot API Method**: `setChatMemberTag`

**Requirements**:
- Bot must have administrator right `can_manage_tags` in group/supergroup
- Target must be regular member (not administrator, creator, or bot)
- Tag text: 0-16 characters, no emoji
- Proposed tag: "Human Verified" (14 characters including space)

**Official Source** (retrieved 2026-11-06):

From https://core.telegram.org/bots/api/methods/setchatmembertag.md:
> "Use this method to set a tag for a regular member in a group or a supergroup. The bot must be an administrator in the chat for this to work and must have the can_manage_tags administrator right. Returns True on success."
> 
> Parameter `tag`: "New tag for the member; 0-16 characters, emoji are not allowed"

From https://core.telegram.org/bots/api/types/chatadministratorrights.md:
> Field `can_manage_tags`: "Optional. True, if the administrator can edit the tags of regular members; for groups and supergroups only"

**Limitations**:
- Only works in groups and supergroups
- Does NOT work in channels or private chats
- Requires bot administrator permissions
- Tag is display-only metadata, not an access control mechanism

**Implementation Notes**:
- Apply tag after successful enrollment
- Remove tag when enrollment expires or is revoked
- Tag updates are best-effort (member may leave/rejoin, bot may lose admin rights)
- **Tag is display-only UX, not access control**: Tag failure (missing permission, API error) CANNOT grant access. Access enforcement happens at admission gate, independently of tagging success.

### OpenClaw Group Allowlist Integration (PLANNED)

**Purpose**: Fail-closed admission enforcement at OpenClaw gateway level using numeric Telegram user ID allowlist.

**OpenClaw Configuration Schema** (from official docs):

```json5
{
  channels: {
    telegram: {
      enabled: true,
      dmPolicy: "allowlist",
      allowFrom: [123456789], // Numeric Telegram user IDs for DMs
      groupPolicy: "allowlist",
      groupAllowFrom: [123456789, 987654321], // Global group sender allowlist
      groups: {
        "-1001234567890": {
          requireMention: true,
          allowFrom: [123456789] // Per-group override (NOT groupAllowFrom)
        }
      }
    }
  }
}
```

**Key Configuration Fields**:
- `channels.telegram.groups`: Map of allowed group chat IDs (negative IDs for groups/supergroups)
- `groupPolicy`: `"open"` (any member) | `"allowlist"` (default, requires explicit IDs) | `"disabled"`
- `channels.telegram.groupAllowFrom`: Global numeric Telegram user IDs allowed in ALL groups (falls back to `allowFrom` if unset)
- `groups[chatId].allowFrom`: Per-group override of global `groupAllowFrom` for specific group

**Schema verified from**: https://docs.openclaw.ai/channels/telegram/access-control (accessed 2026-11-07)

**Access Control Semantics**:
- Group sender auth NEVER inherits DM pairing approvals (security boundary since 2026.2.25)
- `groupAllowFrom` entries MUST be numeric Telegram user IDs
- Non-numeric entries are ignored
- Group/supergroup chat IDs (negative values) belong under `channels.telegram.groups`, NOT `groupAllowFrom`

**Reference**: https://docs.openclaw.ai/channels/telegram/access-control

### Registry-to-Allowlist Sync Lifecycle (PROPOSED)

This section describes a robust sync lifecycle for maintaining OpenClaw's allowlist from the World ID enrollment registry.

**Source of Truth**: World ID enrollment registry (this application's database)

**Sync Operations**:

1. **Add**: New verified enrollment
   - Event: User completes World ID verification
   - Action: Add numeric Telegram user ID to `channels.telegram.groupAllowFrom`
   - Condition: Proof verified, not expired, not revoked

2. **Remove**: Expired or revoked enrollment
   - Event: Enrollment TTL expires OR nullifier revoked by World ID
   - Action: Remove numeric Telegram user ID from `channels.telegram.groupAllowFrom`
   - Condition: Enrollment no longer valid

3. **Renew**: User re-verifies before expiry
   - Event: User completes new World ID verification
   - Action: Update enrollment expiresAt timestamp, keep in allowlist
   - Condition: Same Telegram user ID, new valid proof

**Sync Modes**:

**Mode 1: Per-Request Ingress Enforcement with Lease Checks (RECOMMENDED)**
- Check enrollment validity (not expired, not revoked) at EVERY admission request
- Query registry for current enrollment status before admitting each message
- Reject if enrollment invalid or missing
- NO stale allowlist grants (always current)
- Higher query load on registry
- Exact expiry enforcement guarantee via enforced ingress deadline check

**Mode 2: Periodic Static Allowlist Sync (INSUFFICIENT FOR EXACT EXPIRY, NOT RECOMMENDED FOR REQUIRED GUARANTEES)**
- Sync registry → allowlist on schedule (e.g., every 5 minutes)
- Add verified enrollments, remove expired/revoked enrollments from allowlist
- **Between syncs: static allowlist has NO MECHANISM to stop stale authorized senders**
- A user who was valid at sync time but expires before next sync CAN STILL SEND (stale authorization)
- Short sync interval (e.g., 1 minute) reduces but NEVER eliminates staleness window
- Periodic sync alone CANNOT prove exact expiry enforcement
- **Requires additional enforcement**: Independent per-message lease/deadline check OR fail-closed channel disable/watchdog

**IMPORTANT**: Mode 2 static allowlist alone is UNSAFE for required expiry guarantees. Only enforced ingress deadline checks or independent fail-closed mechanisms can bound stale authorization.

**Sync Properties**:

- **Atomic**: All adds/removes in one transaction
- **Idempotent**: Re-running sync produces same allowlist state
- **Reviewable**: Log all sync operations (added IDs, removed IDs, timestamp)
- **Scoped**: Only modify `groupAllowFrom` entries, preserve other OpenClaw config
- **Fail-Closed**: On sync error, EITHER:
  - (A) Keep existing allowlist, reject new admissions until sync succeeds (safe but denies new users)
  - (B) Clear allowlist, reject all admissions until sync succeeds (safest, most disruptive)

**Fail-Closed Handling**:

When sync fails (registry unavailable, OpenClaw config write error, etc.):
- Log error with details
- Alert operator via monitoring system
- **Option A (static allowlist only)**: Keep existing allowlist, reject new additions
  - **DEFECT**: Has NO mechanism to stop stale authorized senders already in allowlist
  - Existing enrollments that expire during outage continue to have access
  - Writing config can fail, so clearing allowlist may also fail
  - Static periodic sync mode is UNSAFE for required expiry guarantees
- **Option B (fail-closed channel disable)**: Disable entire channel/gate until sync succeeds
  - Safest: NO stale grants
  - Most disruptive: ALL users (including valid) are blocked
- **Option C (per-request enforcement)**: Ingress checks continue querying registry directly
  - Requires Mode 1 architecture (not Mode 2 periodic sync)
  - Each admission queries registry for current enrollment status
  - Exact expiry enforcement maintained during sync outages

**Recommended**: Mode 1 (per-request) with independent fail-closed watchdog, OR Mode 2 with separate per-request lease/deadline checks to bound stale authorization.

**Manual Bypass Risk**: Manual entries added to allowlist outside the managed namespace/groups would bypass gate enforcement unless separated from managed policy or explicitly reserved.

**Limitations of Static Allowlist + Periodic Sync**:

- **Staleness Window**: Between syncs, allowlist may include expired enrollments or miss new enrollments
- **Not Real-Time**: Expiry enforcement delayed by sync interval
- **Requires Monitoring**: Sync failures must be detected and remediated quickly
- **Bounded Delay**: Staleness bounded by sync interval (e.g., max 5 minutes stale)

**Exact Expiry Enforcement Requires**:
- Per-request ingress check (Mode 1), OR
- Very short sync interval with fail-closed guarantees (Mode 2 with tight bounds)

**Current Starter Implementation**:
- In-memory enrollment store (testing only)
- NO automatic sync to OpenClaw config
- Operator must manually update OpenClaw `groupAllowFrom` from registry
- Placeholder for future durable store + sync implementation

### Accurate Assurance Language

**Correct Statement**:
> "This Telegram account completed human verification via World ID."

**Incorrect Statements** (DO NOT USE):
- "A human typed this message" (NO: account may be automated after verification)
- "This message came from a human" (NO: account ownership does not prove per-message authorship)
- "This user is trustworthy" (NO: verification only proves humanness, not intent or behavior)

**Key Points**:
- Verification proves the Telegram account was linked to a World ID proof
- Verification does NOT prove per-message human authorship
- Verified accounts can be automated (bots using verified account credentials)
- Verified accounts can be compromised (stolen credentials, session hijacking)
- Admission control is NOT authorization for sensitive operations

**Least Privilege Principle**:
- Admission grants basic bot interaction only
- Sensitive tool execution requires ADDITIONAL authorization checks
- Shell/filesystem access requires INDEPENDENT permission grant
- Approval/admin authority requires SEPARATE role-based access control (RBAC)

## Trust Boundaries

### Implemented Starter Boundaries

1. **Telegram Update Authentication** (UNIMPLEMENTED in starter, CRITICAL for production)
   - Starter accepts arbitrary JSON as TelegramUpdate
   - Production MUST use authenticated adapter (OpenClaw gateway, webhook with `secret_token`, or polling with bot token)
   - DO NOT accept arbitrary JSON from untrusted sources

2. **World ID Verification** (STUBBED in starter, REQUIRED for production)
   - Starter uses `WorldIdVerifierStub` for testing
   - Production MUST use `WorldIdVerifierProduction` with real HTTPS calls to World ID API
   - Endpoint: `POST https://developer.world.org/api/v4/verify/{rp_id}`
   - Staging endpoint: `POST https://staging-developer.worldcoin.org/api/v4/verify/{rp_id}`
   - Official source (retrieved 2026-11-06): OpenAPI servers at https://docs.world.org/api-reference/developer-portal/verify list Primary, Legacy domain, and Staging domain
   - Endpoints remain synthetic/unwired in this starter

3. **Enrollment Binding** (TEST-ONLY in starter, INSUFFICIENT for production)
   - Starter `enroll()` method accepts caller-supplied Telegram user ID
   - Production MUST use dual authentication (Telegram session + World ID proof with challenge)
   - Proof possession alone does NOT prove Telegram account ownership
   - See AGENTS.md for enrollment challenge protocol requirements

4. **Configuration Validation** (IMPLEMENTED in starter)
   - Constructor-level validation with bounded safety checks
   - Positive finite TTL within [60s, 1 year] bounds
   - Required HTTPS verify endpoint
   - Valid RP ID with `rp_` prefix
   - Non-empty action string

### Planned Production Boundaries

5. **Enrollment Link Binding** (PLANNED)
   - Short-lived single-use links with HMAC-signed `initData`
   - Telegram Mini App validates `initData` HMAC-SHA256 with bot token
   - Link bound to requesting Telegram user ID (not transferable)

6. **Registry-to-Allowlist Sync** (PLANNED)
   - Atomic, idempotent, fail-closed sync operations
   - Bounded staleness (for periodic mode) or real-time (for per-request mode)
   - Monitoring and alerting on sync failures

7. **Admission vs Authorization** (ARCHITECTURAL PRINCIPLE)
   - Admission: basic bot interaction (chat, read-only queries)
   - Authorization: sensitive operations (tool execution, shell access, approvals)
   - Admission does NOT confer authorization
   - Least privilege: grant minimum necessary permissions per operation

## World ID Protocol Requirements

### Onboarding Prerequisites

**Configuration Pending** (Bob must complete):
- Create one external World ID Developer app/RP from https://developer.world.org/
- Register production action identifier (e.g., "openclaw-admission")
- Obtain RP ID (format: `rp_*****`) for verification API calls

**End User Requirements**:
- Members only use World App (personal wallet app)
- NO developer account required for each member
- World App verification flow uses existing personal credentials

### Protocol Constraints

**v4 Uniqueness Proofs**:
- World ID v4 proofs are one-time per action
- Each proof can only be verified once for a given action
- Repeated verification for same user requires new proof generation

**Recurring Verification (Unresolved)**:
- v4 session-based recurring verification mechanism not yet integrated
- IDKit 4.4 session builder API for repeated checks pending protocol research
- Current implementation supports single-verification enrollment with configurable expiry
- Automatic 30-day renewal NOT implemented (requires session-proof integration)

**Mobile UX Considerations**:
- World App verification flow behavior in Telegram WebView not device-tested
- External browser flow is supported fallback (not categorically required)
- Deep link/bridge polling mechanism per World ID docs pending device verification
- Challenge session must support resumable flow (user may return later)

### Contract-Level Evidence Gaps

**Current Implementation**:
- ✅ Validates action/nonce/signal strings match expected server context
- ✅ Enforces proof_of_human credential requirement (issuer_schema_id: 1)
- ✅ Rejects ambiguous multi-response batches
- ✅ Strict boolean success check

**Unverified Cryptographic Assumptions**:
- Comparing top-level action/nonce strings alone does not establish full cryptographic binding
- Full protocol-level evidence requires understanding World ID's zk-SNARK proof structure
- Signal binding provides additional context-specific protection
- Cryptographic coverage analysis is out of scope for this implementation

**No "Complete Security" Claim**:
- Runtime validation at application layer is hardened
- Protocol-level cryptographic guarantees depend on World ID's proof verification
- Integration gaps remain (session renewal, mobile UX, RP onboarding)

### Implementation Boundaries and Limitations

**Implemented (Transactional Requester-Bound Completion)**:
- ✅ Single atomic transaction: challenge consume + enrollment create (both or neither)
- ✅ Authenticated requester validated against stored challenge before proof verification
- ✅ Invalid proof/account mismatch do not burn legitimate requester's challenge
- ✅ Signal binding prevents proof replay across accounts
- ✅ Per-action nullifier scoping (composite PK: nullifier + action)
- ✅ Shared database connection ensures transactional integrity

**Replay Protection Boundary**:
- Nullifier uniqueness enforced per-action via database constraint
- TTL cleanup drops expired enrollments (no permanent replay memory)
- Cannot claim "full replay lifecycle protection" - expired nullifiers can be reused
- No revocation audit log (revoked enrollments deleted, not archived)

**Cross-Account Policy (Explicit Unresolved)**:
- No silent global uniqueness enforcement across actions
- No cross-community nullifier deduplication
- User policy choice required: per-action isolation vs. global uniqueness
- Current implementation: explicit per-action scoping only

**Privacy/Retention Policy (Explicit Unresolved)**:
- No names, usernames, raw initData, or raw proofs stored
- Only nullifier (0x hex), Telegram user ID (numeric), action, timestamps
- No automatic data deletion beyond expiry cleanup
- User retention policy choice required before production

### Signal Binding Strategy (Implemented)

**Current Implementation** (`EnrollmentService`):
- Signal constructed as `"telegram:{userId}:{action}"`
- Hashed with SHA-256 to produce `signal_hash`
- Bound to specific Telegram user ID + action combination
- Prevents proof replay across different accounts
- Service computes expected signal_hash from stored challenge context
- World ID verification confirms signal_hash in proof matches expected value

**Signal Binding Contract**:
- Application constructs signal deterministically
- Client MUST provide same signal when generating proof
- World ID's proof verification confirms signal_hash cryptographic binding
- We rely on World ID's documented API contract: successful verification with matching signal_hash means proof is bound to that signal
- CAVEAT: We are not auditing zk-SNARK internals, but using documented API semantics

**Mandatory for Granting Path**:
- Signal binding is required for any enrollment completion
- `completeEnrollment()` always validates signal_hash match
- Mismatched signal fails verification without burning challenge

## Reject-Path Behavior

The admission gate rejects unauthorized senders BEFORE any agent processing.

**Necessary Transport Validation** (not LLM/history processing):
- HTTPS request parsing (required for webhook reception)
- JSON deserialization (required to extract user ID)
- Telegram Bot API field extraction (`message.from.id`)

**Rejected Requests DO NOT**:
- Make LLM model calls
- Read conversation history
- Write conversation history buffers
- Execute any agent tools (shell, filesystem, network, etc.)

**Distinction**: Transport validation is NOT conversation history processing or agent LLM inference.

## OpenClaw 2026.9.8 Compatibility

**Research Status**: NOT ESTABLISHED. OpenClaw 2026.9.8 specific verification NOT performed.

**Current documentation cited**: https://docs.openclaw.ai/channels/telegram/access-control (accessed 2026-11-07, version/date unspecified on page)

**Not verified against 2026.9.8 specifically**:
- No official 2026.9.8 release tag/commit link checked
- No 2026.9.8 source code inspection performed
- No installed 2026.9.8 instance available for testing
- Schema examples drawn from current live docs, not version-specific documentation

**To establish 2026.9.8 compatibility**, operators must:
- Locate OpenClaw 2026.9.8 official release notes / changelog / git tag
- Verify `channels.telegram.groups` schema in that version's docs or source
- Verify `groupPolicy`, `groupAllowFrom`, and per-group `allowFrom` semantics
- Test config changes with installed 2026.9.8 instance
- Verify config hot-reload behavior and group member list sync timing

**Current docs indicate** (version unspecified):
- `channels.telegram.groups` with negative chat IDs
- `groupPolicy: "allowlist"` with `groupAllowFrom` numeric user IDs
- Per-group `allowFrom` override
- Security boundary: group sender auth never inherits DM pairing approvals (since 2026.2.25)

**Illustrative config examples in this document are from current docs, not 2026.9.8 verified.**

## Configuration Reference

See `src/config.ts` for the central user-editable configuration module.

**Key Settings**:
- `rpId`: World ID relying party identifier (from https://developer.world.org/)
- `action`: Action string scoping proofs to this integration (default: `"openclaw-gate"`)
- `verifyEndpoint`: World ID verification API endpoint (production or staging)
- `requireProofOfHuman`: True for Orb biometric only, false to allow selfie (default: `true`)
- `enrollmentTtlSeconds`: Enrollment validity duration (default: `2592000` = 30 days)
- `allowTestMode`: Allow stub verifier (development only, NEVER production)

**Configuration Bounds**:
- Minimum TTL: 60 seconds (1 minute)
- Default TTL: 2592000 seconds (30 days)
- Maximum TTL: 31536000 seconds (1 year)

**Config Editing Semantics**:
- Changing `enrollmentTtlSeconds` affects NEW enrollments only
- Existing enrollments keep their original `expiresAt` timestamp
- Config changes do NOT retroactively extend or shorten existing enrollments

## Service Scope and Identity Boundaries

**Action-Scoped Uniqueness**:
- World ID nullifiers are scoped to relying party + action
- One enrollment per Telegram account per action
- **Multiple Telegram accounts per verified person ALLOWED**: Same nullifier can enroll multiple different Telegram accounts
- Different actions can enroll the same World ID with different nullifiers
- **NO cross-action uniqueness**: Same nullifier from different actions are DISTINCT identities
- Service does not and cannot enforce global uniqueness across actions or accounts

**Identity Binding**:
- Challenge creation authenticates Telegram `initData` (HMAC-SHA256 with bot token)
- Enrollment binds World ID nullifier to authenticated Telegram account (numeric user ID)
- Each account must complete its own fresh account-bound signed challenge and proof
- Requester cannot forge another account's enrollment (challenge scoped to requester)
- Cannot transfer old grants or proofs between accounts

**Data Retention**:
- Challenge sessions: Short-lived (5 minutes default), auto-expire
- Enrollments: Configurable TTL (30 days per account default), soft-expire (no auto-delete)
- Revocations: Persisted indefinitely with generation timestamps
- Replay prevention: Transactional challenge consumption enforced

**Revocation Semantics** (per-account lifecycle):
- Sets `revoked = 1` flag on enrollment record (no destructive deletion)
- Blocks pre-revocation challenges from completing (generation comparison)
- Allows post-revocation fresh challenges to restore that account
- Revoked accounts can regain access via fresh post-revoke verification (no admin prerequisite)
- Revocation of one account does NOT revoke other accounts with same nullifier
- Revoked enrollments remain queryable for audit

## Testing Strategy

**Test Coverage** (247 tests, 0 skipped):
- **Unit Tests** (228 tests):
  * Fail-closed admission checks (unknown, revoked, expired users)
  * Configuration validation (bounds, required fields)
  * Action-model gap validation (proof action mismatch)
  * Enrollment lifecycle (creation, expiry, per-account revocation)
  * Trust boundary checks (malformed inputs, zero user ID)
  * Deterministic expiry with clock injection (no timeouts)
  * HTTP verifier strict contract validation
  * Cross-connection race conditions
  * Multiple accounts per nullifier (same verified person, different Telegram accounts)
  * Per-account revocation lifecycle (generation comparison)
  * Post-revocation restoration via fresh verification

- **Integration Tests** (19 tests):
  * HTTP service startup/shutdown on ephemeral localhost
  * Challenge creation with Telegram auth
  * Enrollment completion with mocked World API
  * Malformed input rejection (JSON, missing fields, invalid auth)
  * Generic error responses (no identity leaks)

**Clock Abstraction**:
- `FakeClock` for deterministic time-based testing
- Instant time advance (no `setTimeout` delays)
- Exact-boundary expiry tests (admission at TTL-1, rejection at TTL+1)

## Runnable Service

**Production Entrypoint**: `src/server.ts`
- Localhost HTTP service on `127.0.0.1:3000` (configurable)
- SQLite enrollment database (WAL mode)
- SDK-based challenge adapter with ECDSA signing
- HTTP verification client for World ID Developer Portal
- Graceful shutdown on SIGINT/SIGTERM

**Start Commands**:
```bash
# Development (with tsx)
npm run start:dev

# Production (requires build first)
npm run build
npm start
```

**Configuration** (environment variables):
- `WORLDID_APP_ID`: World ID application identifier (required)
- `WORLDID_RP_ID`: Relying party identifier (required)
- `WORLDID_SIGNING_KEY_HEX`: ECDSA private key for challenge signing (required)
- `TELEGRAM_BOT_TOKEN`: Telegram bot token for initData validation (required)
- `WORLDID_ACTION`: Action string (default: `unconfigured-test-action`)
- `WORLDID_ENVIRONMENT`: `production` or `staging` (default: `staging`)
- `DATABASE_PATH`: SQLite database path (default: `/tmp/enrollment.db`)
- `HTTP_HOST`: Bind address (default: `127.0.0.1`)
- `HTTP_PORT`: Bind port (default: `3000`)

**Readiness Check**:
```bash
curl http://127.0.0.1:3000/health
```

**Production Readiness Status**:
- ✅ Runnable HTTP service with ephemeral localhost testing
- ✅ SDK-aligned challenge adapter (Keccak256 field reduction, ECDSA EIP-191 signatures)
- ✅ Strict verification client (server-trusted context, single response item)
- ✅ Durable SQLite schema with migrations, WAL mode, revocation
- ✅ Deterministic expiry testing with clock injection
- ✅ Body limits (1MB), timeouts (30s), generic error responses
- ✅ Constructor-level config validation with bounds checks
- ⚠️  NOT verified: renewal flow, mobile SDK integration, live World API contract
- ⚠️  NOT verified: production hosting, HTTPS, rate limiting, monitoring

## OpenClaw Pre-History Ingress Gate Integration (UNAPPROVED DESIGN)

This section documents UNRESOLVED integration requirements for World ID verification as an OpenClaw pre-history authorization gate. **Bob has NOT approved any upstream OpenClaw modifications.**

### Verified OpenClaw Source Analysis

**Repository**: https://github.com/openclaw/openclaw  
**Commit**: `fc23bc864e4553c2d215e479eeec47b67a0bf943`  
**Verification**: Commit SHA verified in local clone at `/tmp/openclaw-legacy`

**Key Landmarks Verified**:
- Line 155: First middleware `bot.use(updateTracker.beginUpdate)`
- Line 212: Poll preparation middleware (registry read for `poll_answer` routing)
- Line 239: Logging middleware
- Line 370: Handler registration `handlers.register(nativeCommandCallbackDispatcher)`

### Unresolved Integration Scope

**UNAPPROVED Candidate Injection Point**: After line 117 (`bot.api.config.use(accountThrottler.transformer)`)

**Known Limitations of Proposed Placement**:
- Poll preparation middleware at line 212 runs AFTER proposed gate at line ~120
- Poll registry schema contains content fields (`question`, `options`) not just routing metadata
- Content-free poll classification policy NOT YET ESTABLISHED

### Unresolved Technical Requirements

**UNAPPROVED upstream modifications required** (Bob has NOT approved):
1. OpenClaw middleware injection mechanism (supported integration mechanism not established by this investigation)
2. Human actor extraction across all update types
3. Protected group scope configuration interface
4. Fresh authorization recheck for queued/debounced updates

**UNRESOLVED seam locations**:
- Exact insertion point for fresh recheck AFTER debounce flush (not yet traced)
- Exact insertion point for fresh recheck AFTER media album buffer (not yet traced)
- Callback query authorization already exists separately (not unified with proposed gate)
- Native command authorization already exists separately (not unified with proposed gate)

### Human Identity Rules

**Authenticated Numeric Human Identity ONLY**:
- `from.id` field (numeric Telegram user ID)
- `from.is_bot === false` (NOT a bot account)
- NOT `sender_chat` (channel/group as actor)
- NOT `actor_chat` (anonymous admin)
- NOT missing actor (updates without `from` field)

**Non-Human Actors MUST Be Rejected in Protected Groups**:
- `sender_chat` (channel posts, forwarded with channel attribution)
- `actor_chat` (anonymous group admin actions)
- `is_bot: true` (bot accounts)
- Missing `from` field (malformed or administrative updates)

### Authorization Boundary Definition

**Ingress Gate (Proposed Line ~120)**:
- Runs BEFORE all history writes
- Runs BEFORE session/cache reads
- Runs BEFORE model/tool invocation
- Runs BEFORE native command dispatch

**First Prohibited Effects Per Update Type**:

| Update Type | First Prohibited Effect | Source Line |
|-------------|------------------------|-------------|
| Regular Messages | `recordMessageForReplyChain` | [bot-handlers.inbound-pipeline.ts:223](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-handlers.inbound-pipeline.ts#L223) |
| Edited Messages | `recordMessageForReplyChain` | [bot-handlers.inbound-pipeline.ts:150](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-handlers.inbound-pipeline.ts#L150) |
| Reactions | `enqueueRoutedSystemEvent` | [bot-handlers.event-bindings.ts:291](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-handlers.event-bindings.ts#L291) |
| Poll Answers | `processMessageWithReplyChain` | [bot-handlers.event-bindings.ts:418](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-handlers.event-bindings.ts#L418) |
| Callbacks | Varies (approval/question/model) | [bot-handlers.callback-router.ts](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-handlers.callback-router.ts) |
| Native Commands | Command execution | [bot-native-commands.ts:256](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-native-commands.ts#L256) |

**Pre-Authorization Reads (Metadata-Only)**:

| Update Type | Pre-Auth Read | Purpose | Classification |
|-------------|---------------|---------|----------------|
| Edited Messages | `getChat()` API call | Forum flag resolution | Metadata (cached 5min) |
| Callbacks | `getChat()` API call | Forum flag resolution | Metadata (cached 5min) |
| Reactions | Message cache lookup | Thread recovery | Metadata (cache miss = silent drop) |
| Poll Answers | Poll registry lookup | Chat/thread routing | **CONTENT READ** (see below) |

### Poll Registry Content Read Issue

**Problem**: Poll registry schema contains content fields (`question`, `options`), not just routing metadata. Content-free poll classification policy NOT YET ESTABLISHED.

**Poll Registry Schema** ([poll-registry.ts:20-27](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/poll-registry.ts#L20-L27)):
```typescript
export type TelegramPollRegistryEntry = {
  pollId: string;
  chat: TelegramPollRouteChat;
  messageId: number;
  threadSpec: { scope: "none" | "dm" | "forum"; id?: number };
  question: string;      // ← CONTENT
  options: string[];     // ← CONTENT
};
```

**Analysis**: Registry contains poll `question` and `options` (content), not just routing metadata.

**Two Policy Options**:

#### Option A: Content-Free Poll Routing Index (RECOMMENDED)

**Change registry schema to metadata-only**:
```typescript
export type TelegramPollRegistryEntry = {
  pollId: string;
  chat: { id: number; type: string };  // Routing only
  threadSpec: { scope: "none" | "dm" | "forum"; id?: number };
  // question and options REMOVED from index
};
```

**Workflow**:
1. Poll send: Record only `pollId → {chat, threadSpec}` mapping
2. Poll answer: Resolve chat/thread from registry (metadata-only)
3. Authorization gate: Check sender against protected group IDs
4. Post-authorization: Retrieve full poll details from original message if needed

**Tradeoff**: Requires additional message lookup post-authorization if poll content needed for processing.

**Impact**: No unrelated-group content leakage; unknown poll IDs default-deny in protected groups.

#### Option B: Deny Unknown Polls in Protected Groups

**Keep existing registry with content**, but:
- Protected groups MUST have poll send tracking enabled
- Poll answers with missing registry entry are rejected (already implemented at [line 340](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-handlers.event-bindings.ts#L340))
- Only polls sent by verified actors are added to registry
- Unknown poll IDs in protected groups → rejection before authorization

**Tradeoff**: Poll registry reads content before authorization, but only for polls previously sent by authorized actors.

**Impact**: Minimal if poll sends are tracked correctly; potential content leak if registry populated by unauthorized actors.

**Recommendation**: **Option A (Content-Free Index)** provides cleaner security boundary. Implement in separate PR after ingress gate approval.

### Unresolved Scope Requirements

**Protected vs Out-of-Scope Groups**:
- Protected groups require explicit numeric chat ID configuration
- Out-of-scope groups must preserve existing behavior (pass-through)
- Bot maintenance updates (`my_chat_member`, `message:migrate_to_chat_id`) require special handling
- DM policy (enforce verification or allow) NOT YET ESTABLISHED

**UNRESOLVED**: Missing chat ID extraction for updates without direct chat field (e.g., poll_answer requires registry lookup)

### Concurrency and Linearization

**Grammy Sequentializer** ([line 228](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-core.ts#L228)):
- Serializes updates per chat+thread combination
- Runs AFTER proposed gate (line ~120 vs line 228)
- Provides ordering within same conversation

**TOCTOU Window**:
- Proposed gate is async (allows World ID registry queries)
- Config/registry can change between authorization and history write
- Sequentializer mitigates per-chat races but NOT cross-chat or hot-reload

**Admitted Already-Running Work**:
- Updates that pass gate and enter history/model phase CANNOT be retroactively cancelled
- Registry revocation affects NEW admission attempts, not in-flight processing
- In-flight work continues until completion even if actor revoked mid-processing

**Concurrent Scenarios Requiring Testing**:
- Actor revoked while update queued in sequentializer
- Enrollment expires between gate check and history write
- Multiple updates from same actor processed concurrently in different chats
- Registry timeout during gate check

### Test Matrix

**Required Test Coverage**:

| Dimension | Test Cases |
|-----------|------------|
| **Scope** | Protected group, out-of-scope group, DM |
| **Actor Type** | Human (`from.id`), bot (`is_bot=true`), channel (`sender_chat`), anonymous, missing |
| **Update Type** | Message, edited, callback, reaction, poll_answer, native command, unsupported (e.g., `inline_query`) |
| **Verification State** | Valid, expired, revoked, not enrolled, timeout/outage |
| **Timing** | Revoke while queued, expire between gate and history, concurrent same-actor updates |
| **Content** | Media album mixing verified/unverified senders, callbacks, direct dispatch |
| **Scope Edge Cases** | Unknown poll in protected group, routing index absent/corrupt, unrelated group poll |

**Critical Assertions**:
- Protected group + human + valid → history written, model called
- Protected group + human + expired → zero history/model/tools
- Protected group + human + revoked → zero history/model/tools
- Protected group + channel actor → zero history/model/tools
- Protected group + missing actor → zero history/model/tools
- Out-of-scope group + any actor → pass-through (existing behavior)
- Verification timeout → fail-closed (denied)
- Unknown scope (missing routing data) → denied in protected groups

### Unresolved Fail-Closed Requirements

**Expiry Enforcement** (mechanism NOT YET ESTABLISHED):
- Per-request deadline check at ingress gate (proposed, not verified)
- Fresh recheck for queued/debounced updates (seam location NOT YET TRACED)
- Exact boundary enforcement (`now >= expiresAt`) requires clock consistency

**Revocation Enforcement** (timing NOT YET ESTABLISHED):
- Local registry revocation is authoritative
- Revocation timing depends on recheck frequency (NOT YET DEFINED)
- In-flight admitted work CANNOT be retroactively cancelled
- Queued updates may complete with stale authorization if no fresh recheck

**Outage Handling** (REQUIRED: fail-closed, unimplemented):
- Registry timeout → MUST deny admission (retries MUST NOT permit content/history/model/tools while authorization uncertain)
- Registry unavailable → MUST deny admission
- Invalid/corrupt registry response → MUST deny admission

**No Stale Positive Grants** (NOT YET PROVEN):
- Requires fresh registry query at EVERY decision point
- Debounce/buffer/queue recheck seams NOT YET TRACED
- Callback/native command separate authorization paths NOT YET UNIFIED

### Unresolved Deployment Requirements

**Configuration Mechanism** (NOT YET ESTABLISHED):
- OpenClaw plugin/middleware registration mechanism (supported integration mechanism not established by this investigation)
- Protected group numeric chat ID configuration format NOT DEFINED
- Registry connection interface NOT DEFINED
- Fresh recheck trigger points NOT TRACED

**Integration Prerequisites** (UNRESOLVED):
- Bob approval for upstream OpenClaw modifications
- Content-free poll classification policy decision
- Fresh recheck seam locations identified and verified
- Unified authorization across all update paths (messages, callbacks, commands)

### Operator Plan

**Public Verification HTTPS Endpoint**:
- Mac mini backend exposes enrollment service
- Telegram Mini App requires valid TLS certificate
- Provider options: Cloudflare Tunnel (recommended), ngrok, or custom domain + Caddy/nginx

**Private OpenClaw Instance**:
- Main bot remains private (no public exposure)
- Verification service communicates with registry via local connection
- OpenClaw queries registry directly via gate hook (no separate sync process)

**Supervision and Monitoring**:
- Registry query latency/timeout alerts
- Admission denial rate monitoring
- Enrollment creation/expiry tracking
- Revocation event logging

**Rollback and Recovery**:

**UNSAFE Practice** (documented for awareness):
- Restoring old database backup CAN resurrect revoked enrollments
- Backup restoration does NOT preserve post-backup revocations
- Separate revocation table in SAME restored database is NOT independent protection

**SAFE Rollback Options**:

1. **Protected Admissions Remain Fail-Closed During Uncertain Restore**:
   - Keep gate active with deny-all for protected groups
   - Out-of-scope groups continue unchanged
   - NEVER disable gate or bypass protected admission enforcement
   - Manually verify trustworthy revocation state before allowing admissions
   - Apply fresh post-revoke enrollment policy (require new challenge + proof)

2. **Immutable Revocation Log**:
   - Separate append-only revocation store outside main DB
   - Check revocations independently after DB restore
   - Requires separate log implementation (not yet built)

3. **Local Revocation History is Authoritative**:
   - World ID proof verification API CANNOT recover local revocation history
   - World API verifies proof validity, NOT enrollment revocation status
   - Local registry maintains revocation lifecycle independently
   - Post-restore verification queries World API for proof validity, NOT revocation status

**Retention Policy** (Not Yet Selected):
- Options: Retain expired/revoked indefinitely, 90-day retention, explicit deletion after X days
- Policy choice required before production
- Current implementation: soft-expire (no auto-delete)

### Unresolved Decisions

1. **Poll Registry Content Read**: Option A (content-free index) vs Option B (deny unknown) - requires Bob's decision
2. **Native Command Path**: Apply same gate or separate authorization? Current separate authorization path NOT YET UNIFIED
3. **Retention Policy**: How long to retain expired/revoked enrollments? (indefinite / 90-day / explicit deletion)
4. **HTTPS Provider Selection**: Cloudflare Tunnel / ngrok / custom domain (not yet provisioned)
5. **Fresh Recheck Seam Locations**: Exact insertion points for queued/debounced update rechecks NOT YET TRACED

### Settled Policies (NOT reopened for Bob decision)

1. **Multiple Accounts Per Nullifier**: ALLOWED - same verified human may enroll multiple Telegram accounts, each requires fresh authenticated proof per account
2. **Post-Revocation Restoration**: ALLOWED - revoked accounts may restore via fresh post-revoke challenge + proof; pre-revoke challenges CANNOT restore
3. **Default TTL**: 30 days (2592000 seconds), bounded [60s, 31536000s]
4. **TTL Configuration Changes**: Do NOT retroactively alter stored `expiresAt` timestamps; apply to NEW enrollments only

### Evidence vs Assumptions

**Verified Evidence**:
- ✅ OpenClaw commit fc23bc864e4553c2d215e479eeec47b67a0bf943 checked out and inspected
- ✅ Middleware registration order verified (lines 155, 198, 212, 228, 239)
- ✅ First history write at line 223 (`recordMessageForReplyChain`)
- ✅ Poll registry schema includes content fields (question, options)
- ✅ Human actor extraction patterns verified per update type
- ✅ Native commands use separate authorization path (not `authorizeInboundMessage`)
- ✅ Grammy sequentializer provides per-chat ordering

**Assumptions Requiring Verification**:
- ⚠ Grammy middleware-first execution order (documented grammy behavior, not source-inspected)
- ⚠ Complete unsupported update type enumeration (requires Telegram Bot API spec + grammy source audit)
- ⚠ OpenClaw compatibility with external middleware injection (requires OpenClaw maintainer confirmation)

### Implementation Approval Required

**This is a DESIGN SPECIFICATION pending Bob's approval for:**
1. Modifying OpenClaw upstream source files (bot-core.ts, bot.types.ts)
2. Creating new utility file (bot-human-actor.ts)
3. Testing OpenClaw integration with external gate hook
4. Selecting poll registry content read policy (Option A or B)
5. Defining retention and rollback policies

**NO code changes to OpenClaw source are authorized until Bob approves this design.**

## Existing Components (Built and Tested at Commit 040e904)

**Offline Components Implemented**:
- ✅ Telegram bot handler with `/verify`, `/status`, `/help`, `/start` commands
- ✅ Telegram Mini App enrollment UI with World ID IDKit SDK integration
- ✅ World ID HTTP verification client (production and staging endpoints)
- ✅ SQLite enrollment store (durable, transactional, with revocation lifecycle)
- ✅ Challenge session management with requester binding
- ✅ Local HTTP service (enrollment API endpoints)

**Test Coverage**: 354 unit tests + 3 browser tests passing at commit 040e904

**NOT Tested** (require live integration):
- Real Telegram webhook/polling with authentic update signatures
- Real World App proof generation on device
- Live World ID Developer Portal API calls
- Public HTTPS hosting with valid TLS certificate

## Remaining Integration Requirements

1. **Obtain Bob's Approval for OpenClaw Ingress Gate Design**
   - Review UNAPPROVED integration approach
   - Decide poll registry content read policy (Option A vs B)
   - Approve upstream OpenClaw modification scope
   - Define fresh recheck seam locations for queued/debounced updates

2. **Select and Provision HTTPS Provider** (NOT YET SELECTED)
   - Options: Cloudflare Tunnel / ngrok / custom domain
   - Provision public HTTPS endpoint for Telegram Mini App
   - Configure TLS certificate

3. **OpenClaw Ingress Gate Integration** (AFTER Bob approval)
   - Trace exact fresh recheck insertion points for debounce/buffer
   - Implement human actor extraction utility
   - Unify authorization across message/callback/command paths
   - Add comprehensive test coverage per test matrix

4. **Member Tag Management** (OPTIONAL)
   - `setChatMemberTag` integration
   - Tag application on enrollment
   - Tag removal on expiry/revocation
   - Error handling for permission/API failures

5. **Operational Readiness**
   - Select retention policy (indefinite / 90-day / explicit deletion)
   - Define registry timeout/outage behavior
   - Deployment runbook (see `OPERATOR_GUIDE.md`)
   - Monitoring dashboards and alerting rules
   - Backup and recovery procedures with fail-closed guarantees
