# World ID Documentation Review - Corrected Evidence-Based Analysis
## Request ID: t254u - Revocation and Verification Requirements

**Review Date**: November 8, 2026
**SDK Version in Use**: @worldcoin/idkit-core v4.6.0
**Retrieval Method**: Official docs.world.org (accessed via WebFetch 2026-11-08)

---

## Executive Summary

This corrected review examines official World ID 4.0 documentation to determine verification and revocation semantics, focusing on what is actually documented versus speculative conclusions.

**Critical Correction**: Previous analysis incorrectly concluded that World ID verification API permanently tracks nullifiers. Actual documentation does NOT establish permanent server-side storage or prohibit fresh proofs with same nullifier. Application responsibility for uniqueness enforcement is explicitly documented.

---

## Official Documentation Sources (Accessed 2026-11-08)

### Primary References

1. **Core Concepts**
   - URL: https://docs.world.org/world-id/concepts.md
   - Retrieved: 2026-11-08 18:14 UTC
   - Defines: Nullifier as stable tuple (user, app_id, action)
   - **Does NOT state**: Permanent verification history or server-side ledger

2. **Verification API (v4)**
   - URL: https://docs.world.org/api-reference/developer-portal/verify.md
   - Retrieved: 2026-11-08 18:14 UTC
   - Endpoint: POST /api/v4/verify/{rp_id}
   - Requires complete IDKit result
   - Supports both 4.0 and legacy 3.0 proofs
   - **Does NOT document**: Forever-used nullifier ledger or permanent tracking

3. **Session Proofs**
   - URL: https://docs.world.org/world-id/idkit/session-proofs.md
   - Retrieved: 2026-11-08 18:14 UTC
   - **Key Quote**: "enforce nullifier uniqueness in YOUR DB"
   - **Explicitly states**: Application responsibility for duplicate prevention
   - Session proofs for returning users via fresh RP signatures

4. **Error Codes**
   - URL: https://docs.world.org/world-id/idkit/error-codes.md
   - Retrieved: 2026-11-08 18:15 UTC
   - Documents SDK/bridge error categories
   - **Does NOT establish**: Backend cause of specific errors

5. **Action Metadata (Legacy v2)**
   - URL: https://docs.world.org/api-reference/developer-portal/get-action-metadata.md
   - Retrieved: 2026-11-08 18:31 UTC
   - Exposes max_verifications default 1
   - Shows max_accounts_per_user policy
   - **Previous claim "no documented max uses" was FALSE**

6. **Create Incognito Action (Legacy v2)**
   - URL: https://docs.world.org/api-reference/developer-portal/create-incognito-action.md
   - Retrieved: 2026-11-08 18:31 UTC
   - Legacy v2 action creation with max_verifications

7. **RP Signatures**
   - URL: https://docs.world.org/world-id/idkit/signatures.md
   - Retrieved: 2026-11-08 18:14 UTC
   - Fresh nonce and timestamp required
   - Default 300-second TTL

---

## Core Concepts Analysis - Corrected

### 1. Nullifier Scope (What IS Documented)

**From docs.world.org/world-id/concepts.md**:

> **Nullifier**: A component of the World ID ZKP; a unique identifier for a combination of a user, `app_id`, and `action`.

**Documented Properties**:
- Nullifier is deterministic: same (user, app_id, action) tuple always produces same nullifier
- Nullifier is unique per action: different actions produce different nullifiers
- Nullifier is RP-scoped: same user + different apps = different nullifiers

**NOT Documented**:
- Whether World ID verification API stores verified nullifiers permanently
- Whether fresh proof with same nullifier is accepted or rejected
- Server-side nullifier tracking policy or retention
- Time-based nullifier expiration

**Previous Error**: Concluded permanent upstream tracking without authoritative evidence.

### 2. Application Responsibility for Uniqueness

**From docs.world.org/world-id/idkit/session-proofs.md**:

> **Key Quote** (emphasis added): "enforce nullifier uniqueness in **YOUR DB**, reject already-used enrollment nullifier"

**Clear Documentation**:
- Application MUST track used nullifiers in own database
- Application MUST reject duplicate nullifiers
- Returning users use session proofs + fresh RP signatures

**Implication**:
- Uniqueness enforcement is application responsibility
- World ID provides stable nullifier, not enforcement
- Our 83ebbaa implementation correctly stores and checks nullifiers locally

### 3. Revoke Implementation (Corrected Understanding)

**Actual 83ebbaa SQLite Implementation** (`src/enrollment-service-production.ts` lines 928-934):

```typescript
// 2. Update enrollment if exists (mark revoked with generation)
const enrollmentStmt = this.db.prepare(`
  UPDATE enrollments
  SET revoked = 1, revoked_at = ?, revoked_at_seconds = ?, revoked_generation = ?
  WHERE telegram_user_id = ? AND action = ? AND revoked = 0
`);

const enrollmentResult = enrollmentStmt.run(this.clock.nowISO(), now, generation, telegramUserId, this.action);
const hadEnrollment = enrollmentResult.changes > 0;
```

**What This Actually Does**:
- PRESERVES enrollment row (uses UPDATE, not DELETE)
- Sets `revoked = 1` flag
- Records revocation timestamp and generation
- Maintains nullifier binding in the row
- Generation fence prevents pre-revocation challenge completion

**Previous Error**: Stated it "deletes binding" - incorrect.

**Admission Gate Check** (admission-gate.ts line 114-120):

```typescript
if (enrollment.revoked) {
  return {
    allowed: false,
    reason: 'Enrollment has been revoked',
    telegramUserId,
    enrollment,  // Enrollment object still exists
  };
}
```

**Correct Behavior**:
- Revoked flag checked, not row deletion
- Enrollment data preserved for audit trail
- Fence remains in place
- Original owner can re-verify (implementation allows post-revoke fresh verification)

---

## Remaining Questions and Unknowns

**Cannot Determine Without**:
1. Actual emitted SDK error code from Bob's trial
2. Applicable action policy for our openclaw-verify action  
3. Whether v4 verify endpoint tracks nullifier history
4. Proof receipt behavior from World ID API

**Do NOT claim**:
- Flow is correct
- Issue is only communication
- Re-enrollment is blocked permanently
- World ID tracks nullifiers server-side

**Can confirm**:
- Application responsibility for uniqueness enforcement (documented)
- Implementation follows documented patterns (local DB tracking)
- Error message corrected to neutral wording
- Need actual error codes and action policy data

---

**End of Corrected Documentation Review**
