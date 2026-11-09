# Deployment Prerequisites and Integration Checklist

This document lists the exact prerequisites and integration steps required before production deployment. **None of these steps are authorized for execution in this cloud environment.**

## Unresolved Prerequisites Blocking Production Deployment

### 1. World Developer Portal Configuration

**Status**: Configuration pending, Bob must complete.

**Required actions** (Bob must complete via World Developer Portal):
1. Create World ID application at https://developer.world.org
2. Record `app_id` (e.g., `app_xxxxx`)
3. Record `rp_id` (e.g., `rp_xxxxx`) - Required for verification API calls
4. Create production action identifier (e.g., "openclaw-admission")
5. Choose environment: `production` (requires World ID Orb) or `staging` (simulator)

**End User Requirements**:
- Members only use World App (personal wallet app)
- NO developer account required for each member
- World App verification uses existing personal credentials

**Evidence required before integration**:
- Screenshot or copy of World Developer Portal showing `rp_id` and action
- Confirmation of environment choice (production vs staging)

### 2. Telegram Bot Token

**Status**: Existing bot @OpenClawWorldIDBot already registered. Bot token NOT collected in documentation.

### 3. Public HTTPS Endpoint

**Status**: Domain/tunnel provider not chosen, user must select.

**Options for Mac mini public HTTPS**:
- **Option A: Cloudflare Tunnel** (free tier available)
  - Pros: No open firewall ports, automatic TLS, DDoS protection
  - Cons: Requires Cloudflare account, some latency
- **Option B: ngrok** (free tier available with limitations)
  - Pros: Quick setup, automatic TLS
  - Cons: Random URLs on free tier, session limits
- **Option C: Custom domain + Caddy/nginx**
  - Pros: Full control, no third-party dependency
  - Cons: Requires domain registration, DNS setup, port forwarding

**Required outputs**:
- Public HTTPS URL (e.g., `https://verify.example.com` or `https://random.cloudflare.com`)
- TLS certificate (automatic with tunnel providers, manual with custom domain)

### 4. Durable Production Store Implementation

**Status**: ✅ SQLite implementation complete and tested (recommended default for Mac mini).

**Implemented**:
- ✅ `SqliteChallengeSessionStore` in `src/enrollment-store-sqlite.ts` (production-ready)
- ✅ `SqliteEnrollmentStore` in `src/enrollment-store-sqlite.ts` (production-ready)
- ✅ 24 comprehensive behavioral tests (atomic operations, restart persistence, concurrent replay)
- ✅ Transactional requester-bound completion
- ✅ Automatic cleanup of expired sessions/enrollments
- ✅ WAL mode for better concurrency
- ✅ Portable to Mac Node24

**SQLite Configuration** (recommended for small-scale deployment):
- Single-file database (e.g., `/var/lib/worldid-gate/enrollments.db`)
- No separate server process required
- Good for hundreds to thousands of users
- Automatic schema creation on first run
- Safe for Mac mini deployment

**Alternative: PostgreSQL** (optional, for larger scale):
- Client-server architecture
- Better for thousands+ concurrent users
- Requires PostgreSQL installation on Mac mini
- Library: `pg` (Node.js)
- Implementation: `src/enrollment-store-postgres.ts` (not yet created)

**Integration Steps**:
1. Choose database path (e.g., `/var/lib/worldid-gate/enrollments.db`)
2. Ensure directory exists and has write permissions
3. Configure stores in HTTP server startup:
   ```typescript
   const challengeStore = new SqliteChallengeSessionStore({
     dbPath: "/var/lib/worldid-gate/enrollments.db",
   });
   const enrollmentStore = new SqliteEnrollmentStore({
     dbPath: "/var/lib/worldid-gate/enrollments.db",
   });
   ```
4. Close stores gracefully on shutdown to flush writes

### 5. Telegram Mini App Frontend

**Status**: Not implemented, user must create.

**Required files** (not created yet):
- `public/index.html` - Mini App entry point
- `public/app.js` - IDKit integration and challenge flow
- `public/styles.css` - Mini App styling

**Required dependencies**:
- `@worldcoin/idkit` - World ID verification widget
- Telegram Web App SDK (included via CDN in Mini App)

**Mini App flow**:
1. Parse challenge parameters from URL query string
2. Display World ID verification UI (IDKit widget)
3. On successful verification, send `Telegram.WebApp.initData` + proof to backend `/complete` endpoint
4. Display success/error message
5. Close Mini App

