# OpenClaw World ID Webhook Bridge Integration Status

**Repository:** https://github.com/bobgourley/openclaw-worldid-gate  
**Branch:** cursor/worldid-gate-starter-9717  
**HEAD:** 1fb6954d3a2a4f974358e25791acbf6fe8c91eef (verified)

## Current State Assessment

### Existing Infrastructure (Verified Present)

1. **SQLite Enrollment Store** (`src/enrollment-store-sqlite.ts`)
   - Durable enrollment registry with migrations
   - Nullifier uniqueness constraints
   - Revocation support
   - Expiry tracking

2. **World ID HTTP Verifier** (`src/worldid-verifier-http.ts`)
   - Production HTTPS client to World ID API v4
   - Proof validation
   - Credential type checking (proof_of_human vs selfie)
   - Error handling and circuit breaking

3. **Challenge/Response Flow** (`src/worldid-challenge-adapter.ts`)
   - SDK-based challenge generation
   - Nonce management
   - Signal hashing
   - Replay protection

4. **Telegram Webhook Authentication** (`src/telegram-bot-handler.ts:109`)
   - `validateWebhook()` method checks X-Telegram-Bot-Api-Secret-Token header
   - Correct authentication (not HMAC signature)
   - Fail-closed validation

5. **Enrollment Service** (`src/enrollment-service-production.ts`)
   - `findEnrollment(userId)` checks verification status
   - Returns enrollment with expiry and revocation status
   - 30-day configurable TTL (lines 80-81)
   - Account-bound fresh verification

6. **Express HTTP Server** (`src/server.ts`)
   - Production-ready service with health checks
   - Environment variable configuration
   - Fail-closed on missing config

### Test Suite Baseline (Verified)

```bash
npm test  # Unit tests (tsx)
# Expected: 354+ tests (all src/**/*.test.ts files)

npm run test:browser  # Browser tests (playwright)
# Expected: 3 browser milestone tests

npm run test:all  # Combined
# Expected: 354+ unit + 3 browser = 357+ total
```

**My incorrect report:** 39 tests (only counted my new tests, ignored 315+ existing)

### Integration Requirements (Not Completed)

#### 1. OpenClaw CLI Dispatcher Integration

**File:** `src/openclaw-dispatcher.ts` (created but not wired)

**Needs:**
- Integration with TelegramBotHandler
- New command handler (e.g., `/ask <message>` or trigger prefix)
- Fresh enrollment check before dispatch
- Subprocess spawn with bounded execution
- Return OpenClaw response to Telegram chat

**Session key format:** `telegram:{accountId}:{chatId}:{userId}` (implemented)

#### 2. Webhook Handler Extension

**File:** `src/telegram-bot-handler.ts` (existing)

**Add method:**
```typescript
/**
 * Handle gated OpenClaw dispatch command.
 * 
 * Security:
 * - Numeric human sender only (already validated)
 * - Fresh enrollment check before dispatch
 * - Bounded CLI execution
 * - No sensitive output to Telegram
 */
private async handleOpenClawCommand(
  userId: number,
  chatId: number,
  text: string
): Promise<void> {
  // 1. Fresh enrollment check
  const enrollment = await this.enrollmentService.findEnrollment(userId);
  
  if (!enrollment || enrollment.revoked || enrollment.expired) {
    await this.transport.sendMessage(
      chatId,
      '❌ World ID verification required. Use /verify to start.'
    );
    return;
  }
  
  // 2. Dispatch to OpenClaw CLI (using openclaw-dispatcher)
  const result = await dispatchToOpenClaw(config, {
    telegramUserId: userId,
    chatId: chatId,
    text: text,
  });
  
  // 3. Return bounded response
  if (result.success) {
    await this.transport.sendMessage(chatId, result.response);
  } else {
    await this.transport.sendMessage(chatId, '❌ Request failed.');
  }
}
```

#### 3. Server Endpoint for OpenClaw Webhook

**File:** `src/server.ts` (existing)

**Add route:**
```typescript
// New route for OpenClaw-gated Telegram webhook
app.post('/api/openclaw/webhook', express.text({ type: '*/*' }), async (req, res) => {
  // 1. Validate webhook secret
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (!botHandler.validateWebhook(req.body, secretToken)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  
  // 2. Parse update
  const update = JSON.parse(req.body);
  
  // 3. Handle with extended bot handler (includes OpenClaw dispatch)
  await botHandler.handleUpdate(update);
  
  res.status(200).json({ ok: true });
});
```

#### 4. Configuration

**File:** `src/config.ts` or environment variables

**Add:**
```typescript
// OpenClaw CLI configuration
openclawBin: process.env.OPENCLAW_BIN || '/usr/local/bin/openclaw',
openclawAgent: process.env.OPENCLAW_AGENT || 'test-agent',
openclawProfile: process.env.OPENCLAW_PROFILE,
openclawTimeout: parseInt(process.env.OPENCLAW_TIMEOUT || '30'),

// Gating configuration
openclawAllowedGroupId: parseInt(process.env.OPENCLAW_ALLOWED_GROUP || '-1'),
openclawTriggerPrefix: process.env.OPENCLAW_TRIGGER_PREFIX || '/ask ',
```

