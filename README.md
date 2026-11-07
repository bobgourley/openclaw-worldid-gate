# openclaw-worldid-gate

World ID-gated Telegram bot admission control for OpenClaw. A deterministic, fail-closed starter that enforces proof-of-humanity verification before any LLM processing, conversation history access, or tool execution.

## Status: Test-Only Starter

**This is a bounded, reviewable starter for testing and development.** It is NOT production-ready.

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Complete system architecture, small-group design, trust boundaries, and production roadmap
- **[OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md)** - Setup instructions, configuration reference, testing procedures, and troubleshooting
- **[AGENTS.md](./AGENTS.md)** - Security boundaries, trust assumptions, and production requirements
- **[AUDIT.md](./AUDIT.md)** - Initial code audit and safety verification
- **[FINAL-AUDIT.md](./FINAL-AUDIT.md)** - Comprehensive security audit and integration contracts

## What This Does

This admission gate sits between Telegram updates and your OpenClaw agent:

1. **Receives** a Telegram update (user message)
2. **Checks** if the sender has a valid World ID enrollment
3. **Rejects** unknown/unverified senders BEFORE any downstream processing
4. **Admits** verified users to the OpenClaw agent

**Rejection triggers ZERO downstream operations:**
- No LLM model calls
- No conversation history reads or writes
- No tool executions

## World ID Credential Types

World ID 4.0 provides multiple credential types with different assurance levels:

### Proof of Human (identifier: "proof_of_human")

The highest assurance credential (issuer_schema_id: 1). Requires in-person verification at an Orb device:
- User scans their iris at a physical Orb
- Cryptographic proof generated that user is unique human
- Three-year validity period from issuance
- Default credential required by this gate (configurable)

**Assurance:** Highest. Biometric verification with liveness detection.

**Source:** https://docs.world.org/world-id/credentials/1

### Proof of Presence (identifier: "selfie")

Medium-assurance credential (issuer_schema_id: 11) using device camera:
- User takes selfie in World App
- Face matching with liveness detection
- Includes `sybil_score` risk signal (0-10, higher = more suspicious)
- Faster enrollment, lower friction

**Assurance:** Medium. Camera-based biometric credential.

**Note:** Selfie Check is NOT enabled by default in this gate. Set `requireProofOfHuman: false` to accept both credential types.

**Source:** https://docs.world.org/world-id/credentials/11

### Legacy World ID 3.0 Identifiers

World ID 3.0 used different identifier names ("orb", "face"). This starter targets World ID 4.0 only. Legacy v3 proofs are not supported.

**Reference:** https://docs.world.org/world-id/4-0-migration

## Server-Side Verification

This gate performs server-side proof verification against the World ID API:

```
POST https://developer.world.org/api/v4/verify/{rp_id}
Content-Type: application/json

{
  "protocol_version": "4.0",
  "nonce": "0xabc123",
  "action": "openclaw-gate-test",
  "responses": [{
    "identifier": "proof_of_human",
    "issuer_schema_id": 1,
    "nullifier": "0x...",
    "expires_at_min": 49012345,
    "proof": ["0x111", "0x222", "0x333", "0x444", "0x555"]
  }]
}
```

**200 response = at least one proof verified successfully**

The gate validates:
- Protocol version (4.0 required)
- Proof cryptographic validity
- Nullifier uniqueness (one-time use per action)
- Credential type (proof_of_human required by default)
- Proof expiration (expires_at_min)
- Environment match (production expected)

**Reference:** https://docs.world.org/api-reference/developer-portal/verify

## App ID vs RP ID

World ID uses **RP ID** (Relying Party ID) for new apps:
- Format: `rp_...`
- Preferred in World ID 4.0
- Created in Developer Portal

Legacy **App ID** (`app_...`) is still accepted for backward compatibility.

## Action String

The `action` parameter scopes the proof to a specific use case:
- Each proof is bound to an action string
- Nullifiers are unique per (user, action) pair
- Prevents proof reuse across different applications
- Example: `openclaw-gate-production`

**Important:** Action string must match between enrollment and admission check.

## Environment (Production vs Staging)

World ID supports multiple environments:
- `production` - Real Orb verifications
- `staging` - Test environment
- `sandbox` - Local development

