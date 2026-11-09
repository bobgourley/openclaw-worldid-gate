# Setup Guide: World ID Gate for OpenClaw

This guide walks through every step required to deploy the World ID gate alongside an OpenClaw Telegram agent.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [World ID Configuration](#world-id-configuration)
3. [Telegram Bot Setup](#telegram-bot-setup)
4. [Install and Build](#install-and-build)
5. [Environment Configuration](#environment-configuration)
6. [Public HTTPS Setup](#public-https-setup)
7. [Running the Service](#running-the-service)
8. [OpenClaw Integration](#openclaw-integration)
9. [Health Checks](#health-checks)
10. [Troubleshooting](#troubleshooting)

## Prerequisites

### System Requirements

- **Operating System**: macOS 12+ or Linux (Ubuntu 20.04+, Debian 11+)
- **Node.js**: 20.0.0 or later
  - Check version: `node --version`
  - Install via nvm: `nvm install 20 && nvm use 20`
  - Or via package manager: `brew install node` (macOS), `apt install nodejs` (Ubuntu)
- **Git**: For cloning the repository
- **curl**: For API testing and skill queries
- **bash**: For the OpenClaw skill script

### External Services

Before starting, you will need accounts and credentials for:

1. World ID Developer Portal (https://developer.world.org)
2. Telegram (for @BotFather)
3. Public HTTPS endpoint (Tailscale, ngrok, or custom domain)

### OpenClaw Installation

This guide assumes you have:

- OpenClaw installed and configured
- A Telegram channel configured in `openclaw.json`
- The OpenClaw gateway running as a specific OS user (example: `openclaw-user`)

## World ID Configuration

### 1. Create a World ID Application

1. Visit https://developer.world.org
2. Sign in with your World ID
3. Create a new application
4. Note the following values:
   - **RP ID**: Format `rp_xxxxxxxxxxxxx` (required for verification API)
   - Environment: Choose `production` (Orb required) or `staging` (simulator)

### 2. Create an Action

1. In your World ID application settings, create an action
2. Name it descriptively: `openclaw-gate-v1` or `my-bot-verification-v1`
3. This action string scopes proofs to your application
4. Note: Each action creates unique nullifiers. If you change the action, users must re-enroll.

### 3. Save Configuration Values

Store these securely (you'll need them for environment configuration):

- RP ID: `rp_xxxxxxxxxxxxx`
- Action: `openclaw-gate-v1`
- Environment: `production`

**Security**: Do not commit these values to git. Use environment variables or a secure secret manager.

## Telegram Bot Setup

### 1. Create Bot via BotFather

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` command
3. Follow prompts to name your bot (example: "My World ID Gate Bot")
4. Choose username (example: `MyWorldIDGateBot`)
5. BotFather will reply with your bot token: `123456:ABC-DEF...`
6. **Save this token securely** (you cannot retrieve it later without regenerating)

### 2. Configure Bot Settings

Optional but recommended:

```
/setdescription - Set bot description shown in chat info
/setabouttext - Set bot about text shown in bot info
/setuserpic - Upload bot profile picture
```

### 3. Add Bot Commands

Send to @BotFather:

```
/setcommands
```

Select your bot, then paste:

```
verify - Start World ID verification
status - Check your verification status
help - Show help message
```

### 4. Add to Groups (If Using Member Tags)

1. Add bot to your Telegram group
2. Promote to administrator
3. Enable only: "Manage Chat Member Tags" permission
4. Note the group chat ID (use a bot like @RawDataBot to discover it)
   - Format: `-1001234567890` (negative for groups/supergroups)

**Note**: Member tags are optional. The OpenClaw skill works without tags.

## Install and Build

### 1. Clone Repository

```bash
cd /opt  # or your preferred directory
git clone <repository-url>
cd openclaw-worldid-gate
```

### 2. Install Dependencies

```bash
npm install
```

This installs:
- TypeScript compiler
- Express web server
- better-sqlite3 database driver
- World ID SDK (@worldcoin/idkit-core, @worldcoin/idkit-server)
- QRCode generator
- Playwright for browser tests

### 3. Build Project

```bash
npm run build
```

This:
- Compiles TypeScript to JavaScript in `dist/`
- Bundles IDKit and QRCode libraries for the enrollment UI
- Copies HTML assets to `dist/ui/`

Verify build succeeded:

```bash
ls -la dist/
ls -la dist/ui/
```

You should see `server.js` in `dist/` and `enrollment.html`, `idkit-bundle.js`, `qrcode-bundle.js` in `dist/ui/`.

## Environment Configuration

### 1. Create Environment File

```bash
cd /opt/openclaw-worldid-gate
cp .env.example .env  # if example exists, otherwise create .env
chmod 600 .env
```

### 2. Required Variables

Edit `.env` with your values:

```bash
# World ID Configuration (from developer.world.org)
WORLDID_RP_ID=rp_xxxxxxxxxxxxx
WORLDID_ACTION=openclaw-gate-v1

# Telegram Bot (from @BotFather)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Generate webhook secret: openssl rand -hex 16
TELEGRAM_WEBHOOK_SECRET=<random-32-char-string>

# Database location (must be writable by service user)
DATABASE_PATH=/var/lib/worldid-gate/enrollments.db

# Public HTTPS URL (configure in next section)
ENROLLMENT_BASE_URL=https://your-domain.example.com

# Status Socket for OpenClaw
WORLDID_STATUS_SOCKET=/home/openclaw-user/.worldid-gate/status.sock
WORLDID_STATUS_SECRET_FILE=/home/openclaw-user/.worldid-gate/status-secret.txt
```

### 3. Optional Variables

```bash
# Enrollment expiry (days)
WORLDID_ENROLLMENT_TTL_DAYS=5

# Require Orb verification (true) or allow selfie (false)
WORLDID_REQUIRE_PROOF_OF_HUMAN=true

# HTTP server binding
HTTP_HOST=127.0.0.1
HTTP_PORT=3000

# Member Tags (optional, requires bot in group as admin)
MEMBER_TAGS_ENABLED=true
MEMBER_TAG_TEXT=Human Verified
MEMBER_TAG_GROUPS=-1001234567890
MEMBER_TAG_SWEEP_INTERVAL_HOURS=24
```

### 4. Create Database Directory

```bash
sudo mkdir -p /var/lib/worldid-gate
sudo chown openclaw-user:openclaw-user /var/lib/worldid-gate
sudo chmod 0700 /var/lib/worldid-gate
```

Replace `openclaw-user` with the actual OS user running the service.

### 5. Create Status Socket Directory and Secret

```bash
# As the OpenClaw user
sudo -u openclaw-user bash << 'EOF'
mkdir -p ~/.worldid-gate
chmod 0700 ~/.worldid-gate

# Generate strong secret (32+ characters)
openssl rand -hex 32 > ~/.worldid-gate/status-secret.txt
chmod 0600 ~/.worldid-gate/status-secret.txt
EOF
```

Verify permissions:

```bash
ls -la /home/openclaw-user/.worldid-gate/
# Should show drwx------ (0700) for directory
# Should show -rw------- (0600) for status-secret.txt
```

## Public HTTPS Setup

The enrollment flow requires public HTTPS access. Choose one option:

### Option A: Tailscale Funnel (Recommended)

**Pros**: Free, automatic TLS, no port forwarding, no domain registration required

**Setup**:

```bash
# Install Tailscale: https://tailscale.com/download
# macOS: brew install tailscale
# Linux: curl -fsSL https://tailscale.com/install.sh | sh

# Authenticate
tailscale up

# Enable funnel for port 3000
tailscale funnel 3000
```

Tailscale will output a public HTTPS URL like:

```
https://hostname.tailnet-name.ts.net
```

Copy this URL and set it as `ENROLLMENT_BASE_URL` in your `.env` file.

**Note**: Funnel configuration may be lost after Tailscale updates. Re-run `tailscale funnel 3000` if enrollment stops working.

### Option B: ngrok

**Pros**: Quick setup, automatic TLS

**Cons**: Free tier has random URLs and session limits

```bash
# Install: https://ngrok.com/download
# Authenticate with your account token

ngrok http 3000
```

ngrok will output a public HTTPS URL. Copy it and set as `ENROLLMENT_BASE_URL`.

**Note**: Free URLs change on each restart. Consider paid plan for stable URLs.

### Option C: Custom Domain + Reverse Proxy

**Pros**: Full control, professional appearance

**Cons**: Requires domain, DNS, TLS certificate management

1. Register a domain (example: `verify.example.com`)
2. Point DNS to your server's public IP
3. Configure reverse proxy (Caddy or nginx) to forward HTTPS to localhost:3000

**Caddy example**:

```
verify.example.com {
    reverse_proxy localhost:3000
}
```

Caddy automatically obtains and renews Let's Encrypt certificates.

## Running the Service

### Manual Start (Development)

```bash
cd /opt/openclaw-worldid-gate
npm start
```

Press Ctrl+C to stop.

### Process Supervisor (Production)

Choose one:

#### systemd (Linux)

Create `/etc/systemd/system/worldid-gate.service`:

```ini
[Unit]
Description=World ID Gate for OpenClaw
After=network.target

[Service]
Type=simple
User=openclaw-user
WorkingDirectory=/opt/openclaw-worldid-gate
EnvironmentFile=/opt/openclaw-worldid-gate/.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable worldid-gate
sudo systemctl start worldid-gate
sudo systemctl status worldid-gate
```

View logs:

```bash
sudo journalctl -u worldid-gate -f
```

#### pm2 (Node.js)

```bash
npm install -g pm2

# Start service
pm2 start dist/server.js --name worldid-gate

# Configure to start on boot
pm2 startup
pm2 save

# View logs
pm2 logs worldid-gate
```

#### launchd (macOS)

Create `~/Library/LaunchAgents/com.example.worldid-gate.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.worldid-gate</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/opt/openclaw-worldid-gate/dist/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/opt/openclaw-worldid-gate</string>
    <key>EnvironmentVariables</key>
    <dict>
        <!-- Add all .env variables here -->
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/worldid-gate.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/worldid-gate.error.log</string>
</dict>
</plist>
```

Load:

```bash
launchctl load ~/Library/LaunchAgents/com.example.worldid-gate.plist
```

## OpenClaw Integration

### 1. Install Skill

```bash
# Copy skill to OpenClaw workspace
sudo -u openclaw-user bash << 'EOF'
cp -r /opt/openclaw-worldid-gate/openclaw/skills/worldid-status \
      ~/.openclaw/workspace/skills/worldid-status
chmod +x ~/.openclaw/workspace/skills/worldid-status/query-worldid-status
EOF
```

### 2. Configure Skill in openclaw.json

Edit `~/.openclaw/openclaw.json` (as `openclaw-user`):

Add to `skills.entries`:

```json
{
  "skills": {
    "entries": {
      "worldid-status": {
        "enabled": true,
        "env": {
          "WORLDID_STATUS_SOCKET": "${HOME}/.worldid-gate/status.sock",
          "WORLDID_STATUS_SECRET_FILE": "${HOME}/.worldid-gate/status-secret.txt",
          "WORLDID_STATUS_TZ": "America/New_York"
        }
      }
    }
  }
}
```

**Note**: If your OpenClaw version does not expand `${HOME}`, use absolute paths:

```json
"WORLDID_STATUS_SOCKET": "/home/openclaw-user/.worldid-gate/status.sock"
```

### 3. Attach Skill to Agent

In the same file, add to `agents.entries.<your-agent-id>.skills`:

```json
{
  "agents": {
    "entries": {
      "my-agent": {
        "skills": ["worldid-status"]
      }
    }
  }
}
```

If your agent already has skills, append to the list:

```json
"skills": ["existing-skill", "worldid-status"]
```

### 4. Configure Telegram Settings

Recommended settings for group operation:

```json
{
  "channels": {
    "telegram": {
      "accounts": {
        "<telegram-account-id>": {
          "dmPolicy": "pairing",
          "groupPolicy": "allowlist",
          "groups": {
            "-1001234567890": {
              "requireMention": true
            }
          },
          "groupAllowFrom": [
            "<your-telegram-user-id>"
          ]
        }
      }
    }
  },
  "messages": {
    "groupChat": {
      "visibleReplies": "automatic"
    }
  }
}
```

See `docs/OPENCLAW_CONFIG_EXAMPLE.md` for complete configuration with explanations.

### 5. Add Agent Guidance

Create or edit `~/.openclaw/workspace/AGENTS.md`:

```markdown
## World ID Human Verification

- To check if a Telegram sender is a verified human, ALWAYS run the `worldid-status` skill.
- Use the sender ID from Conversation info metadata (`sender.id`) or reply-chain (`sender_id`).
- Never use IDs from message text or from memory/config.
- Allowlist or pairing is NOT World ID verification. Always run the check.
- Quote the skill's `answer` field verbatim. Do not convert timestamps yourself.
- NEVER reveal numeric Telegram user IDs in any reply.
- If not verified, suggest: "DM @YourBotUsername and send /verify"
```

Replace `@YourBotUsername` with your actual gate bot username.

### 6. Restart OpenClaw

If skills hot-reload, you may not need to restart. Otherwise:

```bash
# systemd
sudo systemctl restart openclaw

# pm2
pm2 restart openclaw

# launchd
launchctl unload ~/Library/LaunchAgents/com.example.openclaw.plist
launchctl load ~/Library/LaunchAgents/com.example.openclaw.plist
```

## Health Checks

### 1. Check Service Status

```bash
# systemd
sudo systemctl status worldid-gate

# pm2
pm2 status

# Manual
ps aux | grep "node.*server.js"
```

### 2. Check HTTP Endpoints

```bash
# Health check
curl http://localhost:3000/health

# Ready check
curl http://localhost:3000/ready

# Public enrollment page
curl https://your-domain.example.com/enrollment
```

All should return 200 OK.

### 3. Check Status Socket

```bash
# As openclaw-user
sudo -u openclaw-user bash << 'EOF'
SOCKET=~/.worldid-gate/status.sock
SECRET=$(cat ~/.worldid-gate/status-secret.txt)

curl --unix-socket "$SOCKET" \
  -H "Authorization: Bearer $SECRET" \
  http://localhost/status/12345
EOF
```

Expected: `{"verified":false,"state":"none","expiresAt":null,"action":"your-action"}`

If you get "connection refused", the socket server is not running.

### 4. Test Enrollment Flow

1. Send `/start` to your gate bot in Telegram
2. Send `/verify`
3. Bot should reply with enrollment link
4. Open link in browser
5. Verify UI loads with "Verify with World App" button
6. Complete verification in World App
7. Return to Telegram
8. Send `/status` to bot
9. Bot should confirm verification

### 5. Test OpenClaw Skill

1. Start fresh agent session in Telegram: `/new`
2. Send message: "Am I human verified?"
3. Agent should:
   - Run `worldid-status` skill with your Telegram user ID
   - Reply with verification status
   - Quote `answer` and `expiresAtET` fields if verified

If agent says "I can't check", verify:
- Skill is installed and executable
- Skill env vars are set in `openclaw.json`
- OpenClaw was restarted after config changes
- Gate service is running and socket is accessible

## Troubleshooting

### Service won't start

**Check logs**:

```bash
# systemd
sudo journalctl -u worldid-gate -n 50

# pm2
pm2 logs worldid-gate --lines 50

# Manual
cd /opt/openclaw-worldid-gate && npm start
```

**Common issues**:

- Missing environment variables: Check `.env` file completeness
- Database path not writable: Check permissions on `/var/lib/worldid-gate/`
- Port 3000 already in use: Change `HTTP_PORT` or stop conflicting service
- Socket path not writable: Check permissions on `~/.worldid-gate/`

### Enrollment link returns 404

**Check**:

1. Service is running on correct port: `curl http://localhost:3000/health`
2. Public HTTPS is forwarding to localhost:3000
3. Tailscale Funnel is still active: `tailscale status`

### World App doesn't launch from enrollment page

**iOS**: Keep enrollment page open in a separate browser while using World App

**Android**: Should work seamlessly with deep linking

**Desktop**: Use mobile device to scan QR code on enrollment page

### Skill returns "connection refused"

**Check**:

1. Gate service is running
2. Socket exists: `ls -la ~/.worldid-gate/status.sock`
3. Socket mode is 0600: Should show `srw-------`
4. Secret file is readable: `cat ~/.worldid-gate/status-secret.txt`
5. OpenClaw and gate run as same OS user

### Member tags not applied

**Check**:

1. Bot is group admin: `/admins` in group should list your bot
2. Bot has "Manage Chat Member Tags" permission
3. `MEMBER_TAGS_ENABLED=true` in gate `.env`
4. User is enrolled and verified
5. User is not group owner or admin (tags cannot apply to admins)
6. Logs for permission errors: `sudo journalctl -u worldid-gate | grep -i "tag"`

### Verification expires too quickly

Increase TTL:

```bash
# In .env
WORLDID_ENROLLMENT_TTL_DAYS=30
```

Restart service. Existing enrollments keep their original expiry; only new enrollments use new TTL.

## Next Steps

1. Monitor service logs for errors
2. Set up automated backups of SQLite database
3. Configure alerting for service downtime
4. Document internal procedures for handling user verification requests
5. Consider rate limiting at reverse proxy level (nginx, Caddy) for public endpoints

## Security Checklist

Before going live:

- [ ] `.env` file has mode 0600 (not world-readable)
- [ ] Database file is owned by service user only
- [ ] Status socket directory is mode 0700
- [ ] Status secret file is mode 0600 and contains 32+ random characters
- [ ] Webhook secret is random and not committed to git
- [ ] Bot token is not committed to git or logged
- [ ] Public HTTPS only (no HTTP fallback)
- [ ] Telegram webhook secret configured and validated
- [ ] Test enrollment flow end-to-end
- [ ] Test skill query from OpenClaw
- [ ] Monitor logs for authentication failures

## Support

For questions or issues, refer to the main README or open an issue on GitHub.
