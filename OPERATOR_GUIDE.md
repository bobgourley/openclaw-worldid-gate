# Operator Guide: World ID Webhook Bridge

**Status: NOT RUN LIVE - Awaiting Production Prerequisites**

This guide covers deployment of the World ID gated webhook bridge for OpenClaw. This is a **bounded test integration**, not a comprehensive security audit of all OpenClaw paths.

## CRITICAL LIMITATIONS

### Scope of This Integration

**What this bridge gates:**
- Text messages from authenticated numeric Telegram senders
- Routed through this webhook bridge service
- In the explicitly configured test group only
- With explicit trigger prefix (e.g., `/test`)

**What this bridge does NOT gate:**
- Native OpenClaw Telegram plugin message paths
- OpenClaw bot messages sent directly to other groups/DMs
- Existing OpenClaw bot deployments
- Callback queries, inline queries, or other update types
- Messages without the trigger prefix

**Integration status:** A supported pre-processing admission integration has not yet been established for the pinned OpenClaw version. This webhook bridge operates as an ALTERNATE INGRESS ROUTE for confined testing only.

### Security Posture

**Fail-closed guarantees apply ONLY to:**
- Messages processed through this webhook bridge
- With valid World ID enrollment checks
- Before OpenClaw agent CLI invocation

**Fail-closed guarantees DO NOT apply to:**
- Direct messages to existing OpenClaw bots
- Native Telegram plugin paths in OpenClaw
- Other ingress routes not using this bridge

## Prerequisites

### 1. Installed OpenClaw CLI

Query your local OpenClaw installation:

```bash
openclaw --version
# Expected: OpenClaw 2026.9.8 or compatible

which openclaw
# Expected: path to openclaw executable
```

Verify agent CLI contract:

```bash
openclaw agent --help
# Required flags: --agent, --message-file, --session-key, --json, --timeout
```

### 2. World ID Configuration

**Required:**
- World ID App ID (RP ID) from https://developer.world.org/
- World ID verification endpoint configured
- Action string for enrollment uniqueness

**Credential type decision:**
- `requireProofOfHuman: true` (default) - Orb verification only, highest assurance
- `requireProofOfHuman: false` - Accept Selfie Check too, medium assurance

### 3. Telegram Bot Configuration

**Required:**
- Telegram bot token (for HMAC validation)
- Bot must be added to test group with appropriate permissions
- Bot username: @OpenClawWorldIDBot (existing)

**Test group:**
- Group name: "finn talk" (existing private group)
- Group ID: Must be extracted and configured
- Bot must have permission to send messages

### 4. OpenClaw Agent Configuration

**Required:**
- Pre-configured agent ID (not user-controlled)
- Agent must exist in OpenClaw config
- Session storage location determined
- Optional: Isolated --profile for test state

**Agent restrictions:**
- Agent must NOT have --deliver enabled
- Agent must NOT accept user-controlled routing
- Agent session keys must be deterministic: `telegram:{accountId}:{chatId}:{userId}`

### 5. Secure Token Storage

**NEVER commit to repository:**
- Telegram bot token
- World ID RP ID secret (if applicable)
- OpenClaw agent credentials
- Any API keys or signing secrets

**Recommended storage:**
- Environment variables (loaded from secure .env file)
- Secret management system (Vault, AWS Secrets Manager, etc.)
- File permissions set to 0600 (owner read/write only)

## Configuration

### Bridge Configuration File

Create `config.production.ts` (NOT committed to git):

