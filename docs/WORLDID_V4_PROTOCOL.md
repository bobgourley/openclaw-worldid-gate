# World ID v4 Protocol Implementation Notes

This document records authentic World ID v4 protocol details discovered from official SDK source (`@worldcoin/idkit-core@4.6.0` and `@worldcoin/idkit-server@1.2.0`).

## Uniqueness Proofs vs Sessions

### Uniqueness Proofs (Action-Based)
- **Purpose**: One-time verification per action (e.g., "claim reward", "vote on proposal", "enroll user")
- **Action field**: Required; arbitrary string or ABI-encoded value provided at request time
- **Action semantics**: Not configured/created in Developer Portal. Portal only manages App ID and RP ID. The `action` parameter is signed into the RP challenge context and becomes part of nullifier derivation, ensuring per-action isolation.
- **Nullifier**: RP-scoped, unique per (credential, action) pair
- **Response includes**: `action`, `nullifier` (string)
- **Our integration uses this mode**: Telegram members prove unique humanity per enrollment

### Session Proofs (Action-Free)
- **Purpose**: Recurring authentication (same person returning)
- **Action field**: Absent (no action in request or response)
- **Session nullifier**: Array `[session_nullifier, generated_action]`
- **Response includes**: `session_id` instead of `action`
- **Not used in this integration**

## Signal Hashing

The SDK uses **Keccak256 + field reduction**, NOT plain SHA-256.

### Implementation (from @worldcoin/idkit-core/dist/hashing.js)

```typescript
function hashToField(input: Uint8Array): Uint8Array {
  const hash = BigInt('0x' + bytesToHex(keccak_256(input))) >> 8n;
  return hexToBytes(hash.toString(16).padStart(64, '0'));
}

function hashSignal(signal: string | Uint8Array): string {
  let input;
  if (signal instanceof Uint8Array) {
    input = signal;
  } else if (signal.startsWith('0x') && isValidHex(signal.slice(2))) {
    input = hexToBytes(signal.slice(2)); // Hex strings decode to bytes
  } else {
    input = encodeUtf8(signal);  // UTF-8 encoding for regular strings
  }
  return '0x' + bytesToHex(hashToField(input));
}
```

**Key points:**
- Keccak256 hash (not SHA-256)
- Right-shift by 8 bits (`>> 8n`) for field reduction
- Returns 0x-prefixed 64-character hex string
- UTF-8 encoding for string signals

## RP Challenge Signing

From `@worldcoin/idkit-server`:

### signRequest API

```typescript
interface RpSignature {
  sig: string;         // 65-byte ECDSA signature (0x-prefixed hex)
  nonce: string;       // 32-byte nonce (0x-prefixed hex)
  createdAt: number;   // Unix seconds
  expiresAt: number;   // Unix seconds
}

function signRequest({ signingKeyHex, action?, ttl? }): RpSignature
```

### Signed Message Format

```
version(1 byte) || nonce(32 bytes) || createdAt(8 bytes BE) || expiresAt(8 bytes BE) || [action_hash(32 bytes)]
```

- Version: Always `0x01`
- Nonce: 32-byte cryptographically secure random value, hashed to field
- createdAt/expiresAt: Unix timestamps (seconds), encoded as 8-byte big-endian
- Action hash: Appended only for uniqueness proofs (omitted for sessions)
- Signing: Ethereum EIP-191 message signing (`\x19Ethereum Signed Message:\n<len>`)
- Recovery: 65-byte signature includes recovery byte (v) at offset 64

### RpContext Structure

The signed challenge returned to the client:

```typescript
type RpContext = {
  rp_id: string;        // e.g., "rp_223416a2a76673a1"
  nonce: string;        // 0x-prefixed hex from RpSignature.nonce
  created_at: number;   // RpSignature.createdAt
  expires_at: number;   // RpSignature.expiresAt
  signature: string;    // RpSignature.sig
};
```

## Integration Configuration

### Bob's World ID Setup
- **App ID**: `app_b466e1f63a70a695b6d990d261e31b6a`
- **RP ID**: `rp_223416a2a76673a1`
- **Signing key**: Retained by Bob (not stored in repository)
- **Portal status**: External integration selected, verification sidebar shows listing/review wizard, App URL placeholder is `docs.world.org`, submission not yet authorized

