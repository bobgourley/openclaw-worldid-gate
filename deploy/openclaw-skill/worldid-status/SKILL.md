---
name: worldid-status
description: Query World ID enrollment status for Telegram users
metadata:
  openclaw:
    os: ["darwin"]
    requires:
      bins: ["curl"]
      env: ["WORLDID_STATUS_SOCKET", "WORLDID_STATUS_SECRET_FILE"]
---

# World ID Status Query Skill

Query World ID enrollment status for Telegram users via a private Unix domain socket.

**Agent Access**: This skill is available to the `main` agent (Finn) only.

## Installation

### For Agent `main` (Finn)

1. Copy this skill directory to Finn's workspace skills folder:

```bash
cp -r /path/to/worldid-gate/deploy/openclaw-skill/worldid-status \
      /Users/finn/.openclaw/workspace/skills/worldid-status
```

2. Add environment variables to Finn's OpenClaw configuration (`openclaw.json`) under `skills.entries.worldid-status.env`:

```json
{
  "skills": {
    "entries": {
      "worldid-status": {
        "env": {
          "WORLDID_STATUS_SOCKET": "/Users/finn/.worldid-gate/status.sock",
          "WORLDID_STATUS_SECRET_FILE": "/Users/finn/.worldid-gate/status-secret.txt"
        }
      }
    }
  }
}
```

3. **APPEND** `"worldid-status"` to the existing `agents.entries.main.skills` array (do not replace the existing list):

```json
{
  "agents": {
    "entries": {
      "main": {
        "skills": ["worldid-status"]
      }
    }
  }
}
```

4. Restart Finn to load the skill.

### Required Permissions

The skill requires:
- **Execute permission** on the `query-worldid-status` script
- **Read permission** on `WORLDID_STATUS_SECRET_FILE`
- **Write permission** on the Unix domain socket at `WORLDID_STATUS_SOCKET`

No other filesystem, network, or system access required. The script is read-only and makes no modifications to the gate service or database.

## When to Use

Use this skill to determine if a Telegram message sender or person being replied to is a World ID proven human.

**Primary purpose:** Help Finn decide who to respond to and how to treat humans versus bots.

**Common triggers:**
- Check if the current message sender is verified
- Check if someone being replied to is verified
- Decide whether to engage based on human verification status

## How It Works

This skill queries a private Unix domain socket endpoint that is:
- **NOT accessible via the public HTTP server** (localhost:3000)
- Authenticated with a bearer token from environment
- Returns enrollment status without exposing sensitive data (no nullifiers, proofs, nonces)

## Usage

Call the script from the skill base directory with a numeric Telegram user ID:

```bash
{baseDir}/query-worldid-status <telegram_user_id>
```

### How to Identify People

**Always use `sender.id` from the host's Conversation info block:**

When checking the current sender:
```
sender.id = 123456789
```

When checking someone being replied to, use `sender_id` from the reply-chain block:
```
reply-chain: sender_id=987654321
```

**NEVER:**
- Use an ID typed in message text
- Use @username (not supported, usernames are mutable)
- Repeat the numeric ID in your replies to the user

### Why Numeric IDs Only

**This skill requires numeric Telegram user IDs only.** It does NOT support @username lookups.

**Why:**
- Usernames are mutable (users can change them anytime)
- The gate stores enrollments by immutable numeric user IDs only
- The Telegram Bot API cannot resolve @username to numeric ID without prior interaction

**Privacy:** The gate never logs or exposes Telegram user IDs. Only the `verified` status and expiration timestamp are returned.

## Guidance for Finn

**What `verified: true` means:**
- This Telegram account was verified by a unique Orb-verified human within the enrollment window (currently 5 days)
- The enrollment has not expired
- The account could still be automated afterward, so use judgment

**What `verified: false` means:**
- Could be a bot
- Could be an unenrolled person (has not completed World ID verification)
- Could be an expired enrollment
- Could be a revoked enrollment (no longer valid)

**How to handle:**
- Use verification status to decide who to respond to and how
- Treat verified humans differently from unverified senders
- **NEVER reveal numeric user IDs in your responses**
- **NEVER repeat the ID you queried in messages to the user**

**Response format:**
```json
{
  "verified": true,
  "state": "active",
  "expiresAt": 1735689600,
  "action": "openclaw-enroll-v3"
}
```

**States:**
- `active`: User is verified and enrollment has not expired
- `expired`, `revoked`, `none`: Not currently verified

**Note:** Only `verified: true` with `state: "active"` indicates current valid verification.

## Security

- **Agent allowlist:** Only agent `main` (Finn) can use this skill
- The bearer token is read from a file path specified in `WORLDID_STATUS_SECRET_FILE`
- The token is NEVER passed via command-line arguments (preventing process list exposure)
- The helper script uses curl with `--header @-` to keep secrets out of argv
- All queries are rate-limited:
  - 100 requests per minute per endpoint
  - 1000 requests per minute globally
  - Stale limiter entries are automatically evicted
- The Unix domain socket is created with mode 0600 (owner-only access)
- Socket directory is mode 0700 (owner-only access)
- Constant-time authentication prevents timing attacks

## Configuration

Required environment variables (set in OpenClaw profile for agent `main`):

```bash
WORLDID_STATUS_SOCKET=/Users/finn/.worldid-gate/status.sock
WORLDID_STATUS_SECRET_FILE=/Users/finn/.worldid-gate/status-secret.txt
```

The gate service must be configured with matching values:

```bash
WORLDID_STATUS_SOCKET=/Users/finn/.worldid-gate/status.sock
WORLDID_STATUS_SECRET_FILE=/Users/finn/.worldid-gate/status-secret.txt
```

**Important:** Both the gate service and Finn must use the SAME socket path and secret file. The secret file must:
- Contain at least 32 characters
- Have mode 0600 (owner-only read/write)
- Be readable by both the gate service and Finn's process user

## Privacy

This endpoint returns **privacy-safe fields only**:
- ✅ `verified` (boolean)
- ✅ `state` (enum: active/expired/revoked/none)
- ✅ `expiresAt` (unix timestamp)
- ✅ `action` (string: the enrollment action scope)

**Never exposed:**
- ❌ World ID nullifiers
- ❌ Proof payloads
- ❌ Session IDs
- ❌ Challenge nonces
- ❌ Signatures

## Error Handling

The helper script exits with non-zero status on errors:
- **Exit 1:** Invalid arguments
- **Exit 2:** Authentication failed (invalid or missing token)
- **Exit 3:** Network error or socket unavailable
- **Exit 4:** Rate limit exceeded

Check exit status in your agent code to handle failures appropriately.
