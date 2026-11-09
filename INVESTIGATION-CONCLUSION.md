# RP Signature Investigation - Conclusion

## Summary

After comprehensive investigation including cryptographic verification, transport analysis, SDK behavior testing, and runtime evidence correlation, **no code defect has been identified**.

## Verified Correct

✅ Signature generation (cryptographically valid)  
✅ Public key derivation (matches portal registration)  
✅ Message construction (canonical format)  
✅ Field mappings (backend → frontend → SDK)  
✅ Type compatibility (all interfaces match)  
✅ Runtime configuration (correct values deployed)  
✅ SDK version compatibility (current versions)  
✅ Environment handling (SDK defaults confirmed)

## Rejected Hypotheses

❌ **Key-RP mismatch**: Portal shows exact match  
❌ **Environment parameter**: Proven no-op by independent test  
❌ **Serialization error**: All fields correctly mapped  
❌ **Type mismatch**: All types match SDK interfaces  
❌ **Signature format**: Cryptographic verification passes  
❌ **Message construction**: Canonical format verified

## Root Cause: Unknown

World App rejects signature with `invalid_rp_signature` error despite all verification passing.

**Error occurs**:
- After user scans QR / opens World App
- Before proof generation
- Before backend callback
- Within valid TTL window

**Possible causes** (cannot verify without portal/World App access):

1. **RP Activation State**
   - RP may be registered but not activated
   - "App in review" may block signature validation
   - Requires portal state verification

2. **App-RP Binding**
   - Binding may exist but not be active
   - May require approval step
   - Cannot verify from portal UI

3. **Action Registration**
   - Action "openclaw-legacy" exists (1 historical proof)
   - May have been disabled or require re-activation
   - No action management UI visible

4. **Environment Restrictions**
   - RP may be scoped to staging only
   - Portal shows no environment flag
   - Cannot determine scope from UI

5. **Protocol Requirements**
   - World App may enforce requirements not visible in SDK
   - May require specific credential types
   - May have undocumented validation rules

## Investigation Limitations

**Cannot investigate further without**:
- Portal API access to query RP/app/action status
- World App debug logs showing validation failure
- Bridge server logs showing signature validation
- World developer support channel access

**Already exhausted**:
- Code review (no defects found)
- Cryptographic verification (passes)
- SDK behavior analysis (correct)
- Runtime evidence correlation (consistent)

## Recommendations for Bob

### 1. Verify Portal State
Check in Developer Portal:
- [ ] RP activation status (not just registration)
- [ ] App-RP binding activation status
- [ ] Action "openclaw-legacy" active status
- [ ] Environment scope (production/staging/both)
- [ ] Any pending approvals or required actions

### 2. Check App Review Status
"App in review" may affect:
- [ ] RP signature validation availability
- [ ] Action availability
- [ ] Production environment access

### 3. Test Alternative Configuration
If possible, test with:
- [ ] Different action (if one exists and is active)
- [ ] Staging environment (if RP available there)
- [ ] Test app/RP (if available)

### 4. Contact World Support
If all portal checks pass, may be:
- World App validation bug
- Undocumented requirement
- Protocol version issue

Provide:
- App ID: `app_staging_0123456789abcdef0123456789ab`
- RP ID: `rp_0123456789abcdef`
- Action: `openclaw-legacy`
- Error: `invalid_rp_signature`
- Evidence: Signature cryptographically valid, keys match registration

## Deliverables

**Verification Tests**:
- `test-rp-signature-cryptographic.js` - Full crypto verification
- `test-rp-signature-canonical.js` - Format verification
- `test-idkit-request-serialization.js` - Field mapping verification

**Analysis Documents**:
- `SIGNATURE-INVESTIGATION-STATUS.md` - Honest status with unknowns
- `SIGNATURE-TRANSPORT-ANALYSIS.md` - Complete transport analysis
- `SIGNATURE-DEFECT-HYPOTHESIS.md` - All hypotheses explored

**Safe Error Display v3** (Separate, Approved):
- `worldid-gate-safe-errors-v3.tar.gz`
- SHA256: `ad72107fd4f9b57dd96ceccea2de8e0f3337536b03558add0973c97259dd624f`
- Status: Independently verified and deployed

## Final Status

**Code**: ✅ Verified correct, no changes needed  
**Root Cause**: ❓ Unknown, requires portal/World App visibility  
**Next Step**: Portal state verification by owner  
**Blocker**: Cannot fix code when code is not the defect

**No code changes can be delivered until root cause is identified through portal investigation or World developer support.**
