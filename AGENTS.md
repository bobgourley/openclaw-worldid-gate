# Agent Safety Boundaries

This document defines the security boundaries and safety guarantees for the World ID admission gate.

## Architecture Overview

```
Telegram Update
       |
       v
[Admission Gate] <-- fail-closed check
       |
       +-- REJECTED --> [Zero downstream calls]
       |                - NO LLM calls
       |                - NO history access
       |                - NO tool execution
       |
       +-- ADMITTED --> [OpenClaw Agent]
                        - LLM processing allowed
                        - History access allowed
                        - Tool execution allowed
```

## Security Principles

### 1. Fail-Closed by Default

The admission gate is fail-closed. ALL requests are rejected by default. Only explicitly verified enrollments are admitted.

**Rejection triggers ZERO downstream operations:**
- No LLM model calls
- No conversation history reads or writes
- No tool executions (MCP servers, system commands, file access, etc.)

This is enforced at the admission layer BEFORE any agent logic runs.

### 2. Authenticated Telegram User ID Only

The gate uses ONLY the numeric Telegram user ID from authenticated updates:
- User IDs are numeric and immutable
- Usernames are NOT used (mutable, can be changed)
- Display names are NOT used (untrusted user input)
- Forwarded message authors do NOT substitute for the sender
- Quoted message authors do NOT substitute for the sender
- Bot messages are rejected
- Channel posts are rejected

### 3. World ID Proof Validation

World ID proofs are validated against the World ID verification API:
- Endpoint: `POST https://developer.world.org/api/v4/verify/{rp_id}`
- Protocol version 4.0 required
- `proof_of_human` credential required (configurable)
- Nullifiers checked for uniqueness (one-time use)
- Proof expiration enforced
- Revocation status checked

**Reference:** https://docs.world.org/api-reference/developer-portal/verify

### 4. Enrollment Binding

Enrollment binds a Telegram user ID to a World ID nullifier:
- One enrollment per Telegram user ID
- One enrollment per World ID nullifier (enforced by verification API)
- Enrollment has a time-to-live (configurable, default 30 days)
- Enrollment can be revoked
- Action-specific enrollment (prevents proof reuse across different applications)

**IMPORTANT:** This starter uses synthetic Telegram updates for testing. Production requires:
1. Authenticated Telegram bot API updates (via OpenClaw gateway)
2. Separate enrollment flow where user authenticates to both services
3. Durable storage with concurrent access protection

### 5. Credential Types and Assurance Levels

World ID 4.0 supports multiple credential types:
- **Proof of Human** (`identifier: "proof_of_human"`, `issuer_schema_id: 1`) - Orb biometric verification, highest assurance, three-year validity
- **Proof of Presence** (`identifier: "selfie"`, `issuer_schema_id: 11`) - Device camera verification, medium assurance, includes sybil_score

**Configuration option:** `requireProofOfHuman: true` (default) restricts admission to Orb-verified Proof of Human credentials only.

**Legacy World ID 3.0:** Used different identifiers ("orb", "face"). This starter targets v4 only and does not support v3 proofs.

**References:**
- Proof of Human: https://docs.world.org/world-id/credentials/1
- Proof of Presence: https://docs.world.org/world-id/credentials/11
- Core Concepts: https://docs.world.org/world-id/concepts

### 6. Nullifier Scope and Replay Protection

**Uniqueness Proofs (Implemented in this starter):**

For one-time actions, World ID generates nullifiers that are unique per (user, RP, action):
- Each proof is tied to a specific `action` string
- Same user + same RP + same action = same nullifier
- This prevents proof replay for that action
- Different actions generate different nullifiers
- Action string must match between enrollment and admission check

**Reference:** https://docs.world.org/world-id/concepts

**Session Proofs (NOT implemented in this starter):**

For returning users, World ID 4.0 supports session proofs with:
- `session_id` - stable identifier across multiple requests (format: `session_<128 hex chars>`)
- `session_nullifier` - per-proof replay protection (tuple: `[nullifier, action]`)
- Allows multiple verifications of the same user
- Use case: re-authentication without re-enrollment

This starter implements uniqueness proofs (one-time enrollment) only. Session proofs are not implemented.

**Reference:** https://docs.world.org/world-id/idkit/session-proofs

### 7. Proof Freshness and Expiration

World ID proofs contain `expires_at_min` field:
- Unix timestamp indicating minimum expiration time
- Enforced during verification
- Enrollments also have a separate TTL (configurable)

**UNIMPLEMENTED:** Re-verification triggers when enrollment expires. Current implementation requires manual re-enrollment.

### 8. Test vs Production Boundaries

**This is a TEST-ONLY starter.** Clear boundaries:

| Component | Test Implementation | Production Required |
|-----------|---------------------|---------------------|
| World ID Verifier | Stub with synthetic responses | HTTPS client calling real API |
| Enrollment Store | In-memory Map | Durable database with transactions |
| Telegram Updates | Synthetic test fixtures | Authenticated bot API updates |
| Replay Protection | In-memory check | Persistent nullifier tracking |

**Do NOT:**
- Use stub verifier in production
- Deploy in-memory store to production
- Trust synthetic Telegram updates as authenticated

