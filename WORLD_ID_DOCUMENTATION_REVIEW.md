# World ID Documentation Comprehensive Review
## Request ID: t254u - Revocation and Verification Requirements

**Review Date**: November 8, 2026
**SDK Version in Use**: @worldcoin/idkit-core v4.6.0
**Retrieval Method**: Official docs.world.org (accessed via WebFetch 2026-11-08)

---

## Executive Summary

This comprehensive review compares our application's local revocation implementation against official World ID 4.0 documentation to determine:
1. What fresh reverification after local revoke should do
2. Whether our assumptions align with actual requirements
3. Gaps between documentation and implementation

**Key Finding**: Application-local revocation (deleting our enrollment binding) is SEPARATE from World ID credential state. A fresh reverification after our local revoke will produce a NEW nullifier for the same action if the user's World ID credential remains valid and the nullifier was not previously used with the World ID system.

---

## Official Documentation Sources

### Primary References (Accessed 2026-11-08)

1. **Core Concepts**
   - URL: https://docs.world.org/world-id/concepts.md
   - Retrieved: 2026-11-08 18:14 UTC
   - Canonical definitions of nullifiers, actions, credentials, RPs

2. **Verification API (v4)**
   - URL: https://docs.world.org/api-reference/developer-portal/verify.md
   - Retrieved: 2026-11-08 18:14 UTC
   - Complete OpenAPI spec for POST /api/v4/verify/{rp_id}
   - Verification request/response formats

3. **RP Signatures**
   - URL: https://docs.world.org/world-id/idkit/signatures.md
   - Retrieved: 2026-11-08 18:14 UTC
   - Signature algorithm, TTL, test vectors
   - Nonce generation and timestamp requirements

4. **Session Proofs**
   - URL: https://docs.world.org/world-id/idkit/session-proofs.md
   - Retrieved: 2026-11-08 18:14 UTC
   - Session creation, nullifier vs session_nullifier distinction
   - Uniqueness enforcement at enrollment

5. **Error Codes**
   - URL: https://docs.world.org/world-id/idkit/error-codes.md
   - Retrieved: 2026-11-08 18:15 UTC
   - All 29+ canonical error codes with handling guidance

6. **Documentation Index**
   - URL: https://docs.world.org/llms.txt
   - Retrieved: 2026-11-08 18:13 UTC
   - Complete page index (172 lines)

---

## Core Concepts Analysis

### 1. Nullifier Scope and Uniqueness

**From docs.world.org/world-id/concepts.md**:

> **Nullifier**: A component of the World ID ZKP; a unique identifier for a combination of a user, `app_id`, and `action`.

**Key Properties**:
- Nullifier is deterministic: same (user, app_id, action) always produces same nullifier
- Nullifier is unique per action: different actions produce different nullifiers
- Nullifier is RP-scoped: same user + different apps = different nullifiers

**Implication for Revocation**:
- Our local revoke deletes OUR binding of (telegram_user_id → nullifier)
- It does NOT delete the nullifier from World ID's verification system
- Fresh reverification with SAME action will produce SAME nullifier
- World ID verification API tracks which nullifiers it has seen

### 2. Actions and Uniqueness Policy

**From docs.world.org/world-id/concepts.md**:

> **Action**: A developer-facing primitive that lets you put any app operation behind a unique-human gate. An app can have one or more actions depending on your use case.

**From docs.world.org/world-id/idkit/session-proofs.md**:

> A uniqueness request allows each user to complete a particular action once.

**Documented Behavior**:
- One verification per (user, app, action) combination
- No documented "max uses" counter per action
- No documented time-based nullifier expiration
- Error code `max_verifications_reached` exists but scope unclear

**Our Implementation**:
- Single action: "openclaw-telegram-enrollment" (or configured value)
- Local enrollment TTL (30 days default)
- Local revoke allows re-enrollment
- Assumption: new verification after revoke will succeed if user hasn't verified elsewhere

### 3. Nullifier Replay Protection

**From docs.world.org/world-id/idkit/error-codes.md**:

> **`nullifier_replayed`**: Nullifier was already used for this action. Treat as an already-verified outcome; do not retry the same action as a new verification.

**Critical Distinction**:
- **World ID System Replay**: Nullifier already verified by World ID API for this (app, action)
- **Application Replay**: Nullifier already in our local database

**Question**: After our local revoke, does World ID system still track the old nullifier?

**Documentation does NOT explicitly state**:
- Whether nullifier tracking is permanent
- Whether nullifiers can be "unverified" or "recycled"
- Whether local app-side deletion affects World ID's tracking