### 6. Verification Service HTTP Server

**Status**: Not implemented, user must create.

**Required files** (not created yet):
- `src/server.ts` - HTTP server with endpoints
- `src/routes/initiate.ts` - POST /initiate (create challenge session)
- `src/routes/complete.ts` - POST /complete (validate proof and create enrollment)
- `src/routes/health.ts` - GET /health (service health check)

**Required endpoints**:
```
POST /api/v1/challenge/initiate
  Body: { telegram_user_id: number }
  Response: { challenge_url: string, expires_at: number }

POST /api/v1/challenge/complete
  Body: { init_data: string, proof: WorldIdV4VerifyRequest }
  Response: { success: boolean, enrollment?: Enrollment, error?: string }

GET /health
  Response: { status: "ok", version: string }
```

### 7. OpenClaw Integration (UNAPPROVED DESIGN)

**Status**: Integration requirements documented in `ARCHITECTURE.md`. **Bob has NOT approved any upstream OpenClaw modifications.**

**Verified OpenClaw Source**:
- Repository: https://github.com/openclaw/openclaw
- Commit: `fc23bc864e4553c2d215e479eeec47b67a0bf943`
- Verified: Commit SHA confirmed in local clone

**UNAPPROVED Integration Requirements**:

#### Unresolved Technical Scope

**OpenClaw Modification** (Bob has NOT approved):
- Middleware injection mechanism (supported integration mechanism not established by this investigation)
- Human actor extraction utility (not yet implemented)
- Protected group scope configuration (format NOT DEFINED)
- Fresh recheck for queued/debounced updates (seam locations NOT TRACED)

**Known Limitations**:
- Poll registry schema contains content fields (`question`, `options`), not just routing metadata
- Content-free poll classification policy NOT YET ESTABLISHED
- Callback/native command separate authorization paths NOT YET UNIFIED
- Missing chat ID extraction (e.g., poll_answer) NOT RESOLVED

**Integration Prerequisites** (UNRESOLVED):
1. Bob approval for upstream OpenClaw modifications
2. Poll registry content read policy decision (Option A vs B)
3. Fresh recheck seam locations identified and verified
4. Unified authorization mechanism across all update types

### 8. OpenClaw Deployment Prerequisites (UNRESOLVED)

**Operator Must Verify BEFORE Integration** (pending Bob approval):

1. **OpenClaw Version Compatibility**
   - Locate OpenClaw installation version/commit
   - Supported integration mechanism not established by this investigation
   - Determine upstream modification approval process

2. **Protected Group Configuration**
   - Identify numeric chat IDs for protected groups (e.g., `-1001234567890`)
   - Document out-of-scope groups (pass-through, no enforcement)
   - Define DM policy (enforce verification or allow) - NOT YET ESTABLISHED

3. **World ID Registry Connection**
   - Registry database path accessible from OpenClaw process
   - Query latency acceptable (<100ms typical, <500ms timeout recommended)
   - Registry service monitoring and alerting configured

4. **Fail-Closed Testing Requirements** (REQUIRED, unimplemented):
   - Registry timeout MUST deny admission (retries MUST NOT permit content/history/model/tools while authorization uncertain)
   - Registry unavailable MUST deny admission
   - Invalid/corrupt registry response MUST deny admission
   - Test revocation timing (depends on recheck frequency NOT YET ESTABLISHED)
   - Confirm expiry enforcement at exact boundary (requires clock consistency)
   - Validate non-human actors rejected in protected groups

5. **Operator Supervision Plan**
   - Monitoring: admission denial rate, registry query latency
   - Alerting: high denial rate, registry unavailable, timeout spikes
   - Rollback: Protected admissions remain fail-closed during uncertain restore
   - Recovery: Local revocation history is authoritative (World API CANNOT recover)

## Portable macOS Deployment Guidance

**Note**: These are conceptual instructions only. No actual deployment, service configuration, or Mac operations are authorized in this cloud environment.

### Prerequisites on Mac mini

- macOS 12.0 or later
- Node.js 18+ (`brew install node` or download from nodejs.org)
- Git (`xcode-select --install` or `brew install git`)
- PostgreSQL or SQLite (for production store)

### Conceptual Deployment Steps

