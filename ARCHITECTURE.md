
# Architecture: World ID Gated OpenClaw

This document describes the INITIAL small-group architecture for World ID-based human verification admission control on OpenClaw Telegram bots.

## Implementation Status

**IMPLEMENTED Production Components** (commit 554a982):
- ✅ Production Telegram Mini App `initData` backend validator (`src/telegram-initdata.ts`)
  - HMAC-SHA256 validation per official Telegram algorithm
  - Freshness check (auth_date within configurable window)
  - Secure user extraction from validated initData
  - 11 comprehensive unit tests
- ✅ Production World ID v4.0 proof verification client (`src/worldid-client.ts`)
  - Server-side proof verification against Developer Portal API
  - Environment validation (production/staging)
  - HTTPS-only endpoint enforcement
  - Timeout and error handling
  - 8 comprehensive unit tests
- ✅ Production enrollment store abstraction (`src/enrollment-store.ts`)
  - Challenge session interface for single-use nonce binding
  - Enrollment interface with transactional semantics
  - In-memory implementation for development (NOT for production)
  - 25 comprehensive unit tests
- ✅ Fail-closed admission gate with enrollment registry (`src/admission-gate.ts`)
  - Zero LLM/history/tool calls for rejected senders
  - Deterministic clock injection for testing
  - Action-scoping validation
  - 44 unit tests proving fail-closed guarantees
- ✅ Constructor-level configuration validation with bounded safety checks

**NOT YET IMPLEMENTED (require integration/configuration):**
- ❌ Verification service HTTP server/API endpoints
- ❌ Challenge session management workflow
- ❌ Telegram Mini App frontend (HTML/JS/CSS)
- ❌ Member tag management via `setChatMemberTag`
- ❌ OpenClaw group allowlist integration
- ❌ Registry-to-allowlist sync lifecycle
- ❌ Durable production store (PostgreSQL/SQLite replacing in-memory)
- ❌ Mac mini deployment supervision/monitoring

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

## Testing Strategy

**Unit Tests** (46 tests):
- Fail-closed admission checks (unknown, revoked, expired users)
- Configuration validation (bounds, required fields)
- Action-model gap validation (proof action mismatch)
- Enrollment lifecycle (creation, expiry, revocation)
- Trust boundary checks (malformed inputs, zero user ID)

**Integration Tests** (20 tests):
- End-to-end admission + processing flow
- Store error handling
- Orchestrator-level message routing
- Negative control matrix (revoked, expired, malformed, store errors)

**Clock Abstraction**:
- `FakeClock` for deterministic time-based testing
- Instant time advance (no `setTimeout` delays)
- Exact-boundary expiry tests (admission at TTL-1, rejection at TTL+1)

## Next Steps for Production

1. **Implement Separate Verification Bot**
   - Create dedicated bot with DM `/verify` command
   - Generate short-lived enrollment links
   - Bind links to requesting Telegram user ID

2. **Implement Telegram Mini App**
   - Build enrollment UI with World ID IDKit integration
   - Validate `initData` HMAC-SHA256 with bot token
   - Submit proof to backend for validation

3. **Implement Production World ID Verifier**
   - Real HTTPS client for World ID API
   - Error handling, retries, timeouts
   - Nullifier caching to prevent replay

4. **Implement Durable Enrollment Store**
   - PostgreSQL, Redis, or other persistent storage
   - Indexed queries on Telegram user ID and nullifier
   - Atomic operations for enrollment CRUD

5. **Implement Registry-to-Allowlist Sync**
   - Choose sync mode (per-request or periodic)
   - Implement atomic OpenClaw config updates
   - Add monitoring and alerting for sync failures
   - Document fail-closed behavior and staleness bounds

6. **Implement Member Tag Management**
   - `setChatMemberTag` integration
   - Tag application on enrollment
   - Tag removal on expiry/revocation
   - Error handling for permission/API failures

7. **Security Hardening**
   - Authenticated Telegram update adapter (OpenClaw gateway or webhook validation)
   - Enrollment challenge protocol (dual authentication)
   - Rate limiting on verification attempts
   - Monitoring and alerting for suspicious activity

8. **Operational Readiness**
   - Deployment runbook (see `OPERATOR_GUIDE.md`)
   - Monitoring dashboards (enrollment rate, admission rate, expiry rate)
   - Alerting rules (sync failures, verification errors, high rejection rate)
   - Backup and recovery procedures for enrollment database
