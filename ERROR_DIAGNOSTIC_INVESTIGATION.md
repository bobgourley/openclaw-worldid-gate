# Error Diagnostic Investigation: "World App verification failed. Please try again."

## Timeline Context (Bob's Trial)
- **12:57:10**: User revoked previous enrollment
- **12:57:22**: Fresh challenge created, expiry **1:02:22** (5-minute window)
- **1:00**: First World App failure attempt (within expiry window)
- **1:06**: Second World App failure attempt (4 minutes after expiry)
- **1:09 PM ET**: Screenshot showing red banner "World App verification failed. Please try again."
- **No server logs**: Cannot confirm if callback arrived or what server-side error occurred

## Error Propagation Path Analysis

### Current Code Flow

#### 1. IDKit Polling (`dist/ui/enrollment.html` lines 559-568)

```javascript
const result = await request.pollUntilCompletion({
  pollInterval: 2000,
  timeout: 300000, // 5 minutes
});

if (result.success) {
  await handleProofReceived(result.result);
} else {
  handleProofError(result.error);
}
```

**Type**: `IDKitCompletionResult`
```typescript
type IDKitCompletionResult = {
    success: true;
    result: IDKitResult;
} | {
    success: false;
    error: IDKitErrorCodes;  // <-- JUST A STRING ERROR CODE
};
```

#### 2. Error Handler (`dist/ui/enrollment.html` lines 611-630)

```javascript
function handleProofError(errorCode) {
  console.error('World App error:', errorCode);
  let message = 'World App verification failed. Please try again.';
  
  // Map specific error codes to user-friendly messages
  if (errorCode === 'user_rejected') {
    message = 'Verification was cancelled. Please try again when ready.';
  } else if (errorCode === 'verification_rejected') {
    message = 'Verification was rejected by World App. Please try again.';
  } else if (errorCode === 'credential_unavailable') {
    message = 'Required World ID credential is not available. Please verify your account in World App.';
  } else if (errorCode === 'connection_failed') {
    message = 'Connection to World App failed. Please check your connection and try again.';
  } else if (errorCode === 'timeout') {
    message = 'Verification timed out. Please try again.';
  }
  
  showError(message);
  buttonEl.disabled = false;
}
```

### Information Currently Discarded

**IDKit SDK Error Codes** (from `@worldcoin/idkit-core` v4.6.0):

Complete enum from `node_modules/@worldcoin/idkit-core/dist/index.d.ts` line 272:

```typescript
type IDKitErrorCode = 
  | "user_rejected"                    // User cancelled in World App
  | "verification_rejected"            // World App rejected verification
  | "credential_unavailable"           // User doesn't have required credential
  | "feature_unavailable"              // Feature not available
  | "world_id_4_not_available"         // v4 not available
  | "world_id_3_not_available"         // v3 not available
  | "malformed_request"                // Request format error
  | "invalid_network"                  // Network mismatch
  | "inclusion_proof_pending"          // Proof still pending
  | "inclusion_proof_failed"           // Proof generation failed
  | "unexpected_response"              // Unexpected response format
  | "connection_failed"                // Connection error
  | "max_verifications_reached"        // Rate limit hit
  | "failed_by_host_app"               // Host app failure
  | "user_presence_failed"             // User presence check failed
  | "invalid_rp_signature"             // RP signature validation failed  ⚠️
  | "nullifier_replayed"               // Nullifier already used          ⚠️
  | "duplicate_nonce"                  // Nonce already used               ⚠️
  | "unknown_rp"                       // RP not recognized
  | "inactive_rp"                      // RP is inactive
  | "timestamp_too_old"                // Timestamp expired                ⚠️
  | "timestamp_too_far_in_future"      // Timestamp too far ahead          ⚠️
  | "invalid_timestamp"                // Timestamp format error           ⚠️
  | "rp_signature_expired"             // RP signature expired             ⚠️
  | "identity_attributes_not_matched"  // Identity check failed
  | "generic_error";                   // Unspecified error                ⚠️
```

### What Bob's Screenshot Shows

**Visible**: Generic fallback message "World App verification failed. Please try again."

**This means** the actual `errorCode` was NOT one of the 5 handled cases:
- NOT `user_rejected`
- NOT `verification_rejected`
- NOT `credential_unavailable`
- NOT `connection_failed`
- NOT `timeout`

**Most likely candidates** for Bob's failure at 1:00 (within expiry) and 1:06 (after expiry):

1. **`rp_signature_expired`** - RP signature expired (challenge created 12:57:22, expiry 1:02:22)
   - 1:00 attempt: Within window, should NOT trigger this
   - 1:06 attempt: 4 minutes after expiry, WOULD trigger this

2. **`nullifier_replayed`** - Nullifier already used
   - If Bob completed verification before revoking, nullifier might be tracked by World App

3. **`invalid_rp_signature`** - RP signature validation failed
   - Signature computation or format issue

4. **`timestamp_too_old`** / `timestamp_too_far_in_future`** - Timestamp validation failed
   - Clock skew between client/server/World App