1. **Clone repository** (when ready):
   ```bash
   git clone <repository-url>
   cd openclaw-worldid-gate
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Create environment configuration** (template):
   ```bash
   cat > .env << 'EOF'
   # Telegram Bot Configuration
   VERIFICATION_BOT_TOKEN=your_bot_token_from_botfather
   
   # World ID Configuration
   WORLD_ID_RP_ID=rp_your_rp_id
   WORLD_ID_SIGNING_KEY=your_signing_key_from_portal
   WORLD_ID_ACTION=verify-openclaw-2026
   WORLD_ID_ENVIRONMENT=production
   
   # Server Configuration
   PORT=3000
   PUBLIC_URL=https://verify.example.com
   
   # Database Configuration (SQLite example)
   DATABASE_PATH=/var/lib/worldid-gate/enrollment.db
   
   # Security
   NODE_ENV=production
   EOF
   ```

4. **Build production bundle**:
   ```bash
   npm run build
   ```

5. **Run database migrations** (when implemented):
   ```bash
   npm run migrate
   ```

6. **Start service** (conceptual, requires implemented server.ts):
   ```bash
   npm run start
   ```

### Process Supervision

For production reliability, use a process supervisor (choose one):

- **Option A: launchd** (native macOS)
  - Create plist file in `~/Library/LaunchAgents/`
  - Automatic restart on crash
  - Logs to system log

- **Option B: pm2** (Node.js ecosystem)
  ```bash
  npm install -g pm2
  pm2 start dist/server.js --name worldid-gate
  pm2 startup
  pm2 save
  ```

- **Option C: systemd** (if running Linux on Mac mini)
  - Create service file in `/etc/systemd/system/`
  - `systemctl enable worldid-gate`
  - `systemctl start worldid-gate`

### Security Hardening

- Store secrets in environment variables or macOS Keychain (never in code)
- Run service as non-root user
- Enable firewall to restrict access to verification service port
- Use HTTPS only (no HTTP fallback)
- Implement rate limiting on enrollment endpoints
- Log all enrollment attempts for audit trail
- Regularly backup enrollment database

## Current Implementation Status Summary

**Implemented and tested (298 tests passing, 0 skipped)**:
- ✅ Telegram `initData` HMAC-SHA256 validation
- ✅ World ID v4.0 proof verification with security hardening
- ✅ SQLite enrollment and challenge session stores (production-ready)
- ✅ Fail-closed admission gate with lifecycle management
- ✅ HTTP service with enrollment endpoints
- ✅ Telegram bot handler with /verify, /status, /help commands
- ✅ Enrollment UI with official IDKit SDK integration
- ✅ Webhook secret validation (X-Telegram-Bot-Api-Secret-Token)
- ✅ Session-based enrollment flow (requester-bound, single-use)
- ✅ Security regression tests (18 adversarial tests)

**Runtime Configuration Required**:

Environment variables (required for production):
```bash
# World ID Configuration (from developer.world.org)
export WORLDID_APP_ID=app_xxxxx              # Your application ID
export WORLDID_RP_ID=rp_xxxxx                # Your relying party ID
export WORLDID_SIGNING_KEY_HEX=xxxxx         # 64-char hex signing key
export WORLDID_ENVIRONMENT=production        # or 'staging'
export WORLDID_ACTION=openclaw-admission     # Action identifier

# Telegram Configuration (from @BotFather)
export TELEGRAM_BOT_TOKEN=123456:ABC-DEF     # Bot token
export TELEGRAM_WEBHOOK_SECRET=random_secret # Webhook validation secret

# Service Configuration
export DATABASE_PATH=/var/lib/worldid-gate/enrollments.db
export HTTP_HOST=127.0.0.1                   # Localhost only
export HTTP_PORT=3000
export ENROLLMENT_BASE_URL=https://verify.example.com
```

**Tested Run Commands** (after configuration):
```bash
# Development (uses test defaults, not for production)
npm run start:dev

