---
name: World ID Status Query
description: Query World ID enrollment status for Telegram users
agents:
  allow:
    - main
tools:
  query-worldid-status:
    description: Check if a Telegram user is Human Verified via World ID
    permission: exec
---

# World ID Status Query Skill

Query World ID enrollment status for Telegram users via a private Unix domain socket.

**Agent Access**: This skill is available to the `main` agent (Finn) only.

## Installation

### For Agent `main` (Finn)

1. Copy this skill directory to Finn's workspace skills folder:

```bash
cp -r /path/to/worldid-gate/deploy/openclaw-skill/worldid-status \
      /path/to/finn-workspace/skills/worldid-status
```

2. Set required environment variables in Finn's OpenClaw profile:

```bash
export WORLDID_STATUS_SOCKET=/var/run/worldid-gate/status.sock
export WORLDID_STATUS_SECRET_FILE=/etc/worldid-gate/status-secret.txt
```

3. Ensure the secret file is readable by Finn's process user.

4. Restart Finn to load the skill.

5. Verify the skill is available:

```bash
# Finn should now be able to call:
query-worldid-status 123456789
```

### Required Permissions

The `query-worldid-status` tool requires:
- **Execute permission** on the script itself
- **Read permission** on `WORLDID_STATUS_SECRET_FILE`
- **Write permission** on the Unix domain socket at `WORLDID_STATUS_SOCKET`

No other filesystem, network, or system access required. The script is read-only and makes no modifications to the gate service or database.

## When to Use

Use this skill when you need to check if a Telegram user has completed World ID verification.

**Common triggers:**
- "Is user 123456789 verified?"
- "Check World ID status for user X"
- "Has this user completed enrollment?"

## How It Works

This skill queries a private Unix domain socket endpoint that is:
- **NOT accessible via the public HTTP server** (localhost:3000)
- Authenticated with a bearer token from environment
- Returns enrollment status without exposing sensitive data (no nullifiers, proofs, nonces)

## Usage

Call the `query-worldid-status` helper with a numeric Telegram user ID:

```bash
query-worldid-status <telegram_user_id>
```

**Example:**
```bash
query-worldid-status 123456789
```

### Username Limitation

**This skill requires numeric Telegram user IDs only.** It does NOT support @username lookups.

**Why:**
- Usernames are mutable (users can change them anytime)
- The gate stores enrollments by immutable numeric user IDs only
- Username resolution would require real-time Telegram API calls with potential for:
  - Network failures and delays
  - Username enumeration attacks
  - Privacy leakage
  - Rate limiting

**Workaround:** If you only have a username, use the Telegram Bot API `getChat` or `getChatMember` methods to resolve it to a numeric user ID first, then query the gate with that ID.

**Privacy note:** The gate never logs or exposes Telegram user IDs in responses. Only the `verified` status and expiration timestamp are returned.

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
- `expired`: Enrollment has expired
- `revoked`: Enrollment was revoked by administrator
- `none`: No enrollment found

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
WORLDID_STATUS_SOCKET=/var/run/worldid-gate/status.sock
WORLDID_STATUS_SECRET_FILE=/etc/worldid-gate/status-secret.txt
```

The gate service must be configured with matching values:

```bash
WORLDID_STATUS_SOCKET=/var/run/worldid-gate/status.sock
WORLDID_STATUS_SECRET_FILE=/etc/worldid-gate/status-secret.txt
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