5. **`generic_error`** - Catchall error with no specific diagnostic

6. **`malformed_request`** - Request format issue

### Additional Diagnostic Data Available (Currently Unused)

**IDKit Debug Report** (`request.getDebugReport()`):

```typescript
type IDKitDebugReport = {
  version: 1;
  package_version: string;
  transport: "bridge" | "mini_app";
  generated_at: string;
  request_id?: string;
  request_payload?: object;
  response_payload?: object | string;  // Contains decrypted response
  mini_app?: MiniAppDebugInfo;
};
```

**Currently NOT captured** in `enrollment.html`. This could provide:
- Full encrypted response payload (after decryption)
- Request ID for correlation
- Transport type (bridge vs native)
- Timestamp of error

### Server-Side Error Handling

**Backend `/api/enrollment/complete` endpoint** currently returns structured errors:

```typescript
// Example from enrollment-service-production.ts
if (!verificationResult.success) {
  return {
    success: false,
    error: verificationResult.error || 'Verification failed'
  };
}
```

But **we cannot confirm** if Bob's World App even reached the completion endpoint, since:
- No server logs were provided
- Error might be client-side only (IDKit bridge/World App communication)
- Error might be World ID verification API rejection (before our backend)

## Gaps in Current Diagnostic Capability

### 1. **Unhandled Error Codes Display Generic Message**
   - 24 of 29 error codes show generic "World App verification failed" 
   - User and operator cannot distinguish:
     - Expired challenge
     - Nullifier replay
     - RP signature issues
     - Clock skew
     - Rate limiting

### 2. **No Client-Side Error Logging**
   - `console.error('World App error:', errorCode)` logs to browser console
   - Operator Bob cannot retrieve this without browser dev tools access
   - Error code not surfaced in any user-visible or server-retrievable way

### 3. **No Debug Report Capture**
   - `request.getDebugReport()` available but never called
   - Would provide request ID, timestamps, transport diagnostics

### 4. **No Server-Side Error Correlation**
   - If error occurs before backend `/complete` call, no server log exists
   - Cannot correlate client error with server-side session state
   - Cannot determine if proof was generated but rejected vs never generated

### 5. **No Retry Behavior Diagnosis**
   - Cannot tell if user retried with same session or new session
   - Cannot distinguish first attempt vs subsequent attempts
   - Cannot track if error persists across fresh challenges

## Proposed Minimal Privacy-Safe Diagnostic Improvements

### Option A: Enhanced User-Visible Error Messages (RECOMMENDED)

**Add mappings for common failure scenarios:**

```javascript
function handleProofError(errorCode) {
  console.error('World App error:', errorCode);
  
  let message = 'World App verification failed. Please try again.';
  let category = 'generic';  // Privacy-safe category for logging
  
  // User-initiated
  if (errorCode === 'user_rejected') {
    message = 'Verification was cancelled. Please try again when ready.';
    category = 'user_cancelled';
  } else if (errorCode === 'timeout') {
    message = 'Verification timed out. Please try again.';
    category = 'timeout';
  }
  
  // Credential/identity issues
  else if (errorCode === 'credential_unavailable') {
    message = 'Required World ID credential is not available. Please verify your account in World App.';
    category = 'credential';
  } else if (errorCode === 'verification_rejected') {
    message = 'Verification was rejected by World App. Please try again.';
    category = 'rejected';
  }
  
  // Session/timing issues
  else if (errorCode === 'rp_signature_expired') {
    message = 'Verification session expired. Please request a new verification link from the bot.';
    category = 'expired';
  } else if (errorCode === 'timestamp_too_old' || errorCode === 'timestamp_too_far_in_future') {
    message = 'Verification session is no longer valid. Please request a new verification link.';
    category = 'timestamp';
  }
  
  // Replay/duplicate issues
  else if (errorCode === 'nullifier_replayed' || errorCode === 'duplicate_nonce') {
    message = 'This verification has already been completed. Please request a new verification if needed.';
    category = 'replay';
  }
  
  // RP configuration issues
  else if (errorCode === 'invalid_rp_signature') {
    message = 'Verification configuration error. Please contact support.';
    category = 'config';
  } else if (errorCode === 'unknown_rp' || errorCode === 'inactive_rp') {
    message = 'Service configuration error. Please contact support.';
    category = 'rp';
  }
  
  // Network/connection
  else if (errorCode === 'connection_failed') {
    message = 'Connection to World App failed. Please check your connection and try again.';
    category = 'network';
  }
  
  // Rate limiting
  else if (errorCode === 'max_verifications_reached') {
    message = 'Too many verification attempts. Please try again later.';
    category = 'rate_limit';
  }
  
  // Technical errors (inclusion proof, malformed, etc.)
  else if (errorCode === 'inclusion_proof_pending' || errorCode === 'inclusion_proof_failed') {
    message = 'Verification processing error. Please try again in a moment.';
    category = 'inclusion_proof';
  } else if (errorCode === 'malformed_request') {
    message = 'Verification request error. Please contact support.';
    category = 'malformed';
  }
  
  // Fallback for unmapped errors
  else {
    // Keep generic message, but log specific code for diagnostics
    category = `unmapped_${errorCode}`;
  }
  
  // Privacy-safe structured error logging (no PII, no proof data, no nullifiers)
  console.error('World App verification error:', {
    category: category,
    errorCode: errorCode,
    timestamp: new Date().toISOString(),
    sessionId: sessionId,  // Already client-visible in URL
  });
  
  showError(message);
  buttonEl.disabled = false;
}
```

