# RP Signature Investigation - Honest Status

## What Is PROVEN

### ✅ Cryptographic Correctness
- Signature mathematically valid (ECDSA recovery succeeds)
- Public key recovery matches expected key
- Message format canonical (v1 || nonce || timestamps || action_hash)
- Action hash correctly computed
- All mutations properly detected

### ✅ Key Registration Match
**Portal**: `0x7576AEFb7d97d641EA1626B7fcB3d574a9c4BefD`  
**Runtime**: `0x7576aefb7d97d641ea1626b7fcb3d574a9c4befd`  
**Status**: EXACT MATCH (case-insensitive)

### ✅ Field Mappings
- Backend rpSignature fields correctly mapped to signedChallenge
- Frontend signedChallenge fields correctly mapped to rp_context
- All types match IDKit RpContext interface

### ✅ SDK Version Compatibility
- @worldcoin/idkit-server@1.2.0 (backend)
- @worldcoin/idkit-core@4.6.0 (frontend)
- Both current, protocol v4 compatible

### ✅ Runtime Configuration
- Process confirmed (PID 53898, started 2:44:16 PM EST)
- Release 4d2ee41, Node 24.19.0
- Config values match expected (app/RP/action/environment)
- Time synchronized (sntp offset +0.034823s)

### ✅ Environment Parameter Behavior
**Independent verification**: Adding explicit `environment: "production"` is a **NO-OP**
- SDK normalizes omitted environment → "production"
- Both omitted and explicit produce identical payloads
- Both produce identical connect URLs (world.org)
- Only difference: random proof_request.id

## What Is NOT PROVEN

### ❌ My "Fix" Claim - REJECTED
**Claim**: Adding `environment: "production"` parameter fixes issue  
**Reality**: No-op, SDK already defaults to production  
**Evidence**: Independent offline IDKit.request() execution showed identical behavior

### ❌ My Serialization Test - INVALID
**Claim**: `test-idkit-request-serialization.js` proves serialization  
**Reality**: Hand-built objects, never executed IDKit.request()  
**Evidence**: Test does not import or run SDK, only validates object structure

### ❌ Root Cause - UNKNOWN
Portal shows:
- RP registered with matching public key
- App ID and RP ID exist together
- Action "openclaw-legacy" exists (1 historical proof)
- "App in review" status (Bob says does NOT prove RP invalid)

Error occurs:
- User sees "invalid_rp_signature" in World App
- Happens BEFORE backend callback (no proof submission observed)
- Challenge created successfully, within TTL

**Gap**: Unknown why World App rejects signature despite all verifications passing

## What Was WRONG With My Investigation

1. **Premature "fix" claim**: Proposed environment parameter without proving SDK behavior
2. **Invalid test**: Serialization test didn't execute actual SDK code
3. **Speculation as fact**: Claimed fix would work without behavioral proof
4. **Ignored my own documentation**: My report said SDK defaults to production, then proposed adding explicit production

## Honest Unknowns

### Portal State Unknowns
1. **RP Activation**: Is RP "active" vs just "registered"?
2. **App-RP Binding**: Is binding active or pending?
3. **Environment Scope**: Is RP available in production, staging, or both?
4. **Action State**: Is action "openclaw-legacy" active or disabled?
5. **Review Status**: Does "App in review" block RP signature validation?

### Technical Unknowns
1. **Signature Validation Path**: What exact validation does World App perform?
2. **RP Lookup**: How does World App resolve RP ID to public key?
3. **Environment Handling**: Does World App enforce environment restrictions?
4. **Error Timing**: Why does validation fail before proof generation?

### SDK Behavior Unknowns
1. **Request Encoding**: What exact bytes are sent in connect URL?
2. **Protocol Version**: Is there a v4 protocol version field?
3. **Validation Requirements**: What fields must match between RP context and portal?

## Discriminating Tests Needed

To identify root cause, need tests that:

### 1. Portal State Verification
- Query RP activation status (not just registration)
- Query app-RP binding status
- Query action activation status
- Query environment scope

### 2. Connect URL Inspection
Extract and decode actual connectorURI parameters:
- What exact RP context is encoded?
- Is environment embedded in URL?
- Are there validation tokens?

### 3. World App Communication
Capture actual World App ↔ bridge communication:
- What does World App send for validation?
- What response indicates signature rejection?
- Is error from World App or bridge server?

### 4. Minimal Reproduction
Create minimal test that:
- Uses actual production RP/app IDs
- Generates real signature
- Creates real IDKit.request()
- Captures exact failure point

### 5. Comparative Test
If possible, test with:
- Different action (if another action exists)
- Staging environment (force staging)
- Different app (if accessible)

## Next Investigation Paths

### Path 1: Decode Connect URL
```javascript
// Extract and parse actual connectorURI
const url = new URL(request.connectorURI);
// Decode base64-encoded key/data
// Inspect what RP context is actually transmitted
```

### Path 2: Bridge Server Logs
- World App connects to bridge server (world.org or custom)
- Bridge validates RP signature
- Logs would show exact validation failure

### Path 3: Portal API Query
If portal has API:
- Query RP status programmatically
- Verify activation state
- Check environment scope

### Path 4: SDK Source Inspection
Review @worldcoin/idkit-core source:
- How is rp_context encoded?
- What validation happens client-side?
- Are there hidden requirements?

### Path 5: Action Verification
- How are actions registered?
- Do they require approval?
- Can they be disabled?

## What I Should NOT Do Again

1. ❌ Claim a "fix" without proving behavioral change
2. ❌ Create tests that don't execute actual SDK code
3. ❌ Propose changes based on speculation
4. ❌ Deliver "patches" that are explanatory markdown, not applicable diffs
5. ❌ Claim completion when root cause is unknown

## Current Stance

**Code**: All verification tests pass  
**Keys**: Match portal registration  
**Config**: Correct values confirmed  
**Environment**: Proven no-op  
**Root Cause**: **UNKNOWN**

The defect is NOT in:
- Signature generation
- Cryptographic correctness
- Field mapping
- Type compatibility

The defect IS in:
- Unknown portal state issue, OR
- Unknown SDK requirement, OR
- Unknown World App validation requirement, OR
- Unknown environment/activation restriction

**Cannot deliver a code fix until root cause is identified through discriminating investigation.**
