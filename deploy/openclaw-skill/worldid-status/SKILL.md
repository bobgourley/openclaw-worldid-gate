# World ID Status Query Skill

Query World ID enrollment status for Telegram users via a private Unix domain socket.

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

Call the `query-worldid-status` helper:

```bash
query-worldid-status <telegram_user_id>
```

**Example:**
```bash
query-worldid-status 123456789
```

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

- The bearer token is provided via `skills.entries.worldid-status.apiKey` in OpenClaw config
- Token is read from `primaryEnv` and NEVER put into prompts or logs
- The skill helper script reads the socket path and token from environment variables
- All queries are rate-limited (100 requests per minute per endpoint)

## Configuration

Required environment variables (set in OpenClaw profile):

```bash
WORLDID_STATUS_SOCKET=/path/to/worldid-status.sock
WORLDID_STATUS_SECRET=<bearer-token>
```

The gate service must also be configured with:

```bash
WORLDID_STATUS_SOCKET=/path/to/worldid-status.sock
WORLDID_STATUS_SECRET_FILE=/path/to/secret.txt  # File containing bearer token (mode 0600)
```

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
