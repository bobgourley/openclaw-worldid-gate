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

World ID 4.0 supports multiple credential identifiers:
- `proof_of_human` - Orb verification (highest assurance)
- `orb` - Legacy identifier for Orb verification
- `selfie` - Selfie Check verification (lower assurance, includes sybil_score)

**Configuration option:** `requireProofOfHuman: true` restricts admission to Orb-verified credentials only.

**Reference:** https://docs.world.org/world-id/4-0-migration

### 6. Nullifier Scope and Replay Protection

World ID 4.0 uses action-specific nullifiers:
- Each proof is tied to a specific `action` string
- Nullifiers are unique per (user, action) pair
- This prevents proof reuse across different applications
- Action string must match between enrollment and admission check

**Session proofs:** For returning users, World ID 4.0 supports session proofs with:
- `session_id` - stable identifier across multiple requests
- `session_nullifier` - per-proof replay protection

This starter implements uniqueness proofs (one-time enrollment). Session proofs are not yet implemented.

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

### OpenClaw Gateway Integration

The admission gate should be integrated at the OpenClaw gateway level:

```typescript
// Pseudocode - NOT IMPLEMENTED
openclaw.on('telegram:update', async (update) => {
  const admissionResult = await gate.checkAdmission({
    telegramUpdate: update,
    timestamp: Date.now(),
  });

  if (!admissionResult.allowed) {
    await telegram.sendMessage(
      update.message.chat.id,
      'Access denied. Please enroll with World ID.'
    );
    return; // NO FURTHER PROCESSING
  }

  // Proceed to agent processing only if admitted
  await agent.process(update);
});
```

### Enrollment Flow (Proposed)

Enrollment requires a separate flow that authenticates both identities:

1. User visits enrollment web interface
2. User authenticates with Telegram (OAuth or bot deep link)
3. User authenticates with World ID (IDKit widget)
4. Backend receives both authenticated identities
5. Backend validates World ID proof via verification API
6. Backend creates enrollment binding (Telegram ID + World ID nullifier)
7. User can now message the bot

**UNIMPLEMENTED:** This enrollment flow does not exist in this starter.

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
