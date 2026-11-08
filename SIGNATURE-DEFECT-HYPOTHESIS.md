# RP Signature Defect Investigation

## Evidence Summary

### Portal Evidence (4:56 PM ET)
- ✅ App ID: `app_b466e1f63a70a695b6d990d261e31b6a`
- ✅ RP ID: `rp_223416a2a76673a1`
- ✅ Registered public signer: `0x7576AEFb7d97d641EA1626B7fcB3d574a9c4BefD`
- ✅ Runtime-derived public key: `0x7576aefb7d97d641ea1626b7fcb3d574a9c4befd` (EXACT MATCH, case-insensitive)
- ✅ Action "openclaw-verify" exists (one historical proof)
- ⚠️  "App in review" status (but Bob says does NOT prove RP invalid)
- ⚠️  Portal shows no environment/active flag

### Runtime Evidence (4:56 PM EST)
- ✅ Process PID 53898, parent 53886
- ✅ Release 4d2ee41 dist/server.js, Node 24.19.0
- ✅ File mtime 2:44:12 PM EST (4 sec before start at 2:44:16 PM)
- ✅ Config values: app expected, RP expected, action "openclaw-verify", environment "production"
- ✅ Time sync: sntp offset +0.034823s (no meaningful skew)

### Cryptographic Verification
- ✅ Signature cryptographically valid
- ✅ Public key recovery succeeds
- ✅ Action hash independently verified
- ✅ Message format canonical (v1 || nonce || timestamps || action)
- ✅ All mutations detected (negative tests passed)

### Serialization Verification
- ✅ All field types correct
- ✅ All field lengths correct
- ✅ Signature recovery byte valid (27/28)
- ✅ TTL correct (300 seconds)
- ✅ Field mappings correct (backend → frontend → IDKit)

## Known Defects: NONE FOUND

All verification tests pass. Code implementation is correct.

## Remaining Hypotheses

### Hypothesis 1: Environment Mismatch

**Observation**: 
- Backend sends `environment: "production"` in signedChallenge
- Frontend does NOT pass `environment` to IDKit.request()
- SDK defaults to "production" if not specified

**Test Needed**:
Check if explicit `environment: "production"` parameter changes behavior.

**Risk**: LOW - SDK defaults to production

### Hypothesis 2: RP Activation State

**Observation**:
- Portal shows "App in review"
- No environment/active flag visible
- One historical proof exists (RP has been used before)

**Possible Issue**:
RP may require activation/approval even with correct public key registered.

**Test Needed**:
Verify RP status in portal (active/inactive/pending)

**Risk**: MEDIUM - App status may affect RP availability

### Hypothesis 3: App-RP Binding

**Observation**:
- App ID and RP ID shown together in portal
- No explicit binding status shown

**Possible Issue**:
App-RP binding may not be active even though both are registered.

**Test Needed**:
Verify app_id ↔ rp_id binding status in portal

**Risk**: MEDIUM - Binding may require approval

### Hypothesis 4: Action Registration

**Observation**:
- Action "openclaw-verify" exists with one historical proof
- No action registration UI visible in portal

**Possible Issue**:
Action may need explicit registration or may have been disabled.

**Test Needed**:
Verify action is active for this RP

**Risk**: LOW - Historical proof proves action worked before

### Hypothesis 5: SDK Version Compatibility

**Observation**:
- Using @worldcoin/idkit-server@1.2.0
- Using @worldcoin/idkit-core@4.6.0
- Protocol: World ID v4

**Possible Issue**:
Version mismatch or deprecated signature format.

**Test Needed**:
Check if signature format changed between SDK versions.

**Risk**: LOW - Using current SDK versions

### Hypothesis 6: Portal Environment vs Runtime Environment

**Observation**:
- Runtime config: `environment: "production"`
- Portal shows no environment flag
- RP may be registered in staging only

**Possible Issue**:
RP registered in staging but runtime using production.

**Test Needed**:
1. Try `environment: "staging"` in IDKit.request()
2. Check portal for staging vs production RP registration

**Risk**: MEDIUM - Environment mismatch would explain signature rejection

## Recommended Next Steps

### 1. Explicit Environment Parameter Test

**Action**: Modify enrollment.html to explicitly pass `environment`:

```javascript
const request = await IDKit.request({
  app_id: session.appId,
  action: session.signedChallenge.action,
  rp_context: rp_context,
  allow_legacy_proofs: true,
  environment: 'production'  // ← ADD THIS
}).preset(proofOfHuman({ signal: session.signal }));
```

**Expected Outcome**: If this fixes the issue, environment was the problem.

### 2. Portal Status Verification

**Action**: Bob checks portal for:
- RP activation status (active/inactive/pending)
- App-RP binding status
- Environment scope (production/staging/both)
- Action registration status

**Expected Outcome**: Identify if RP requires activation beyond registration.

### 3. Staging Environment Test

**Action**: Try `environment: 'staging'` in request:

```javascript
environment: 'staging'
```

**Expected Outcome**: If this works, RP is registered in staging, not production.

### 4. Direct SDK Test

**Action**: Create minimal reproduction test that:
1. Uses actual production RP ID and app ID
2. Uses actual production signing key
3. Generates signature
4. Constructs IDKit.request() with all parameters
5. Inspects generated connectorURI

**Expected Outcome**: Identify if issue is in request construction or signature validation.

## Current Status

**Code**: ✅ VERIFIED CORRECT  
**Keys**: ✅ MATCH PORTAL  
**Config**: ✅ CORRECT  
**Blocker**: Unknown portal state (activation/binding/environment)

## Unknowns

1. RP activation status (beyond registration)
2. App-RP binding activation status
3. Environment scope of RP registration
4. Whether "App in review" blocks RP signature validation
5. Whether action requires separate activation

**No code fix can be provided until unknowns resolved.**

If all portal states are confirmed correct, defect may be in World App validation logic itself.
