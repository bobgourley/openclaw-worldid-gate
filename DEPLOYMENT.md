# Deployment Prerequisites and Integration Checklist

This document lists the exact prerequisites and integration steps required before production deployment. **None of these steps are authorized for execution in this cloud environment.**

## Unresolved Prerequisites Blocking Production Deployment

### 1. World Developer Portal Configuration

**Status**: Not configured, user must complete.

**Required actions** (Bob must complete via World Developer Portal):
1. Create World ID application at https://developer.world.org
2. Record `app_id` (e.g., `app_xxxxx`)
3. Record `rp_id` (e.g., `rp_xxxxx`)
4. Record `signing_key` (store as secret, never commit)
5. Create action identifier (e.g., `verify-openclaw-2026`)
6. Choose environment: `production` (requires World ID Orb) or `staging` (simulator)

**Evidence required before integration**:
- Screenshot or copy of World Developer Portal app settings showing `app_id`, `rp_id`, and action
- Confirmation of environment choice (production vs staging)

### 2. Telegram Bot Token

**Status**: Not collected, user must provide.

**Required actions** (Bob must complete via @BotFather):
1. Create verification bot via @BotFather `/newbot` command
2. Record bot token (e.g., `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
3. Store token as environment variable or secret (never commit)
4. Configure bot username (e.g., `@YourVerificationBot`)

**Security warning**: Bot token is equivalent to account password. Never expose in code, logs, or version control.

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

**Status**: In-memory implementation only, user must implement durable store.

**Current status**:
- `InMemoryChallengeSessionStore` in `src/enrollment-store.ts` (NOT production-safe)
- `InMemoryEnrollmentStore` in `src/enrollment-store.ts` (NOT production-safe)

**Required implementation** (choose one):
- **Option A: SQLite** (simplest for Mac mini)
  - Single-file database
  - No separate server process
  - Good for small-scale (hundreds of users)
  - Library: `better-sqlite3` (Node.js)
- **Option B: PostgreSQL** (more robust)
  - Client-server architecture
  - Better for scale and concurrent access
  - Requires PostgreSQL installation on Mac mini
  - Library: `pg` (Node.js)

**Required files** (not created yet):
- `src/enrollment-store-sqlite.ts` or `src/enrollment-store-postgres.ts`
- SQL schema migration scripts
- Database connection configuration

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

### 7. OpenClaw Integration

**Status**: OpenClaw v2026.9.8 ingress enforcement pattern verified but not integrated.

**Required integration** (pending official compatibility verification):
- Implement OpenClaw channel plugin or external allowlist sync
- Configure `channels.telegram.groupAllowFrom` with enrolled numeric user IDs
- Periodic or per-request sync from enrollment registry to OpenClaw allowlist
- Fail-closed semantics: stale/expired enrollments must be removed from allowlist

**Evidence needed**:
- Confirmation that OpenClaw v2026.9.8 ingress enforcement runs before history/LLM/tools
- Verification that numeric Telegram user ID allowlist is checked pre-history
- Test that expired enrollments are rejected even if manually added to config

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

**Implemented and tested (116 tests passing)**:
- ✅ Telegram `initData` HMAC-SHA256 validation
- ✅ World ID v4.0 proof verification client
- ✅ Challenge session and enrollment store interfaces
- ✅ Fail-closed admission gate

**Requires integration (evidence-backed, implementation blocked by prerequisites)**:
- ⏳ HTTP server with challenge/complete endpoints
- ⏳ Durable store implementation (SQLite or PostgreSQL)
- ⏳ Telegram Mini App frontend
- ⏳ OpenClaw allowlist sync

**Blocked by external prerequisites**:
- 🚫 World Developer Portal app/RP/action registration
- 🚫 Telegram bot token from @BotFather
- 🚫 Public HTTPS domain/tunnel configuration
- 🚫 Mac mini deployment and supervision setup

## Next Steps for User

1. **Complete World Developer Portal registration**:
   - Create application at https://developer.world.org
   - Record `app_id`, `rp_id`, `signing_key`, and action
   - Choose production or staging environment

2. **Create Telegram verification bot**:
   - Use @BotFather `/newbot` to create new bot
   - Record bot token
   - Store token securely (never commit)

3. **Choose public HTTPS solution**:
   - Evaluate Cloudflare Tunnel vs ngrok vs custom domain
   - Set up tunnel/domain to Mac mini
   - Record public HTTPS URL

4. **Provide prerequisites to development**:
   - Share `app_id`, `rp_id`, action (signing_key remains secret)
   - Share bot token (via secure channel, not public)
   - Share public HTTPS URL
   - Confirm environment choice (production vs staging)

5. **After prerequisites resolved**:
   - Implement HTTP server endpoints
   - Implement durable store (SQLite recommended for simplicity)
   - Create Telegram Mini App frontend
   - Deploy to Mac mini
   - Configure OpenClaw allowlist integration
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