# Production (requires all environment variables)
npm run build
npm start
```

**Unverified Integration Points** (requires deployment acceptance):
- ⏳ Live Telegram Bot API webhook/polling with real token
- ⏳ Live World ID Developer Portal verification with real credentials
- ⏳ HTTPS public endpoint with real TLS certificate
- ⏳ Mobile device: Telegram → World App → return flow
- ⏳ OpenClaw pre-history ingress authorization hook

**Blocked by External Prerequisites**:
- 🚫 World Developer Portal app/RP/action registration (Bob must complete)
- 🚫 Telegram bot token from @BotFather (Bob must provide)
- 🚫 Public HTTPS domain/tunnel configuration (deployment requirement)
- 🚫 Mac mini deployment and supervision setup (operations requirement)

## Next Steps for User

**Existing Components** (built and tested at commit 040e904):
- ✅ Telegram bot handler with `/verify`, `/status`, `/help`, `/start` commands
- ✅ Enrollment Mini App with World ID IDKit SDK integration
- ✅ World ID HTTP verification client (production and staging endpoints)
- ✅ SQLite enrollment store with revocation lifecycle
- ✅ HTTP server endpoints for enrollment API
- ✅ 354 unit tests + 3 browser tests passing

**NOT Tested** (require live integration):
- Real Telegram webhook/polling with authentic update signatures
- Real World App proof generation on device
- Live World ID Developer Portal API calls
- Public HTTPS hosting with valid TLS certificate

**Live Integration Steps**:

1. **World ID application and Telegram bot already registered**:
   - Existing World ID app and RP registration known (app/RP public IDs and signing secrets NOT collected in documentation)
   - Existing bot @OpenClawWorldIDBot already registered
   - Refer to official World ID v4/RP proofOfHuman contract and configuration documentation

2. **Choose and provision public HTTPS solution** (NOT YET SELECTED):
   - Options: Cloudflare Tunnel / ngrok / custom domain
   - Set up tunnel/domain to deployment host
   - Record public HTTPS URL

3. **Configure environment**:
   - Configure existing app/RP credentials and bot token via secure channel (NOT collected in documentation)
   - Confirm environment choice (production vs staging)

4. **OpenClaw Integration** (AFTER Bob approval):
   - Implement ingress gate (UNAPPROVED DESIGN)
   - Test end-to-end enrollment flow

## Security Review Checklist

Before production deployment, verify:
- [ ] Bot token stored as environment variable (not in code)
- [ ] World ID signing key stored as environment variable (not in code)
- [ ] Telegram `initData` HMAC validation on backend (never frontend)
- [ ] World ID proof verification on backend (never frontend)
- [ ] Challenge sessions single-use (consumed after enrollment)
- [ ] Challenge sessions expire (e.g., 15 minutes)
- [ ] Enrollment expiry enforced (default 30 days)
- [ ] Numeric Telegram user ID authenticated (via initData)
- [ ] World ID nullifier stored to prevent reuse
- [ ] HTTPS only (no HTTP)
- [ ] Rate limiting on enrollment endpoints
- [ ] Audit logging enabled
- [ ] Database backups configured
- [ ] Error messages do not leak sensitive information

## New Features: Status Socket and Member Tags

### Status Socket Configuration

The status socket provides a private interface for enrollment status queries.

**Environment Variables:**

```bash
# Enable private status socket for OpenClaw integration
WORLDID_STATUS_SOCKET=${HOME}/.worldid-gate/status.sock
WORLDID_STATUS_SECRET_FILE=${HOME}/.worldid-gate/status-secret.txt
```

**WORLDID_STATUS_SOCKET**: Path to Unix domain socket for private enrollment status queries. Must be in a directory owned by `finn` with mode 0700. Socket created with mode 0600 (owner-only).

**WORLDID_STATUS_SECRET_FILE**: Path to file containing bearer authentication secret (minimum 32 characters). File must have mode 0600 and be owned by `finn`. The secret is loaded at startup and used for constant-time authentication.

**Important:** Both the gate service and main OpenClaw gateway run as the same OS user, so the socket directory (`~/.worldid-gate`) must be owned by that user with mode 0700, and the secret file must be owned by the same user with mode 0600.

**Security Notes**:
- The status socket is NOT mounted on the public HTTP server (port 3000)
- All queries require bearer authentication
- Rate limited to 100 requests per minute per endpoint, 1000 per minute globally
- Only returns privacy-safe fields (no nullifiers, proofs, or session IDs)
- Socket directory is created with mode 0700
- Stale sockets are checked before startup (refuses to start if live socket exists)

**Status Socket Response Format:**

GET /status/:telegramUserId returns:

```json
{
  "verified": true,
  "state": "active",
  "expiresAt": 1735689600,
  "action": "openclaw-enroll-v3"
}
```

**Fields**:
- `verified` (boolean): True only if state is "active"
- `state` (enum): "active", "expired", "revoked", or "none"
- `expiresAt` (number | null): Unix timestamp of enrollment expiration
- `action` (string): The enrollment action scope

### Member Tags Configuration

Member tags provide automatic "Human Verified" labels for enrolled members.

**Environment Variables:**

```bash
# Enable member tags (requires bot admin with can_manage_tags)
MEMBER_TAGS_ENABLED=true
MEMBER_TAG_TEXT="Human Verified"
MEMBER_TAG_SWEEP_INTERVAL_HOURS=24
```

**MEMBER_TAGS_ENABLED**: Set to `true` to enable automatic member tag management. Requires the bot to be an administrator in the target chat with `can_manage_tags` permission.

**MEMBER_TAG_TEXT**: Text to display on member tags. Maximum 16 characters, no emoji allowed. Default: `Human Verified`

**MEMBER_TAG_SWEEP_INTERVAL_HOURS**: How often to run the reconciliation sweep. Valid range: 1-168 hours. Default: 24 hours. The sweep runs once at startup and then periodically at this interval.

**Note**: OPENCLAW_ALLOWED_GROUP must be set when member tags are enabled.

**MEMBER_TAG_GROUPS**: Comma-separated list of negative integers representing Telegram group/supergroup chat IDs where member tags should be applied. If not set, defaults to OPENCLAW_ALLOWED_GROUP. The list must include OPENCLAW_ALLOWED_GROUP if specified. No duplicates or empty entries allowed. Examples:
- Single group (default): Omit MEMBER_TAG_GROUPS (uses OPENCLAW_ALLOWED_GROUP)
- Multiple groups: `MEMBER_TAG_GROUPS="-1001234567890,-1009876543210,-1001111111111"`

Format rules:
- All entries must be negative integers (Telegram groups have negative IDs)
- No empty entries (`,, ` is invalid)
- No duplicates
- Must include OPENCLAW_ALLOWED_GROUP value if both are set

**Member Tags Behavior:**

**Tag Application:**
- Applied immediately after successful enrollment
- Applied after session renewal or reactivation
- Skipped for administrators and creators
- Skipped if user not in group or restricted without membership
- Logs conflict if different tag already exists (does not overwrite)
- Reads current tag from Telegram API before applying

**Tag Removal:**
- Removed immediately on enrollment revocation
- Removed by reconciliation sweep (runs at startup + periodic interval)
- Only removed if the gate applied it (tracked in member_tags table)
- Only removed if the live tag still matches what the gate applied
- Reads current tag from Telegram API before removing

**Reconciliation Sweep:**
- Applies missing tags for active, unexpired enrollments (retries earlier failures)
- Removes tags from expired or revoked enrollments
- Re-checks can_manage_tags permission on each sweep
- Handles 429 retry_after from Telegram API
- Runs in background (does not block startup)

**Failure Handling:**
- Tag operations never block enrollment
- If bot lacks can_manage_tags permission at startup, tagging is disabled with a warning
- Permission check runs in background with timeout
- Tag application/removal failures are logged but do not prevent enrollment success
- The service continues normally even if Telegram API calls fail

### OpenClaw Skill Configuration

The status query functionality is exposed to OpenClaw agents via a skill at `deploy/openclaw-skill/worldid-status/`.

**Installation for Agent `main` (Finn):**

1. Create secure directory for socket and secret (owned by finn, mode 0700):

```bash
mkdir -p ~/.worldid-gate
chmod 0700 ~/.worldid-gate
```

2. Create secret file (owned by finn, mode 0600):

```bash
# Generate secret with mode 0600 (umask 077 ensures secure permissions)
(umask 077 && openssl rand -hex 32 > ~/.worldid-gate/status-secret.txt)
```

3. Copy the skill to Finn's workspace:

```bash
cp -r /path/to/worldid-gate/deploy/openclaw-skill/worldid-status \
      ~/.openclaw/workspace/skills/worldid-status