### Runtime Configuration Model
These identifiers are not hardcoded into generic defaults. They must be provided via runtime configuration (environment variables or secure secret management) at service startup.

**Environment variables (example):**
```bash
WORLDID_APP_ID=app_b466e1f63a70a695b6d990d261e31b6a
WORLDID_RP_ID=rp_223416a2a76673a1
WORLDID_SIGNING_KEY_HEX=<Bob's 32-byte ECDSA private key hex>
WORLDID_ENVIRONMENT=production
```

## Security Boundaries

1. **Signing key exposure**: NEVER expose the RP signing key to clients or version control. For tests, use throwaway test keys. For production, load from secure secret management (e.g., Kubernetes secrets, HashiCorp Vault, AWS Secrets Manager).

2. **Signal binding**: The signal (e.g., Telegram user ID) is hashed client-side and server-side. The client submits the plaintext signal to World App, which hashes it and includes the hash in the proof. The server must verify that the proof's `signal_hash` matches the expected hash of the bound signal.

3. **Action isolation**: Each action generates a distinct nullifier. Using different action strings (e.g., `enroll-telegram-user-123` vs `enroll-telegram-user-456`) creates separate nullifier spaces, preventing cross-action replay. For global enrollment (one unique human across all Telegram users), use a constant action string (e.g., `telegram-human-verification`).

## Verification Flow

1. **Challenge creation** (server):
   - Generate random nonce (32 bytes)
   - Hash signal with `hashSignal()`
   - Sign RP context with `signRequest({ signingKeyHex, action, ttl })`
   - Store challenge session: `{ nonce, telegramUserId, action, signalHash, expiresAt }`
   - Return signed challenge to client

2. **Proof generation** (client → World App):
   - Client submits signed challenge to World App via deep link/QR
   - World App validates RP signature
   - User approves in World App
   - World App generates zero-knowledge proof with bound signal
   - Proof includes: nonce, action, signal_hash, nullifier, credential proof

3. **Proof verification** (server):
   - Lookup challenge session by nonce
   - Validate requester binding (authenticated Telegram user ID matches stored `telegramUserId`)
   - Verify proof via Developer Portal API with expected context:
     - `action` matches stored challenge action
     - `nonce` matches stored challenge nonce
     - `signal_hash` matches stored challenge signal hash
   - Verify proof age (Developer Portal API includes proof timestamp)
   - Check nullifier uniqueness (not previously enrolled for this action)
   - Atomic transaction:
     - Consume challenge session (delete)
     - Create enrollment record (`nullifier`, `action`, `telegramUserId`, `enrolledAt`)
   - Challenge preserved on verification failure (retry allowed until TTL expires)

## Developer Portal API

**Endpoint**: `https://developer.worldcoin.org/api/v2/verify/{app_id}`

**Request**:
```json
{
  "action": "telegram-human-verification",
  "nullifier_hash": "nil_<64-hex>",
  "merkle_root": "0x<64-hex>",
  "proof": "0x<long-hex>",
  "credential_type": "proof_of_human",
  "signal_hash": "0x<64-hex>"
}
```

**Response (success)**:
```json
{
  "success": true,
  "action": "telegram-human-verification",
  "nullifier_hash": "nil_<64-hex>",
  "created_at": "2026-11-07T03:44:00.000Z",
  "credential_type": "proof_of_human"
}
```

**Response (failure)**:
```json
{
  "success": false,
  "code": "invalid_proof",
  "detail": "Proof verification failed",
  "attribute": null
}
```

## Testing Strategy

1. **Unit tests**: Use throwaway test keys, never live credentials
2. **Signal hashing tests**: Validate deterministic Keccak256 + field reduction
3. **Challenge structure tests**: Verify 65-byte signature, 32-byte nonce, timestamp bounds
4. **Expiry tests**: Inject clock for deterministic expiry validation
5. **Integration tests**: Mock Developer Portal API, test full verification flow with simulated proofs
6. **Cross-connection race tests**: Concurrent challenge consumption attempts (SQLite transaction isolation)
7. **Fault injection tests**: Network timeouts, malformed API responses, signature validation failures

## References

- Official SDK packages:
  - `@worldcoin/idkit-core@4.6.0`
  - `@worldcoin/idkit-server@1.2.0`
- Developer Portal: https://developer.worldcoin.org/
- Documentation: https://docs.world.org/
- This integration: `/workspace/src/worldid-challenge-adapter.ts`