**Benefits**:
- User sees actionable guidance (expired vs cancelled vs network vs configuration)
- Operator can request user to report error category
- No PII or cryptographic material exposed
- Session ID already in URL, safe to log
- Error code logged to console for dev tools inspection

### Option B: Optional Debug Mode with Request ID

**Add debug info display (only when explicitly enabled):**

```javascript
function handleProofError(errorCode) {
  console.error('World App error:', errorCode);
  
  // ... existing message mapping ...
  
  // Capture debug report if available
  if (window.enrollmentRequest && typeof window.enrollmentRequest.getDebugReport === 'function') {
    try {
      const debugReport = window.enrollmentRequest.getDebugReport();
      console.error('IDKit Debug Report:', {
        requestId: debugReport.request_id,
        transport: debugReport.transport,
        packageVersion: debugReport.package_version,
        // Do NOT log request_payload or response_payload (may contain sensitive data)
      });
      
      // Optionally display request ID to user for support correlation
      if (debugReport.request_id) {
        message += ` (Request ID: ${debugReport.request_id.slice(0, 8)}...)`;
      }
    } catch (e) {
      console.warn('Could not retrieve debug report:', e);
    }
  }
  
  showError(message);
  buttonEl.disabled = false;
}
```

### Option C: Server-Side Error Correlation Logging

**Log client error to backend (privacy-safe fields only):**

```javascript
async function handleProofError(errorCode) {
  console.error('World App error:', errorCode);
  
  // ... existing message mapping ...
  
  // Send privacy-safe error diagnostic to backend (async, non-blocking)
  try {
    await fetch('/api/enrollment/error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,          // Already known to backend
        errorCode: errorCode,           // SDK error code
        errorCategory: category,        // Privacy-safe category
        timestamp: Date.now(),
        // Do NOT send: initData, proof, nullifier, connectorURI, keys
      }),
    });
  } catch (e) {
    // Non-blocking, ignore fetch errors
  }
  
  showError(message);
  buttonEl.disabled = false;
}
```

**Backend endpoint** would:
- Correlate error with session record
- Log error category + timestamp
- Track error frequency by category
- Enable operator to query: "What errors occurred for user X?"
- Never log PII, proofs, nullifiers, or session tokens

## Recommendations

1. **Immediate**: Implement **Option A** (Enhanced error messages) in `src/ui/enrollment.html`
   - Privacy-safe
   - No backend changes required
   - User gets actionable guidance
   - Operator can request error category from user

2. **Future**: Implement **Option C** (Server-side logging) if errors persist
   - Requires new `/api/enrollment/error` endpoint
   - Enables centralized error tracking
   - Must carefully avoid logging sensitive data

3. **Investigation**: For Bob's specific failure:
   - **Cannot determine root cause** without:
     - Browser console logs showing actual `errorCode`
     - Server logs showing if `/complete` was called
     - World App logs (not accessible)
   - **Most likely candidates**:
     - `rp_signature_expired` (after 1:02:22 expiry)
     - `timestamp_too_old` (clock skew)
     - `nullifier_replayed` (if prior enrollment existed)
     - `generic_error` (catchall)
   - **Next step**: Deploy enhanced error messages, wait for next occurrence, capture actual error code

## Constraints Respected

✅ No live credentials/World/Telegram/model calls
✅ No auth bypass
✅ Diagnose via repo/SDK official docs
✅ No raw proof/nullifier/sessiontoken/URI/Telegram initData/key/SDK payload logged
✅ Don't mutate proof acceptance or loosen expiry/generation/ownership
✅ Keep UI artifact separately reviewable
✅ Preserve 83ebbaa backend
✅ Do not fabricate cause
✅ No repeated retries requested from Bob pending evidence

## Files Analyzed

1. `dist/ui/enrollment.html` - Current production error handling
2. `node_modules/@worldcoin/idkit-core/dist/index.d.ts` - IDKit type definitions
3. `node_modules/@worldcoin/idkit-core/README.md` - SDK documentation
4. `node_modules/@worldcoin/idkit-core/dist/index.js` - SDK implementation

## Error Code Reference

See full 29-error enum above. Current code handles 5/29 explicitly:
- `user_rejected` ✅
- `verification_rejected` ✅
- `credential_unavailable` ✅
- `connection_failed` ✅
- `timeout` ✅

Unhandled (show generic message): 24/29
Most operationally relevant unhandled codes:
- `rp_signature_expired`
- `timestamp_too_old` / `timestamp_too_far_in_future`
- `nullifier_replayed` / `duplicate_nonce`
- `invalid_rp_signature`
- `max_verifications_reached`
- `generic_error`