```

4. Add environment variables to Finn's OpenClaw configuration under `skills.entries.worldid-status.env`:

```yaml
skills:
  entries:
    worldid-status:
      env:
        WORLDID_STATUS_SOCKET: ${HOME}/.worldid-gate/status.sock
        WORLDID_STATUS_SECRET_FILE: ${HOME}/.worldid-gate/status-secret.txt
```

5. Add the skill to Finn's allowlist under `agents.entries.main.skills`:

```yaml
agents:
  entries:
    main:
      skills:
        - worldid-status
```

6. Restart Finn to load the skill.

**Important:** Both the gate service and the main OpenClaw gateway run as the same OS user. The socket directory (`~/.worldid-gate`) has mode 0700, and the secret file has mode 0600, both owned by that user.

**Tool Permission:**

The skill executes the `query-worldid-status` script with standard exec permission. The script:
- Makes no filesystem modifications
- Writes no files (except mktemp response file, cleaned up on exit)
- Reads only the secret file and socket
- Is read-only against the gate service

**Usage Limitation:**

The skill accepts numeric Telegram user IDs only (e.g., `123456789`). It does NOT support @username lookups because:
- Usernames are mutable (can be changed by users)
- The gate stores enrollments by immutable numeric user IDs only
- The Telegram Bot API cannot resolve @username to numeric ID without prior interaction

Finn should use only `sender.id` from the Conversation info block or `sender_id` from reply-chain blocks.

### Schema v4 Migration

The service automatically migrates the database to schema v4 on first startup after deployment. This migration:

- Creates the `member_tags` table for tracking applied tags
- Is idempotent (safe to run multiple times)
- Preserves all existing enrollment data
- Does not require downtime

No manual intervention required.

### Logging

**Status Socket Logs:**
- Socket binding logged at startup: `[StatusSocket] Listening on /path/to/socket (mode 0600)`
- Authentication failures and errors are logged
- User IDs and chat IDs are never logged

**Member Tags Logs:**
- Permission check result logged at startup (runs in background)
- Sweeper interval logged at startup
- Tag conflicts logged without user IDs: `[MemberTag] Tag conflict detected, skip`
- Tag operation outcomes logged without IDs: `[MemberTag] Failed to apply tag after enrollment`
- Reconciliation runs are not individually logged (reduce noise)

**OpenClaw Dispatcher Context:**
- For each admitted message, logs: `[gate] sender World ID verified, expires YYYY-MM-DD`
- No nullifiers, user IDs, or sensitive data in logs
- Helps operators understand admission flow without exposing PII

### Required Launcher Changes

**Note:** `bin/launch-private-service.cjs` is NOT in this repository. It lives on the Mac mini deployment machine.

The launcher must pass through these new environment variables:

**Status Socket:**
- `WORLDID_STATUS_SOCKET` (path to Unix domain socket, e.g., `~/.worldid-gate/status.sock`)
- `WORLDID_STATUS_SECRET_FILE` (path to secret file with mode 0600, e.g., `~/.worldid-gate/status-secret.txt`)

**Member Tags:**
- `MEMBER_TAGS_ENABLED` (set to `true` to enable, default `false`)
- `MEMBER_TAG_TEXT` (text to display on tags, default `Human Verified`, max 16 chars, no emoji)
- `MEMBER_TAG_SWEEP_INTERVAL_HOURS` (reconciliation interval, 1-168 hours, default 24)
- `MEMBER_TAG_GROUPS` (comma-separated list of negative integers for multi-group tagging, defaults to OPENCLAW_ALLOWED_GROUP if unset)

**Socket and secret paths should use the OpenClaw user's home directory** (not `/etc` or `/var/run`), since both the gate service and main OpenClaw gateway typically run as the same OS user.

### Security Checklist

Before deploying to production:

- [ ] Status socket path is in a secure directory (not world-readable)
- [ ] Status socket directory has mode 0700
- [ ] Status secret file has mode 0600 and contains strong secret (32+ characters)
- [ ] Status secret is not committed to git or logged
- [ ] OpenClaw profile has WORLDID_STATUS_SOCKET and WORLDID_STATUS_SECRET_FILE environment variables set
- [ ] Bot is administrator in target chat with can_manage_tags permission
- [ ] MEMBER_TAG_TEXT is appropriate for your community (16 chars max, no emoji)
- [ ] MEMBER_TAG_SWEEP_INTERVAL_HOURS is set (1-168, default 24)
- [ ] Test status socket with helper script after startup
- [ ] Verify /status/123 returns 404 on public HTTP server (port 3000)
- [ ] Verify member tags are applied after enrollment
- [ ] Verify member tags are removed on revocation
- [ ] Verify sweeper runs without blocking enrollment

### Rollback Plan

If issues arise:

1. **Disable member tags**: Set `MEMBER_TAGS_ENABLED=false` and restart
2. **Disable status socket**: Remove `WORLDID_STATUS_SOCKET` and `WORLDID_STATUS_SECRET_FILE` env vars and restart
3. Both features are independent and can be disabled separately without affecting core enrollment functionality
4. Database schema v4 migration is forward-only (no rollback), but member_tags table can be safely ignored if feature is disabled