#### 5. Integration Tests

**New file:** `src/openclaw-integration.test.ts`

**Must test:**
- Full HTTP POST to webhook endpoint
- Webhook secret validation (valid/invalid)
- Enrollment check (enrolled, expired, revoked, not found)
- CLI dispatch with mock subprocess
- Response delivery
- Duplicate suppression
- Timeout handling
- Error handling

**Use:** Local HTTP server, fixtures, mock CLI subprocess

#### 6. Operator Guide Corrections

**File:** `OPERATOR_GUIDE.md` (restored original 856 lines)

**Add section:** "OpenClaw CLI Integration" after existing sections

**Content:**
- Mac mini preparation checklist
- OpenClaw CLI verification steps
- Test group ID extraction
- Trigger prefix configuration
- Profile isolation setup
- Real test execution procedure (5 scenarios)

**Preserve:**
- Existing bot @OpenClawWorldIDBot
- 30-day TTL policy
- Account-bound verification
- SQLite/verifier documentation

### Blockers to Real Test Execution

1. **OpenClaw CLI availability:** Verify accessible on Mac mini at known path
2. **Agent configuration:** Pre-configure test agent in OpenClaw
3. **Test group ID:** Extract actual group ID from "finn talk"
4. **Webhook registration:** Register webhook URL with Telegram (requires HTTPS)
5. **Service deployment:** Run server on Mac mini or accessible host
6. **Bot token:** Configure actual bot token for @OpenClawWorldIDBot

### Test Commands (Corrected)

```bash
# Unit tests only
npm test
# Expected: 354+ unit tests pass

# Browser tests only  
npm run test:browser
# Expected: 3 browser tests pass

# All tests
npm run test:all
# Expected: 357+ total tests pass

# Typecheck
npm run typecheck
# Expected: No errors

# Build
npm run build
# Expected: Successful compilation to dist/
```

### Mac Mini Preparation Checklist

**Prerequisites:**
1. Node.js 20+ installed
2. OpenClaw 2026.9.8 installed and verified
3. Git repository cloned
4. Dependencies installed (`npm install`)

**OpenClaw verification:**
```bash
openclaw --version
# Expected: OpenClaw 2026.9.8

which openclaw
# Record exact path for configuration

openclaw --profile worldid-test agent --help
# Verify --agent, --message-file, --session-key, --json, --timeout supported
```

**Service configuration:**
```bash
# Create .env.production (not committed)
WORLDID_APP_ID=app_staging_xxxxx
WORLDID_RP_ID=rp_xxxxx
WORLDID_SIGNING_KEY_HEX=xxxxx
TELEGRAM_BOT_TOKEN=xxxxx
TELEGRAM_WEBHOOK_SECRET=xxxxx
WORLDID_ACTION=openclaw-gate-test
ENROLLMENT_BASE_URL=https://your-domain.com
OPENCLAW_BIN=/path/to/openclaw
OPENCLAW_AGENT=test-agent-id
OPENCLAW_PROFILE=worldid-test
OPENCLAW_ALLOWED_GROUP=-1001234567890
OPENCLAW_TRIGGER_PREFIX="/ask "
DATABASE_PATH=/path/to/enrollment.db
HTTP_PORT=3000
```

**Service startup:**
```bash
# Test locally
npm run start:dev

# Health check
curl http://localhost:3000/api/health
# Expected: {"status":"healthy","ready":true}

# Production
npm run build
npm start
```

**Telegram setup:**
```bash
# Get test group ID (send message to bot in group, check logs)
# Extract actual chat.id from update JSON

# Register webhook (requires HTTPS + valid certificate)
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.com/api/openclaw/webhook",
    "secret_token": "<WEBHOOK_SECRET>",
    "allowed_updates": ["message"]
  }'
```

### Real Test Procedure (After Integration Complete)

1. **Unenrolled user test:** Send `/ask hello` from unenrolled account → Expect verification prompt
2. **Enrollment:** Complete World ID verification → Expect success confirmation
3. **Enrolled user test:** Send `/ask hello openclaw` → Expect OpenClaw response
4. **Expired enrollment:** Manually expire enrollment → Expect verification required
5. **Revoked enrollment:** Revoke enrollment → Expect verification required

### Remaining Work Estimate

**Critical path:**
1. Wire openclaw-dispatcher into telegram-bot-handler (1-2 hours)
2. Add server webhook endpoint (30 minutes)
3. Write integration tests (2-3 hours)
4. Test on Mac mini with real OpenClaw CLI (1-2 hours)
5. Document operator procedures (1 hour)

**Total:** 5.5-8.5 hours of focused development

### Limitations (Documented)

**This integration gates:**
- Messages to specific webhook endpoint
- With trigger prefix in configured group
- From verified World ID users

**Does NOT gate:**
- Native OpenClaw Telegram plugin paths
- Direct bot messages to other groups
- Other OpenClaw ingress routes

**Integration status line (corrected):**
"A supported pre-processing admission integration has not yet been established for the pinned OpenClaw version."