```typescript
import type { WebhookBridgeConfig } from './src/webhook-bridge.js';

export const config: WebhookBridgeConfig = {
  // CRITICAL: Bridge is OFF by default
  enabled: false, // Set to true only when ready for testing
  
  // Telegram authentication
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
  
  // ONLY THIS GROUP ALLOWED
  allowedGroupId: -1001234567890, // Replace with actual "finn talk" group ID
  
  // Text trigger (optional, recommended for testing)
  triggerPrefix: '/test ',
  
  // World ID gate config
  gateConfig: {
    rpId: process.env.WORLD_ID_RP_ID!,
    action: 'openclaw-gate-test',
    verifyEndpoint: 'https://developer.world.org/api/v4/verify/' + process.env.WORLD_ID_RP_ID!,
    requireProofOfHuman: true, // Orb-only
    enrollmentTtlSeconds: 30 * 24 * 60 * 60, // 30 days
    allowTestMode: false, // MUST be false in production
  },
  
  // OpenClaw CLI config
  openclawConfig: {
    openclawBin: '/Users/finn/.nvm/versions/node/v24.19.0/bin/openclaw',
    agentId: 'test-agent-id', // Replace with actual agent ID
    telegramAccountId: 'default',
    timeoutSeconds: 30,
    maxOutputBytes: 1024 * 1024, // 1MB
    profile: 'worldid-test', // Isolated config profile
  },
};
```

### Environment Variables

Create `.env.production` (NOT committed to git):

```bash
# Telegram
TELEGRAM_BOT_TOKEN=123456:ABCdefGHIjklMNOpqrsTUVwxyz

# World ID
WORLD_ID_RP_ID=app_staging_1234567890abcdef

# Service
NODE_ENV=production
PORT=8443
```

File permissions:

```bash
chmod 600 .env.production
chmod 600 config.production.ts
```

## Deployment Checklist

### Pre-Deployment Verification

- [ ] OpenClaw agent pre-configured and tested locally
- [ ] Test group ID extracted and verified
- [ ] World ID RP ID obtained from developer portal
- [ ] Telegram bot token secured
- [ ] Service runs as low-privilege user (not root)
- [ ] File permissions restricted (0600 for secrets)
- [ ] HTTPS endpoint selected (provider not yet chosen)
- [ ] SSL/TLS certificates obtained or planned
- [ ] Webhook signature validation implemented

### Initial Test Run

**Start with bridge DISABLED:**

```bash
# Verify configuration loads
npm run typecheck

# Run offline tests
npm test

# Verify all tests pass
```

**Extract test group ID:**

```bash
# Option 1: Use Telegram Bot API getUpdates
curl https://api.telegram.org/bot<TOKEN>/getUpdates

# Option 2: Add bot to group, send message, check chat.id in update
```

**Enable bridge for testing:**

```typescript
// config.production.ts
enabled: true, // Enable ONLY for confined test
```

### Real Test Execution

**Test 1: Unenrolled user (should reject)**

1. Send message from unenrolled Telegram account
2. Message: `/test hello`
3. Expected: Admission denied (no OpenClaw invocation)
4. Verify: No agent response, metrics show 0 LLM calls

**Test 2: Enrollment flow**

1. User opens enrollment URL with World App
2. User completes Orb verification (Proof of Human)
3. Backend receives proof, validates with World ID API
4. Enrollment record stored with Telegram user ID binding

**Test 3: Enrolled user (should admit)**

1. Send message from enrolled Telegram account
2. Message: `/test hello openclaw`
3. Expected: Admission allowed, OpenClaw CLI invoked
4. Expected: Bot responds with OpenClaw agent output

**Test 4: Expired enrollment (should reject)**

1. Manually expire enrollment (set expiresAt to past)
2. Send message from expired account
3. Expected: Admission denied (enrollment expired)
4. Verify: No OpenClaw invocation

**Test 5: Revoked enrollment (should reject)**

1. Revoke enrollment (set revoked flag)
2. Send message from revoked account
3. Expected: Admission denied (enrollment revoked)
4. Verify: No OpenClaw invocation

### Rollback Procedure

**To disable bridge immediately:**

```typescript
// config.production.ts
enabled: false, // Disable bridge
```

**Restart service:**

```bash
# Stop service
kill <service-pid>

# Or use process manager
pm2 stop worldid-bridge
```

**Rollback affects ONLY:**
- This webhook bridge service
- Messages routed through this bridge
- Test group configured in allowedGroupId