**Production checklist:**
- [ ] Implement real World ID API client
- [ ] Deploy durable enrollment storage
- [ ] Integrate with OpenClaw gateway for authenticated Telegram updates
- [ ] Add monitoring and alerting for verification failures
- [ ] Implement proper error handling and retry logic
- [ ] Add audit logging for enrollment and admission events
- [ ] Review and test concurrent enrollment attempts
- [ ] Test revocation flow end-to-end
- [ ] Document privacy policy and data retention
- [ ] Document re-verification policy

## Unimplemented Security Features

The following security features are documented but not implemented:

1. **Enrollment challenge protocol** - How to bind Telegram identity to World ID proof
2. **Concurrent enrollment protection** - Database-level unique constraints
3. **Revocation race conditions** - Transaction isolation for revocation checks
4. **Proof replay across restarts** - Durable nullifier tracking
5. **Re-verification triggers** - Automatic re-enrollment on expiration
6. **Audit trail** - Logging of all enrollment and admission decisions
7. **Rate limiting** - Prevent enumeration attacks on user IDs

## Privacy and Data Minimization

**Current test implementation stores:**
- Telegram user ID (numeric, immutable)
- World ID nullifier (unique per action)
- Enrollment timestamp
- Expiration timestamp
- Action string

**NOT stored:**
- Telegram username (mutable)
- Display name (untrusted)
- Full World ID proof (not needed after verification)
- IP addresses (not available in this layer)

**Policy decisions needed (awaiting Bob):**
- Data retention period
- Deletion on revocation vs soft delete
- Logging verbosity
- Re-verification frequency
- Nullifier uniqueness scope (per action vs global)

## Quote and Forward Attribution Policy

**Current behavior:**
- Forwarded messages: Use sender ID, ignore `forward_from`
- Quoted/reply messages: Use sender ID, ignore `reply_to_message.from`

**Rationale:** Content attribution does NOT substitute for authenticated sender. Only the message sender (who controls the Telegram session) can be held accountable for sending the message to the bot.

**Alternative policies (not implemented):**
- Reject all forwarded messages
- Reject all reply chains
- Strip forwarded/quoted context before processing

## Integration Points

### OpenClaw Gateway Integration (UNKNOWN)

**The exact integration point in OpenClaw is unknown.** OpenClaw does not document a public API for admission gates or pre-agent hooks.

Official OpenClaw Telegram documentation (https://docs.openclaw.ai/channels/telegram/) covers:
- Bot token configuration
- Access control via `dmPolicy` and `allowFrom`
- Pairing flow for DM approval
- Group allowlists and mention gating

**Unknown:**
- Where to inject admission logic in message processing pipeline
- How to access authenticated updates before agent processing
- Whether OpenClaw provides middleware or hooks for this use case
- How to prevent downstream agent calls after rejection

**Possible integration approaches (all unverified):**
1. Modify OpenClaw source code to add admission hook
2. Wrap OpenClaw Gateway with proxy that filters updates
3. Use existing `allowFrom` allowlist dynamically (requires syncing with enrollments)
4. Plugin architecture (if OpenClaw supports admission plugins)

**No working integration exists in this starter.** This is a standalone admission gate that would need to be wired into OpenClaw's message processing flow.

### Enrollment Flow (UNIMPLEMENTED - Proposed Only)

**CRITICAL:** The `enroll()` function in this starter is a TEST-ONLY helper that accepts arbitrary parameters WITHOUT authenticating the binding between Telegram user ID and World ID proof.

**Insufficiencies:**
- Caller-supplied Telegram user ID is not authenticated
- Proof possession does not prove Telegram account ownership
- No challenge prevents copied proofs from being bound to different accounts
- No session binding validates the user controls both identities

**Proposed production enrollment flow:**

1. User sends `/enroll` command to Telegram bot
2. Bot generates unique nonce and enrollment challenge URL
3. User opens URL, presented with World ID IDKit widget
4. IDKit requests proof with:
   - `action: "openclaw-enrollment"`
   - `nonce: <unique-challenge-nonce>`
   - `signal: <telegram-user-id>` (signed into proof)
5. User completes World ID verification in World App
6. Frontend receives proof, sends to backend with:
   - World ID proof (contains signed signal with Telegram user ID)
   - Nonce (for replay protection)
   - Telegram bot session token (proves user controls Telegram account)
7. Backend validates:
   - World ID proof via verification API
   - Nonce freshness and unused status
   - Signal matches claimed Telegram user ID
   - Telegram session token authenticity (proves account control)
   - No existing enrollment for either identity
8. Backend creates enrollment binding atomically
9. User confirmed via bot message

**This enrollment flow does not exist in this starter.** The `enroll()` function is unsafe for production use.

## Testing Guarantees

The test suite proves these guarantees:

1. **Unknown users** - ZERO downstream calls
2. **Unverified users** - ZERO downstream calls
3. **Revoked enrollments** - ZERO downstream calls
4. **Expired enrollments** - ZERO downstream calls
5. **Action mismatches** - ZERO downstream calls
6. **Malformed proofs** - ZERO downstream calls
7. **Verification errors** - ZERO downstream calls
8. **Verification outages** - ZERO downstream calls
9. **Bot messages** - ZERO downstream calls
10. **Channel posts** - ZERO downstream calls

Run tests: `npm test`

## License

License choice awaiting Bob. No license file included.

## References

- World ID Verification API: https://docs.world.org/api-reference/developer-portal/verify
- World ID 4.0 Migration: https://docs.world.org/world-id/4-0-migration
- OpenClaw Documentation: https://docs.openclaw.ai/
- Telegram Bot API: https://core.telegram.org/bots/api