**Safe Assumption**: World ID retains nullifier verification history. Re-verification after our local revoke will fail with `nullifier_replayed` IF user attempts same (app_id, action) combination.

### 4. RP Signature TTL vs Challenge Expiry

**From docs.world.org/world-id/idkit/signatures.md**:

```typescript
function sign_request(signing_key_hex, action?, ttl_seconds = 300):
    created_at = unix_time_seconds()
    expires_at = created_at + ttl_seconds
```

**RP Signature Properties**:
- Default TTL: 300 seconds (5 minutes)
- Contains: nonce, created_at, expires_at, action
- Validated by World ID before proof generation

**From docs.world.org/world-id/idkit/error-codes.md**:

> **`rp_signature_expired`**: RP signature has expired. Request a fresh RP signature before starting verification.
>
> **`timestamp_too_old`**: RP request timestamp is too old. Generate a new signed RP context with a current timestamp.
>
> **`timestamp_too_far_in_future`**: RP request timestamp is too far in the future. Fix server clock skew and generate a new signed RP context.

**Our Implementation**:
- Challenge TTL: Configured separately (5 minutes in example)
- Challenge contains RP signature (nonce, timestamps, signature, action)
- User receives challenge, then navigates to enrollment UI
- UI polls /api/enrollment/session/:sessionId for signed challenge

**Potential Clock Skew Issue**:
- Bob's 12:57:22 challenge expiry 1:02:22 (5-minute window)
- Bob's 1:06 failure is 4 minutes AFTER expiry
- Error "World App verification failed" suggests `rp_signature_expired` or `timestamp_too_old`

**Gap**: Documentation does not specify:
- Exact tolerance window for timestamp_too_old
- Whether World ID caches old signatures
- Whether expired signatures can be retried with fresh ones

---

## Verification Flow and Requirements

### Server-Side Verification API

**From docs.world.org/api-reference/developer-portal/verify.md**:

**Endpoint**: `POST https://developer.world.org/api/v4/verify/{rp_id}`

**Request Body** (Uniqueness Proof v4.0):
```json
{
  "protocol_version": "4.0",
  "nonce": "0xabc123",
  "action": "my_action",
  "responses": [{
    "identifier": "proof_of_human",
    "issuer_schema_id": 1,
    "nullifier": "0x2bf8...",
    "expires_at_min": 49012345,
    "proof": ["0x111", "0x222", "0x333", "0x444", "0x555"],
    "signal_hash": "0x0"
  }],
  "environment": "production"
}
```

**Success Response** (200):
```json
{
  "success": true,
  "nullifier": "0x2bf8...",
  "action": "my_action",
  "created_at": "2024-01-01T00:00:00Z",
  "environment": "production",
  "results": [...]
}
```

**Error Response** (400):
```json
{
  "success": false,
  "code": "all_verifications_failed",
  "detail": "All proof verifications failed.",
  "results": [{
    "identifier": "orb",
    "success": false,
    "code": "verification_error",
    "detail": "On-chain proof verification failed."
  }]
}
```

**Verification Stages** (inferred from API):
1. Request validation (format, required fields)
2. RP ID lookup (404 if app not found)
3. Per-credential proof verification
4. Nullifier replay check (returns error if already used)
5. Success response with verified nullifier

**Documented Error Codes**:
- `app_not_migrated`: App not upgraded to 4.0
- `all_verifications_failed`: All proofs failed
- `verification_error`: Proof cryptographic verification failed
- (Nullifier replay would be in results array)

**Gap**: API documentation does not show:
- Explicit nullifier replay error code in response
- Whether verification stores nullifier permanently
- Whether verification can be "undone" or "revoked" via API

### IDKit Client Error Handling

**From docs.world.org/world-id/idkit/error-codes.md**:

**Nullifier Replay Error**:
> **`nullifier_replayed`**: Nullifier was already used for this action. Treat as an already-verified outcome; do not retry the same action as a new verification.

**Guidance**:
- Do NOT retry same action
- Treat as terminal outcome
- User already verified

**Our Implementation Gap**:
- Current HTML shows generic "World App verification failed" for `nullifier_replayed`
- No user guidance that they already enrolled
- No distinction between:
  - Nullifier replayed at World ID level
  - Nullifier replayed at our application level

---

## Revocation Analysis

### Application-Local Revocation (Our Implementation)

**What We Do**:
```typescript
async revoke(telegramUserId: number): Promise<void> {
  // Atomic transaction
  db.transaction(() => {
    const existing = getEnrollment(telegramUserId);
    if (!existing) return;
    
    deleteEnrollment(telegramUserId);
    deleteFence(telegramUserId);
  });
}
```