**Rollback does NOT affect:**
- Existing OpenClaw bot deployments
- Direct messages to other bots
- Native OpenClaw Telegram plugin

## Production Prerequisites (NOT YET SATISFIED)

### Infrastructure Requirements

- [ ] **HTTPS provider selected** (options: Railway, Fly.io, AWS, GCP, Azure)
- [ ] **SSL/TLS certificates** obtained and configured
- [ ] **Webhook endpoint URL** registered with Telegram
- [ ] **Rate limiting** implemented (not included in starter)
- [ ] **Request signing** validated (Telegram HMAC or X-Telegram-Bot-Api-Secret-Token)
- [ ] **Process isolation** (service runs as dedicated low-privilege user)
- [ ] **Monitoring/alerting** configured for service health
- [ ] **Logging** configured (structured logs, no token leakage)

### Durable Storage

- [ ] **Enrollment database** deployed (PostgreSQL, MySQL, etc.)
- [ ] **Database transactions** protect concurrent enrollments
- [ ] **Nullifier uniqueness** enforced at database level
- [ ] **Backup/restore** procedures documented
- [ ] **Data retention policy** defined and implemented

### World ID Verification

- [ ] **Production World ID verifier** implemented (HTTPS client, not stub)
- [ ] **Retry logic** for transient verification failures
- [ ] **Circuit breaker** for World ID API outages (fail closed)
- [ ] **Proof replay protection** (durable nullifier tracking across restarts)

### Security Hardening

- [ ] **Enrollment challenge protocol** implemented (prevents copied proofs)
- [ ] **Rate limiting** per user/group (prevent abuse)
- [ ] **Audit logging** for all admission decisions
- [ ] **Concurrent enrollment protection** (database locks/constraints)
- [ ] **Re-verification triggers** on enrollment expiry
- [ ] **Revocation race protection** (transaction isolation)

### Operational Readiness

- [ ] **Incident response plan** documented
- [ ] **On-call rotation** established
- [ ] **Monitoring dashboards** deployed
- [ ] **Alerting thresholds** configured
- [ ] **Disaster recovery plan** documented
- [ ] **Privacy policy** published (data retention, deletion)
- [ ] **Security audit** completed by independent reviewer

## Monitoring

### Key Metrics

Monitor these metrics for service health:

- `admission_checks_total{result="allowed"}` - Successful admissions
- `admission_checks_total{result="denied",reason="*"}` - Rejections by reason
- `openclaw_dispatch_total{result="success"}` - Successful agent calls
- `openclaw_dispatch_total{result="timeout"}` - Agent timeouts
- `openclaw_dispatch_duration_seconds` - Agent response time
- `enrollment_ttl_expiring_soon` - Enrollments expiring within 7 days

### Health Checks

Implement these endpoints:

- `GET /health` - Service liveness
- `GET /ready` - Service readiness (DB connected, World ID reachable)
- `GET /metrics` - Prometheus metrics export

## Troubleshooting

### Bridge Rejects All Messages

**Symptom:** All messages denied with "bridge is disabled"

**Solution:** Check `config.enabled` flag is set to `true`

### Authentication Failures

**Symptom:** "Authentication failed" errors

**Solution:** Verify Telegram bot token and HMAC validation

### Agent Timeout

**Symptom:** "OpenClaw agent timeout exceeded"

**Solution:** Increase `openclawConfig.timeoutSeconds` or optimize agent

### Enrollment Not Found

**Symptom:** "Admission denied: No enrollment found"

**Solution:** User must complete World ID enrollment flow first

### Wrong Group

**Symptom:** "Group X not authorized"

**Solution:** Verify `allowedGroupId` matches actual test group ID

## Support

For questions about:
- **World ID**: https://docs.world.org/
- **OpenClaw**: https://docs.openclaw.ai/
- **This bridge**: See AGENTS.md and README.md

## License

License choice awaiting Bob. No license file included.
