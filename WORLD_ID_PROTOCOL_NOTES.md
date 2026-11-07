# World ID v4 Protocol Notes

## Security Implementation Status

### ✅ Implemented Server-Side Verification Safeguards

1. **Server-Trusted Expected Context Validation**
   - `ExpectedVerificationContext` parameter required for `verify()` call
   - Validates `action` matches server's expected challenge session
   - Validates `nonce` matches server's expected challenge session (bound to short-lived session)
   - Validates `signal_hash` matches expected value when provided (bound to requester identity/context)
   - Prevents replay and context substitution attacks

2. **Strict Boolean Success Check**
   - Requires exact `verification.success === true` (strict boolean equality)
   - Rejects truthy non-boolean values like `1` or `"true"`

3. **Credential Requirement Enforcement**
   - `requireProofOfHuman: true` (default) enforces `proof_of_human` credential (`issuer_schema_id: 1`)
   - Rejects weaker `selfie` credentials (`issuer_schema_id: 11`) unless explicitly permitted
   - Backend controls acceptable credential types, not client

4. **Unambiguous Single Credential Policy**
   - Rejects ambiguous multi-response batches (`responses.length > 1`)
   - Fails closed on unrecognized batch patterns
   - Only accepts explicit single credential from proof request

5. **Bounded Timeout Through Body Consumption**
   - Timeout wraps both `fetch()` and `response.json()` calls
   - Timer cleared in `finally` block after complete JSON parsing
   - Prevents timeout bypass via slow body streaming

6. **Malformed Input Validation**
   - Config validation in constructor (rpId prefix, environment)
   - JSON parse error handling with descriptive messages
   - Protocol version enforcement (v4.0 only)
   - Response field validation (nullifier, issuer_schema_id)

### ✅ Telegram initData Validation Safeguards

1. **Duplicate Query Key Rejection**
   - Detects duplicate keys in raw query string before parsing
   - Prevents parameter pollution attacks
   - Fails closed on ambiguous key-value pairs

2. **Clock Injection for Deterministic Testing**
   - Accepts optional `currentTime?: Date` parameter
   - Enables reproducible freshness boundary tests
   - Defaults to `Date.now()` in production

3. **Exact Freshness Boundary Validation**
   - `auth_date == now - maxAgeSeconds` passes (at boundary)
   - `auth_date == now - maxAgeSeconds - 1` fails (past boundary)
   - Future `auth_date` rejected immediately

4. **Strict HMAC Signature Validation**
   - Per official Telegram Bot API guidance: `secret_key = HMAC_SHA256("WebAppData", bot_token)`
   - Data check string: sorted `key=value` pairs joined with `\n` (excluding `hash`)
   - Timing-safe comparison with `timingSafeEqual`

## Protocol Research Findings

### Official Documentation References

From `https://docs.world.org/world-id/idkit/integrate.md`:
- External World ID app supplies `app_id`/`rp_id`/server `signing_key`
- `@worldcoin/idkit-core` 4.x `signRequest` supplies `rp_context` with `nonce`/`created_at`/`expires_at`/`signature`
- Preset `proofOfHuman({signal})` — server must enforce expected signal

From `https://docs.world.org/world-id/idkit/session-proofs.md`:
- **v4 uniqueness proofs are one-time per action**
- **Sessions are for recurring checks** (different verification contract)
- IDKit 4.4 session builders need constraints
- Legacy proofs not supported

From `https://docs.world.org/world-id/idkit/verification-flows.md`:
- World App uses deep link/bridge polling (not Telegram WebView)
- Mobile integration requires external browser flow
- **Telegram Mini App embedded verification not directly supported**

## Unresolved Integration Gaps

### 1. RP Configuration Prerequisites

**Current Implementation**: Starter requires `rpId` and `environment` config.

**Unresolved Questions**:
- No developer app/RP configured in World Developer Portal yet
- End users must verify using their existing World App (no developer account required for each member)
- Distinction between standalone World ID integration vs World Mini App listing unclear
- Mobile IDKit prerequisites for user-owned World Apps awaiting research

**Required Before Production**:
- Document RP onboarding process for Bob's specific use case (personal World App, no team developer accounts)
- Clarify if RP configuration is per-bot or per-community
- Define signal binding strategy (Telegram user ID? Community ID? Session token?)

### 2. Session-Based Repeated Verification

**Current Implementation**: Single one-time proof verification.

**Protocol Constraint**: v4 uniqueness proofs are **one-time per action**. Sessions use a different verification contract.

**Unresolved Design**:
- Bob's 30-day configurable admission expiry remains as business requirement
- **Cannot promise 30-day repeated action renewal without supporting session-proof protocol design**
- If sessions require different verifier contract than one-time proofs, must document unresolved renewal integration
- IDKit 4.4 session builders need constraints — implementation pending protocol research

**Required Before Production**:
- Research IDKit 4.x session-proof builder API
- Design session-based recurring verification flow (if available)
- OR accept one-time-only admission + manual re-verification UX (no silent 30-day renewal)
- Document exact protocol path for recurring checks

### 3. Telegram WebView UX Limitations

**Current Implementation**: Abstract verification service, no UI.

