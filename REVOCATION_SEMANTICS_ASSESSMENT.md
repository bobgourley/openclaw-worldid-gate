# Revocation Semantics Assessment (T257u)

## Bob's Guidance Summary

Bob clarified intended revocation semantics:

> A user's verification in your app: World has nothing to revoke here. The proof is already used, and the record of it lives in your database. **Uniqueness proofs**: to block user permanently keep nullifier row; deleting row lets same person verify action again so only if reverify intended. **Sessions**: remove/replace session_id linked to account as account-security operation not silent overwrite, then old-session proofs won't match account. Either way remove app access; World ID session isn't login token.

**Key points:**
1. World ID does not revoke proofs; revocation is application-level access control
2. **Bob's intended /revoke explicitly permits later fresh /verify, NOT permanent ban**
3. Immutable ownership claims prevent different Telegram account taking same World identity
4. Don't simply delete claims or fence

## Implementation Assessment (Commit 83ebbaa)

### 1. Proof Mode: Uniqueness Proofs Only

**Schema analysis:**

```sql
-- NO session-related fields exist
CREATE TABLE nullifier_claims (...);         -- Immutable ownership
CREATE TABLE enrollments (...);               -- Active/revoked state
CREATE TABLE generation_fences (...);         -- Durable revocation markers
CREATE TABLE challenge_sessions (...);        -- Internal pre-completion tracking only
```

✅ **Confirmed**: We use **uniqueness proofs** exclusively, NOT World ID session proofs.  
✅ No `session_id`, `session_nullifier`, or session proof fields in schema.  
✅ `challenge_sessions` is internal challenge tracking, not World ID session architecture.

### 2. Revocation Semantics: Same-Owner Fresh Re-enrollment

**Revocation flow** (`revokeEnrollment()`, lines 909-977):

```typescript
// 1. UPSERT durable generation fence
INSERT INTO generation_fences (...) VALUES (...)
  ON CONFLICT DO UPDATE SET fence_generation = ...;

// 2. Mark enrollment revoked (UPDATE, not DELETE)
UPDATE enrollments
SET revoked = 1, revoked_at = ?, revoked_generation = ?
WHERE telegram_user_id = ? AND action = ? AND revoked = 0;

// 3. Delete pending challenges
DELETE FROM challenge_sessions WHERE telegram_user_id = ? AND action = ?;
```

**Completion flow** (`completeEnrollment()`, lines 557-884):

```typescript
// Step A: Fence check (lines 733-735)
const fenceCheck = db.prepare(`
  SELECT fence_generation FROM generation_fences
  WHERE telegram_user_id = ? AND action = ?
`).get(...);

if (fenceCheck && challengeRow.generation < fenceCheck.fence_generation) {
  throw new Error('Challenge predates revocation fence');
}
// ✓ Fresh post-revocation challenge: generation >= fence_generation → PASS

// Step B: Ownership check (lines 770-780)
const nullifierOwnerCheck = db.prepare(`
  SELECT telegram_user_id FROM nullifier_claims
  WHERE nullifier = ? AND action = ?
`).get(...);

if (nullifierOwnerCheck && nullifierOwnerCheck.telegram_user_id !== authenticatedUser.id) {
  throw new Error('Nullifier permanently bound to different account');
}
// ✓ Same owner: nullifier owned by same telegram_user_id → PASS
// ✗ Different owner: nullifier owned by different telegram_user_id → REJECT

// Step C: Claim on first use only (lines 784-801)
if (!nullifierOwnerCheck) {
  INSERT INTO nullifier_claims (...) VALUES (...);
}
// ✓ Re-enrollment with same nullifier: claim already exists → SKIP insert

// Step D: UPSERT enrollment (lines 816-826)
INSERT INTO enrollments (...) VALUES (...)
  ON CONFLICT(telegram_user_id, action) DO UPDATE SET
    revoked = 0,
    revoked_at = NULL,
    revoked_at_seconds = NULL;
// ✓ Fresh enrollment clears revocation → RE-ENROLLED
```