**This gate defaults to `production`.** Always verify the environment matches your expected deployment.

## Proof Freshness and Replay Protection

### Credential Validity Period

Proof of Human credentials have a three-year validity period from issuance:
- `genesis_issued_at` - Unix timestamp of first PoH credential (constant)
- `expires_at` - Unix timestamp when credential expires (renewed on refresh)
- Credentials can be renewed while Orb capture is deemed fresh

**Source:** https://docs.world.org/world-id/credentials/1

### expires_at_min in Proofs

Each proof response contains `expires_at_min` (Unix timestamp):
- Minimum expiration time for the proof
- Enforced during server-side verification
- Derived from the credential's validity period

### Enrollment TTL

Enrollments have a separate time-to-live (default 30 days for testing):
- Configurable via `enrollmentTtlSeconds`
- Independent of proof expiration
- Policy decision awaiting approval

**UNIMPLEMENTED:** Automatic re-verification when enrollment expires.

### Nullifier Uniqueness (Uniqueness Proofs)

For uniqueness proofs (one-time actions):
- Nullifier is unique per (user, RP, action) combination
- Same user + same RP + same action = same nullifier
- Prevents proof replay for that action
- Enforced by World ID verification API

**Source:** https://docs.world.org/world-id/concepts

**Session Proofs (NOT IMPLEMENTED):**
- `session_id` - Stable identifier across multiple requests
- `session_nullifier` - Per-proof replay protection
- Allows returning user verification
- See: https://docs.world.org/world-id/idkit/session-proofs

**UNIMPLEMENTED:** Persistent nullifier tracking across restarts (in-memory only).

## Session Proofs (Not Implemented)

World ID 4.0 supports session proofs for returning users:
- `session_id` - stable identifier across multiple requests
- `session_nullifier` - per-proof replay protection
- Allows multiple verifications of the same user

**This starter implements uniqueness proofs (one-time enrollment) only.**

**Reference:** https://docs.world.org/world-id/4-0-migration

## Revocation and Replay Handling

### Revocation

Enrollments can be revoked:
- `enrollmentStore.revoke(telegramUserId)` marks enrollment as revoked
- Revoked users are rejected at admission check
- Revocation persists until enrollment is deleted

**UNIMPLEMENTED:** Integration with World ID revocation events.

### Replay Protection

Current implementation:
- In-memory nullifier uniqueness check
- One enrollment per Telegram user ID
- One enrollment per World ID nullifier

**Production requires:**
- Durable nullifier storage
- Database-level unique constraints
- Transaction isolation for concurrent checks

## Telegram Identity Binding

### What is Authenticated

This gate uses ONLY the numeric Telegram user ID:
- Immutable identifier
- Assigned by Telegram
- Cannot be changed by user

### What is NOT Authenticated

- **Username** - Mutable, can be changed or removed
- **Display name** - Untrusted user input
- **Forwarded message author** - Not the sender
- **Quoted message author** - Not the sender

### Enrollment Challenge (UNIMPLEMENTED)

The starter does NOT implement the enrollment flow. Production requires:

1. User initiates enrollment (e.g., sends `/enroll` to bot)
2. Bot generates enrollment link with nonce
3. User opens link, authenticates with World ID
4. User returns to Telegram (deep link or manual confirmation)
5. Backend binds authenticated Telegram user ID to World ID proof
6. Enrollment complete

**Security boundary:** Synthetic test updates are NOT authenticated. Production must integrate with OpenClaw gateway receiving real Telegram bot API updates.

## Configuration

Example configuration (test-only):

```typescript
import { AdmissionGate } from './src/admission-gate.js';
import { WorldIdVerifierStub } from './src/verifier-stub.js';
import { InMemoryEnrollmentStore } from './src/enrollment-store.js';

const config = {
  rpId: 'rp_YOUR_RP_ID_HERE',
  action: 'openclaw-gate-production',
  verifyEndpoint: 'https://developer.world.org/api/v4/verify',
  requireProofOfHuman: true,
  enrollmentTtlSeconds: 86400 * 30, // 30 days
  allowTestMode: false, // Set to true only for testing
};

// TEST-ONLY: Use stub verifier
const verifier = new WorldIdVerifierStub();
const store = new InMemoryEnrollmentStore();
const gate = new AdmissionGate(config, verifier, store);

// Check admission
const result = await gate.checkAdmission({
  telegramUpdate: update,
  timestamp: Date.now(),
});

if (!result.allowed) {
  console.log('Rejected:', result.reason);
  // NO downstream processing
  return;
}

// Proceed to agent processing
```