**Protocol Constraint**: World App verification uses deep link/bridge polling, not embedded Telegram WebView.

**Unresolved UX Flow**:
- Future UI must have resumable server challenge
- Requires external browser fallback (user leaves Telegram Mini App)
- Cannot claim "embedded Telegram verified" without proper deep link → callback flow
- Polling/webhook mechanism for verification completion TBD

**Required Before Production**:
- Design external browser → Telegram callback flow
- Implement challenge session persistence (user may return minutes later)
- Handle partial verification states (user starts verification but doesn't complete)
- Test mobile deep linking on iOS/Android

### 4. Action/Nonce/Signal Binding Strategy

**Current Implementation**: Server supplies `expectedContext` with `action`, `nonce`, `signalHash`.

**Unresolved Strategy**:
- What action string to use? (e.g., `"openclaw-admission"`, `"telegram-{chat_id}"`, per-community?)
- Nonce generation/storage: short-lived challenge sessions (how long? 5 minutes? 1 hour?)
- Signal binding: what uniquely identifies requester context?
  - Telegram user ID? (public, not secret)
  - Ephemeral session token? (must track server-side)
  - Community/chat ID? (shared across users)
- Official docs say "server must enforce expected signal" but exact binding semantics TBD

**Required Before Production**:
- Define action string naming convention
- Design nonce lifecycle (generation, storage, expiration, cleanup)
- Choose signal binding strategy based on threat model
- Document exact expected context construction for each verification type

## Testing Coverage

### Security Edge Cases Verified

**World ID Client**:
- ✅ Action mismatch rejection
- ✅ Nonce mismatch rejection
- ✅ Signal hash mismatch rejection
- ✅ Ambiguous multi-response batch rejection
- ✅ Truthy non-boolean success rejection
- ✅ Weak/selfie credential rejection when `requireProofOfHuman: true`
- ✅ Timeout during response body read
- ✅ Malformed JSON response
- ✅ Missing/invalid nullifier in request
- ✅ Missing/invalid issuer_schema_id in request
- ✅ Environment mismatch (request vs config, response vs config)
- ✅ Unsupported protocol version
- ✅ Empty responses array
- ✅ Developer Portal HTTP error responses
- ✅ Network timeout with abort signal

**Telegram initData Validator**:
- ✅ Duplicate query key rejection
- ✅ Exact freshness boundary (`auth_date == now - maxAgeSeconds`)
- ✅ Just-past-boundary rejection (`auth_date == now - maxAgeSeconds - 1`)
- ✅ Future auth_date rejection
- ✅ Clock injection for deterministic testing
- ✅ Invalid HMAC signature rejection
- ✅ Missing/invalid required fields
- ✅ Malformed user JSON
- ✅ Custom maxAgeSeconds enforcement

## Limitations and Warnings

### Cannot Claim Without Implementation Evidence

❌ **"Action/nonce/signal binding validated"** — Code now validates against `expectedContext`, but actual binding strategy undefined (see Unresolved Gap #4)

❌ **"Security complete"** — Core validation hardened, but protocol integration gaps remain (session renewal, RP onboarding, mobile UX)

❌ **"Embedded Telegram verification"** — Protocol uses external browser flow, not WebView embedding

❌ **"30-day automatic renewal"** — One-time proofs only; session-proof integration unresolved

### Safe to Claim With Current Implementation

✅ **"Server-trusted context validation"** — `ExpectedVerificationContext` parameter enforces server-supplied expectations

✅ **"Strict credential requirement enforcement"** — Only `proof_of_human` (schema 1) grants admission by default

✅ **"Fail-closed on ambiguous batches"** — Multi-response arrays rejected

✅ **"Bounded timeout through body consumption"** — Timer wraps full fetch + JSON parse lifecycle

✅ **"Duplicate key rejection"** — Telegram initData parser detects parameter pollution

✅ **"Exact freshness boundary tests"** — Clock-injected deterministic testing validates edge cases

## Next Steps

1. **RP Onboarding Research** (Bob + separate research thread)
   - Personal World App verification flow without developer accounts
   - Signal binding strategy selection
   - Action string naming convention

2. **Session-Proof Protocol Research** (if recurring verification required)
   - IDKit 4.4 session builder constraints
   - Session-proof verification contract differences vs one-time proofs
   - Expiration and renewal mechanics

3. **Mobile UX Design** (when UI work begins)
   - External browser → Telegram callback flow
   - Challenge session persistence
   - Partial verification state handling

4. **HTTP Service Integration** (next run, after bounded repair complete)
   - SQLite enrollment store
   - Challenge session management
   - Webhook/polling for external verification completion
   - Admission gate HTTP endpoint

## References

- **Official Docs**: https://docs.world.org/world-id/
- **IDKit Integration**: https://docs.world.org/world-id/idkit/integrate.md
- **Session Proofs**: https://docs.world.org/world-id/idkit/session-proofs.md
- **Verification Flows**: https://docs.world.org/world-id/idkit/verification-flows.md
- **Developer Portal API**: https://docs.world.org/api-reference/developer-portal/verify
- **Telegram Mini App Validation**: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