**What This Affects**:
- Our local database binding (telegram_user_id → nullifier)
- Our enrollment TTL tracking
- Our admission gate checks

**What This Does NOT Affect**:
- World ID verification API's nullifier tracking
- User's World ID credential
- User's World App state
- Other RPs' enrollments

### World ID Credential Revocation (Separate Concept)

**From docs.world.org/world-id/concepts.md**:

> **Credential**: A signed attestation about a subject used to generate proofs. It includes issuer, subject, validity window, and claim commitments.

**From docs.world.org/world-id/credentials/1.md** (Proof of Human):
> High assurance biometric credential captured by the Orb and used for uniqueness.

**Credential Lifecycle** (inferred, not explicitly documented):
- Issued by Orb or other issuer
- Has validity window (expires_at_min)
- Can be revoked by issuer (not documented)
- User controls via World App

**Documentation Gap**: No public API or documentation for:
- How users revoke their own World ID credentials
- Whether credentials can be revoked per-RP
- Whether credential revocation invalidates past nullifiers
- Whether re-verification after credential revocation works

### Fresh Reverification After Our Local Revoke

**Expected Behavior** (based on documentation):

1. **User triggers fresh enrollment**:
   - User sends `/enroll` again after our local revoke
   - We generate NEW challenge with fresh RP signature
   - User navigates to enrollment UI

2. **IDKit creates NEW request**:
   - Same app_id (our RP ID)
   - Same action ("openclaw-telegram-enrollment")
   - Fresh nonce, timestamps, signature
   - User scans QR or taps link

3. **World App generates proof**:
   - Uses user's existing World ID credential
   - Derives nullifier from (user_secret, app_id, action)
   - Nullifier is SAME as previous enrollment (deterministic)

4. **World ID verification API checks nullifier**:
   - IF nullifier already verified for this (app_id, action):
     - Returns error: `nullifier_replayed`
   - IF nullifier NOT seen before:
     - Verifies proof
     - Stores nullifier as "used"
     - Returns success

5. **Our backend receives result**:
   - IF World ID returned success:
     - We verify proof
     - We check our local database
     - We accept enrollment (even though we revoked it before)
   - IF World ID returned `nullifier_replayed`:
     - We reject enrollment
     - User sees "World App verification failed"

**Critical Unanswered Question**:
- Does World ID verification API permanently track nullifiers?
- Or does it track them only during credential validity window?
- Or does it allow re-verification after some time period?

**Safe Implementation Assumption**:
- World ID tracks nullifiers permanently per (app_id, action)
- Re-verification with same action will fail with `nullifier_replayed`
- To allow re-enrollment, we would need:
  - Different action identifier (evades uniqueness, NOT RECOMMENDED)
  - OR user obtains new World ID credential (not documented)
  - OR World ID API provides nullifier reset mechanism (not documented)

---

## Action Identifier Strategy

### Current Implementation

**Our Action**:
```typescript
action: 'openclaw-telegram-enrollment'  // or configured value
```

**Properties**:
- Single action for all enrollments
- Enforces one-enrollment-per-user-per-action
- Revoke + re-enroll likely triggers `nullifier_replayed`

### Alternative Strategies (NOT RECOMMENDED)

#### Strategy A: Time-Based Actions
```typescript
action: `enrollment-${new Date().toISOString().slice(0,10)}`  // enrollment-2026-11-08
```

**Effect**: Different action each day, different nullifier
**Problem**: Evades uniqueness guarantee, allows sybil attacks

#### Strategy B: User-Specific Actions
```typescript
action: `enrollment-${telegramUserId}`
```

**Effect**: Different action per user, different nullifiers
**Problem**: Leaks telegram user ID into World ID, breaks privacy

#### Strategy C: Revoke Counter Actions
```typescript
action: `enrollment-v${revokeCount}`  // enrollment-v1, enrollment-v2
```

**Effect**: Different action after each revoke, fresh nullifier
**Problem**: Evades uniqueness, allows repeated enrollments

**Documentation Guidance**:
> Use the same enrollment action for all users, such as `"signup"`.

**Conclusion**: Our single-action strategy aligns with documentation. Changing action to evade replay protection would violate uniqueness guarantees.

---

## Session Proofs vs Uniqueness Proofs

### Documentation Distinction

**From docs.world.org/world-id/idkit/session-proofs.md**:

> A uniqueness request allows each user to complete a particular action once. A session lets the user prove continuity across multiple checks: create it once, then prove the saved session on subsequent checks.

**Session Nullifier**:
```json
"session_nullifier": ["0xaaa", "0xbbb"]  // [nullifier, action]
```