**Do NOT commit real credentials or RP IDs.**

## Installation

```bash
npm install
```

## Usage

### Run Tests

```bash
npm test
```

### Type Check

```bash
npm typecheck
```

### Build

```bash
npm run build
```

## Test Results

The test suite proves that rejected senders cause:
- ZERO LLM calls
- ZERO conversation history reads/writes
- ZERO tool executions

Run `npm test` to verify these guarantees.

## OpenClaw Integration Status

**UNKNOWN:** OpenClaw integration is not implemented or verified. The exact hook points for admission gates in OpenClaw 2026.9.8 (fc23bc8) are unknown.

**Official OpenClaw Documentation:**
- Main docs: https://docs.openclaw.ai/
- Telegram setup: https://docs.openclaw.ai/channels/telegram/setup
- Access control: https://docs.openclaw.ai/channels/telegram/access-control

**Integration Requirements (from official docs):**
- OpenClaw Gateway receives authenticated Telegram Bot API updates
- Channel configuration via `channels.telegram` in `~/.openclaw/openclaw.json`
- Access control via `dmPolicy` and `allowFrom` settings
- Bot token configuration via CLI or config file

**UNKNOWN Integration Points:**
- Where to inject admission gate in OpenClaw message processing pipeline
- How to access raw authenticated updates before agent processing
- Whether OpenClaw provides pre-agent hooks or middleware
- How to prevent downstream calls on rejection

**No official OpenClaw API for admission gates was found in the documentation.**

**Community Examples (NOT official sources):**
- https://github.com/BigDawg013/openclaw-setup (community setup guide)
- https://github.com/guglielmofonda/mac-mini-openclaw-guide (community Mac mini guide)

These community guides show OpenClaw usage but do not document admission gate APIs.

## Security Gaps

Known security gaps in this starter:

1. **In-memory storage** - No persistent state
2. **No concurrent protection** - Race conditions possible
3. **Stub verifier** - Not calling real World ID API
4. **Synthetic updates** - Not authenticated Telegram API updates
5. **No enrollment flow** - Manual binding only
6. **No revocation sync** - No integration with World ID events
7. **No audit logging** - No record of admission decisions
8. **No rate limiting** - Vulnerable to enumeration attacks

See [AGENTS.md](./AGENTS.md) for complete security analysis.

## Privacy and Data Retention

**Policy decisions awaiting Bob:**
- Data retention period
- Deletion policy on revocation
- Re-verification frequency
- Logging verbosity
- Nullifier scope (per-action vs global)

**Current test implementation:** In-memory only, no persistence.

## License

License choice awaiting Bob. See repository for license when available.

**Public sharing and reuse are intended.** Recommended license options:
- MIT - Permissive, simple
- Apache 2.0 - Permissive, includes patent grant
- BSD 3-Clause - Permissive, includes attribution requirement

**Do NOT assume licensed reuse until Bob adds a LICENSE file.**

## Next Steps for Production

1. **Review and approve** this starter architecture
2. **Choose license** and add LICENSE file
3. **Implement production verifier** with real HTTPS client
4. **Implement durable storage** with transaction support
5. **Design enrollment flow** with dual authentication
6. **Integrate with OpenClaw** gateway for authenticated updates
7. **Add monitoring and alerting** for verification failures
8. **Test with real World ID** proofs in staging environment
9. **Document privacy policy** and data retention
10. **Security review** before production deployment

## References

- World ID Documentation: https://docs.world.org/
- World ID Verification API: https://docs.world.org/api-reference/developer-portal/verify
- World ID 4.0 Migration: https://docs.world.org/world-id/4-0-migration
- OpenClaw Documentation: https://docs.openclaw.ai/
- Telegram Bot API: https://core.telegram.org/bots/api

## Support

Questions or issues? Contact Bob or open an issue in this repository.
