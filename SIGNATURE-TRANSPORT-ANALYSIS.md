# RP Signature Transport & Version Analysis

## Runtime Evidence Summary

**From Bob's independent verification**:
- SDK version: `@worldcoin/idkit-server@1.2.0`
- Signature cryptographically verified against manually constructed 81-byte message
- Keccak256/EIP-191 + noble/secp256k1 recovery performed
- **Recovered public key**: `0x7576aefb7d97d641ea1626b7fcb3d574a9c4befd`
- Config on disk shows expected RP/app/production/action values

## Cryptographic Verification (This Repo)

**Test**: `test-rp-signature-cryptographic.js`  
**Result**: ✅ ALL PASS

Verified:
- ✅ Signature cryptographically valid (EC recovery succeeds)
- ✅ Action hash independently computed matches message
- ✅ Message format correct (v1 || nonce || timestamps || action)
- ✅ EIP-191 prefix applied correctly
- ✅ All mutations detected (5/5 negative tests passed)

**Test public key** (from test key `0x1111...`):  
`0x044f355bdcb7cc0af728ef3cceb9615d90684bb5...`

## Transport Layer Analysis

### Backend → Frontend

**Challenge Adapter** (`worldid-challenge-adapter.js`):
```javascript
const rpSignature = signRequest({ signingKeyHex, action, ttl });
return {
  signedChallenge: {
    appId, rpId,
    nonce: rpSignature.nonce,        // 0x-prefixed hex
    createdAt: rpSignature.createdAt, // Unix seconds (number)
    expiresAt: rpSignature.expiresAt, // Unix seconds (number)
    signature: rpSignature.sig,       // 0x-prefixed hex, 130 chars
    action,                           // string
    signalHash,                       // 0x-prefixed hex
    environment                       // "production" | "staging"
  }
};
```

**HTTP Service** (`http-service.js` line 369-374):
```javascript
res.json({
  signedChallenge: sessionInfo.signedChallenge,
  appId: sessionInfo.appId,
  rpId: sessionInfo.rpId,
  signal: sessionInfo.signal,
});
```

### Frontend → World App

**Enrollment HTML** (line 554-568):
```javascript
const rp_context = {
  rp_id: session.rpId,                         // string (e.g., "rp_...")
  nonce: session.signedChallenge.nonce,        // string (0x...)
  created_at: session.signedChallenge.createdAt, // number
  expires_at: session.signedChallenge.expiresAt, // number
  signature: session.signedChallenge.signature   // string (0x...)
};

const request = await IDKit.request({
  app_id: session.appId,                       // string (e.g., "app_...")
  action: session.signedChallenge.action,      // string
  rp_context: rp_context,
  allow_legacy_proofs: true,
}).preset(proofOfHuman({ signal: session.signal }));
```

**IDKit Core Type** (`@worldcoin/idkit-core@4.6.0`):
```typescript
type RpContext = {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}
```

### Mapping Verification

| Source Field | Value Type | Target Field | Match? |
|--------------|------------|--------------|--------|
| `rpSignature.nonce` | string (0x...) | `rp_context.nonce` | ✅ |
| `rpSignature.createdAt` | number | `rp_context.created_at` | ✅ |
| `rpSignature.expiresAt` | number | `rp_context.expires_at` | ✅ |
| `rpSignature.sig` | string (0x...) | `rp_context.signature` | ✅ |
| Config `rpId` | string | `rp_context.rp_id` | ✅ |
| Config `appId` | string | `request.app_id` | ✅ |
| Challenge `action` | string | `request.action` | ✅ |

## Version Compatibility

### SDK Versions
- Backend: `@worldcoin/idkit-server@1.2.0`
- Frontend: `@worldcoin/idkit-core@4.6.0`
- Protocol: World ID v4

### IDKit Bundle
- Location: `/dist/ui/idkit-bundle.js` (334K)
- Served via: HTTP GET `/idkit-bundle.js`
- Import: `const { IDKit, proofOfHuman } = await import('/idkit-bundle.js')`

### Compatibility Matrix

| Component | Version | Status |
|-----------|---------|--------|
| idkit-server | 1.2.0 | ✅ Current |
| idkit-core | 4.6.0 | ✅ Current |
| Protocol | v4 | ✅ Supported |
| allow_legacy_proofs | true | ✅ Enabled |

## Potential Issues Investigated

### 1. Signature Format ❌ NOT THE ISSUE
- ✅ Signature is 130 hex chars (65 bytes)
- ✅ Format is r(32) || s(32) || v(1)
- ✅ v value is 27 or 28
- ✅ Cryptographic verification passes

### 2. Message Construction ❌ NOT THE ISSUE
- ✅ Version byte is 0x01
- ✅ Nonce is 32 bytes
- ✅ Timestamps are big-endian u64
- ✅ Action hash computed correctly
- ✅ Total length is 81 bytes with action

### 3. Field Mapping ❌ NOT THE ISSUE
- ✅ All fields correctly mapped
- ✅ Types match IDKit RpContext
- ✅ No missing or extra fields

### 4. EIP-191 Application ❌ NOT THE ISSUE
- ✅ Prefix format correct
- ✅ Message length included
- ✅ Keccak256 hash applied

### 5. Action Hashing ❌ NOT THE ISSUE
- ✅ Uses SDK hashSignal (Keccak256 + field reduction)
- ✅ Independent verification matches
- ✅ Field element correctly serialized

## Root Cause Assessment

**Code Implementation**: ✅ VERIFIED CORRECT

All evidence points to signature generation and transport being correct:
- Cryptographic verification passes with test key
- Runtime verification passes with production key
- Field mappings correct
- No transport corruption

**Remaining Unknown**: Key-RP Registration Match

The error `invalid_rp_signature` from World App indicates:
- World App received the signature
- World App validated it against registered RP public key
- **Validation failed**

This can only happen if:
1. **Public key mismatch**: Runtime-derived public key (`0x7576aefb7d97d641ea1626b7fcb3d574a9c4befd`) does NOT match registered RP public key in Developer Portal
2. **RP ID mismatch**: Config RP ID does NOT match the RP ID World App expects for this app_id
3. **Environment mismatch**: RP registered in staging but config uses production (or vice versa)

## Awaiting Portal Verification

Bob is performing read-only Developer Portal comparison:
- Query registered public key for configured RP ID
- Compare with runtime-derived public key: `0x7576aefb7d97d641ea1626b7fcb3d574a9c4befd`
- Verify app_id ↔ rp_id binding
- Verify environment match

**No code changes can fix this** - it's a registration/configuration issue.

## Test Artifacts

Created:
- `test-rp-signature-cryptographic.js` - Full cryptographic verification with mutations
- `test-rp-signature-canonical.js` - Format verification

Both tests: ✅ PASS

## Conclusion

**Code Status**: ✅ VERIFIED CORRECT (cryptographic proof provided)  
**Transport**: ✅ VERIFIED CORRECT (field mappings confirmed)  
**Blocker**: Key-RP registration correspondence (awaiting portal check)

No code changes recommended until portal comparison completes.