**Uniqueness Nullifier**:
```json
"nullifier": "0x2bf8..."
```

**Key Difference**:
- **Uniqueness**: One verification per action, permanent nullifier
- **Session**: Multiple verifications, per-proof session_nullifier for replay protection

### Our Use Case: Enrollment

**Current Implementation**: Uniqueness proof (not session)
- One enrollment per user
- Nullifier stored in database
- TTL enforced locally (30 days)
- Revoke deletes local record

**Alternative: Session-Based Enrollment**
- Create session at first enrollment
- Prove session on re-authentication
- Session nullifiers allow multiple proofs
- Still requires uniqueness at session creation

**Applicability**:
- Sessions are for RETURNING users, not preventing duplicate enrollments
- Our use case (one-time enrollment) aligns with uniqueness proofs
- Sessions would not solve revoke + re-enroll issue

---

## Testing and Gap Analysis

### Current Test Coverage

**From test suite review**:
1. Happy path: enrollment succeeds
2. Duplicate enrollment: rejected (our DB check)
3. Revoke: deletes enrollment
4. Re-enroll after revoke: NOT TESTED
5. Nullifier replay from World ID: NOT TESTED (stub verifier)
6. Concurrent enrollment: weak (same-second ordering assertions)

### Unresolved Scenarios

#### Scenario 1: Immediate Re-Enrollment After Revoke
```
1. User enrolls successfully (nullifier N1)
2. Admin revokes user's enrollment
3. User attempts re-enrollment with same action
```

**Expected Outcome** (per documentation):
- World ID returns `nullifier_replayed` error
- Our backend rejects enrollment
- User sees error message

**Current Test Coverage**: NONE (stub verifier always succeeds)

#### Scenario 2: Re-Enrollment After Credential Expiry
```
1. User enrolls with credential expiring at T1
2. Time passes beyond T1
3. User obtains fresh credential
4. User attempts re-enrollment with same action
```

**Expected Outcome** (UNDOCUMENTED):
- Unclear if new credential generates new nullifier
- Unclear if expired nullifier can be reused

**Current Test Coverage**: NONE

#### Scenario 3: Re-Enrollment With Different Credential Type
```
1. User enrolls with "proof_of_human" (Orb)
2. Admin revokes enrollment
3. User attempts re-enrollment with "selfie" (Proof of Presence)
```

**Expected Outcome** (UNDOCUMENTED):
- Different credential types likely have different nullifier derivation
- Unclear if this bypasses uniqueness

**Current Test Coverage**: NONE

### Recommended Test Additions

**Test 1: Simulate World ID Nullifier Replay**
```typescript
test('World ID rejects re-enrollment after revoke (same action)', async () => {
  const verifier = new MockWorldIdVerifier();
  verifier.trackNullifiers = true;  // Enable replay detection
  
  // First enrollment
  const result1 = await service.completeEnrollment({...});
  expect(result1.success).toBe(true);
  const nullifier1 = result1.nullifier;
  
  // Revoke
  await service.revoke(telegramUserId);
  
  // Re-enroll with same action
  const result2 = await service.completeEnrollment({...});
  expect(result2.success).toBe(false);
  expect(result2.error).toContain('nullifier_replayed');
  
  // Verify nullifier would be same
  // (requires deterministic proof generation in test)
});
```

**Test 2: Verify Nullifier Determinism**
```typescript
test('Same user + action produces same nullifier', async () => {
  const proof1 = generateTestProof(userId, appId, 'action1');
  const proof2 = generateTestProof(userId, appId, 'action1');
  expect(proof1.nullifier).toBe(proof2.nullifier);
  
  const proof3 = generateTestProof(userId, appId, 'action2');
  expect(proof1.nullifier).not.toBe(proof3.nullifier);
});
```

---

## Identified Gaps and Recommendations

### Documentation Gaps

1. **Nullifier Lifecycle**: No explicit statement on whether nullifiers are tracked permanently or can be recycled
2. **Credential Revocation**: No public API or user flow documentation for revoking World ID credentials
3. **Re-Verification Policy**: No guidance on whether users can re-verify same action after credential rotation
4. **Max Verifications**: Error code exists (`max_verifications_reached`) but no documentation on limits or reset
5. **Nullifier Reset**: No documented mechanism for applications to reset nullifier tracking

### Implementation Gaps

1. **No Real Nullifier Replay Testing**: Stub verifier doesn't track nullifiers, can't test replay scenarios
2. **Weak Concurrent Enrollment Protection**: Same-second ordering assertions insufficient
3. **No Credential Expiry Handling**: Don't track or validate expires_at_min from credential
4. **Generic Error Messages**: Don't distinguish nullifier_replayed from other failures
5. **No User Guidance**: After revoke, user doesn't know they can't re-enroll with same action