### 3. Synthetic Flow Proof

**Scenario 1: Same-owner fresh re-enrollment (PASSES)**

```
1. User A (telegram_user_id=1001) enrolls with nullifier N1
   → nullifier_claims: (N1, action, 1001)
   → enrollments: (1001, action, revoked=0)

2. Admin revokes user A
   → enrollments: (1001, action, revoked=1, revoked_generation=G1)
   → generation_fences: (1001, action, fence_generation=G1)

3. User A creates fresh challenge (generation G2 > G1)

4. User A completes with fresh proof (same nullifier N1):
   ✓ Fence check: G2 >= G1 → PASS (fresh challenge)
   ✓ Ownership check: N1 owned by 1001, requester is 1001 → PASS (same owner)
   ✓ Claim: nullifierOwnerCheck exists → SKIP insert (already claimed)
   ✓ UPSERT: revoked=0, clears revocation timestamps → RE-ENROLLED

Result: User A successfully re-enrolled with same nullifier after revocation.
```

**Scenario 2: Cross-account takeover (REJECTED)**

```
1. User A (telegram_user_id=1001) enrolls with nullifier N1
   → nullifier_claims: (N1, action, 1001)

2. Admin revokes user A
   → enrollments: (1001, action, revoked=1)
   → generation_fences: (1001, action, fence_generation=G1)

3. User B (telegram_user_id=1002) creates fresh challenge (generation G2 > G1)

4. User B tries to complete with nullifier N1:
   ✗ Ownership check: N1 owned by 1001, requester is 1002 → REJECT
   Error: 'Nullifier permanently bound to different account (immutable one-human binding)'

Result: Cross-account nullifier takeover blocked permanently.
```

**Scenario 3: Pre-revocation challenge (REJECTED)**

```
1. User A creates challenge (generation G1)
2. Admin revokes user A (generation_fences: G2)
3. User A tries to complete old challenge G1:
   ✗ Fence check: G1 < G2 → REJECT
   Error: 'Challenge predates revocation fence (fresh verification required)'

Result: Pre-revocation challenge blocked even though same owner.
```

### 4. Assessment Conclusion

✅ **Correct semantics**: Same-owner fresh re-enrollment after revocation WORKS  
✅ **Immutable ownership**: Cross-account nullifier takeover BLOCKED permanently  
✅ **Generation fences**: Pre-revocation challenges BLOCKED, fresh proofs ALLOWED  
✅ **Uniqueness proof mode**: No session architecture implemented or needed  
✅ **No erroneous deletions**: Claims and fences PRESERVED across revoke/re-enroll cycles

**Compliance with Bob's guidance:**

- ✅ Revocation permits later fresh verification (NOT permanent ban)
- ✅ Immutable ownership prevents different Telegram account taking same World identity
- ✅ Claims and fences not deleted on revocation
- ✅ Generation fence blocks pre-revocation challenges
- ✅ Same-owner fresh proof with same nullifier allowed

### 5. No Implementation Changes Required

The 83ebbaa implementation correctly satisfies Bob's revocation semantics requirements.

**Actual behavior matches intended behavior:**
- Per-account revocation with fresh verification restore capability
- Immutable one-human binding (nullifier permanently tied to first claimant)
- Durable generation fences prevent pre-revocation challenge completion
- UPSERT clears revocation on fresh enrollment

**No semantic corrections needed.**

---

## References

- Commit: `83ebbaa` (production enrollment service with SQLite revocation)
- Source: `src/enrollment-service-production.ts`
- Tables: `nullifier_claims`, `enrollments`, `generation_fences`, `challenge_sessions`
- Official protocol: World ID 4.0 uniqueness proofs (nullifier-based, one-time per action)
- Bob's guidance: t257u (2026-11-08)