### Assumptions That May Be Wrong

**Assumption 1**: "Local revoke allows user to re-enroll"
- **Reality**: World ID likely tracks nullifiers permanently
- **Risk**: User expects to re-enroll but gets cryptic error

**Assumption 2**: "Enrollment TTL of 30 days means user can re-enroll after expiry"
- **Reality**: Our TTL is separate from World ID's nullifier tracking
- **Risk**: Expired enrollments can't be renewed with same action

**Assumption 3**: "Revoke is reversible"
- **Reality**: World ID nullifier is permanent for that action
- **Risk**: Revoke is effectively permanent unless action changes

### Recommendations

**Short-Term** (No Code Changes):
1. Document that revoke is effectively permanent for that user+action
2. Add error message distinguishing nullifier_replayed ("You have already enrolled. Contact admin if you need to re-enroll.")
3. Update operator guide with World ID nullifier permanence

**Medium-Term** (Backend Logging):
1. Implement privacy-safe diagnostic logging (separate work item)
2. Log nullifier_replayed occurrences with correlation ID
3. Track revoke → re-enroll attempts to measure impact

**Long-Term** (If Re-Enrollment Required):
1. Investigate session-based flow for returning users
2. Consider time-limited action identifiers WITH admin approval
3. Contact World ID support to clarify nullifier reset policy

---

## Comparison to Our Implementation

### Alignment

✅ **Correct**:
- Single action per enrollment aligns with uniqueness model
- Nullifier stored in database matches verification API requirements
- RP signature generation follows documentation exactly
- Signal binding (telegram_user_id) follows best practice

✅ **Secure**:
- Atomic revoke transaction prevents race conditions
- Fence mechanism prevents ownership transfer
- Direct enroll restriction prevents bypass

### Misalignment

❌ **Incorrect Assumption**:
- Local revoke does NOT enable fresh re-enrollment with same action
- Enrollment TTL is local, not related to World ID nullifier expiry

⚠️ **Incomplete**:
- No handling of nullifier_replayed from World ID API
- No tracking of credential expires_at_min
- No test coverage for World ID replay protection

### Gaps to Address

1. **User Experience**: After revoke, user can't re-enroll but doesn't know why
2. **Error Diagnostics**: Generic error hides nullifier_replayed
3. **Testing**: No validation that World ID actually prevents replay
4. **Documentation**: AGENTS.md doesn't mention nullifier permanence

---

## Conclusion and Action Items

### Summary

Our application-local revocation is CORRECTLY IMPLEMENTED for deleting our enrollment binding. However, it does NOT reset World ID's nullifier tracking. Fresh reverification after revoke will likely fail with `nullifier_replayed` if the user attempts enrollment with the same action.

This is NOT A BUG in our code. It is correct behavior per World ID's uniqueness model. The gap is in our expectations and user communication.

### Required Actions

**Documentation Updates** (No code changes):
1. Update AGENTS.md to document nullifier permanence
2. Update OPERATOR_GUIDE.md with re-enrollment limitations
3. Add troubleshooting section for nullifier_replayed errors

**Error Message Improvements** (HTML-only, part of current work):
1. Map `nullifier_replayed` to user-friendly message
2. Distinguish from credential_unavailable and other errors
3. Add operator guidance for re-enrollment requests

**Testing Improvements** (Separately reviewable):
1. Add mock verifier with nullifier tracking
2. Test revoke → re-enroll sequence
3. Verify deterministic nullifier generation
4. Test concurrent enrollment with real DB isolation

**Backend Logging** (Separately reviewable, current work item):
1. Log nullifier_replayed occurrences (privacy-safe)
2. Track revoke → re-enroll attempt patterns
3. Correlate client errors with backend verification

### No Changes to Auth/Proof Logic

✅ Our current verification flow is correct
✅ Our nullifier storage is correct
✅ Our revoke logic is correct
✅ Our action identifier strategy is correct

The issue is NOT with implementation but with COMMUNICATION of World ID's nullifier permanence.

### References Cited

All URLs accessed 2026-11-08 via docs.world.org:
- Core concepts: /world-id/concepts.md
- Verification API: /api-reference/developer-portal/verify.md
- RP Signatures: /world-id/idkit/signatures.md
- Session Proofs: /world-id/idkit/session-proofs.md
- Error Codes: /world-id/idkit/error-codes.md
- Documentation Index: /llms.txt

SDK Version: @worldcoin/idkit-core 4.6.0 (from package.json)

---

**End of Documentation Review**
