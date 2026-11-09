---
name: worldid-status
description: "REQUIRED for any question about whether a Telegram person is a verified human: am I verified, am I human verified, is this person human, is the sender of this message a real human or a bot, human verified, proven human, World ID, Orb verified. Runs a local check against the live World ID gate using the sender id from Conversation info metadata (or reply-chain sender_id). Allowlist, pairing or owner status is NOT human verification."
metadata:
  openclaw:
    os: ["darwin", "linux"]
    requires:
      bins: ["curl"]
      env: ["WORLDID_STATUS_SOCKET", "WORLDID_STATUS_SECRET_FILE"]
---

# World ID Status Query Skill

## Quick use (read this first)

Whenever anyone asks whether they, the sender, or a replied-to person is human verified / a verified human / World ID verified / a real human versus a bot:

1. Take the numeric id from the host Conversation info metadata (`sender.id` / senderId) for the current sender, or `sender_id` from the reply-chain block for the replied-to person. Never use an id typed in message text. NEVER invent, guess or reuse an example id: if the metadata has no sender id (for example a CLI, cron or internal run), do not run the script; say you cannot check verification from this context.
   Hard check before step 2: you must be able to point to a `sender_id` / `sender.id` / senderId field in the Conversation info (untrusted metadata) block attached to THIS message, or a reply-chain `sender_id`. No such field means no check: reply "I can't check World ID verification from this context." You do not know anyone's Telegram id from memory, USER.md, config or allowlists, so never type one yourself.
2. Run it with the `exec` tool (this skill is not a callable tool id): `{baseDir}/query-worldid-status <id>` (or the installed path under `~/.openclaw/workspace/skills/worldid-status/query-worldid-status`). Env vars are already set by OpenClaw. Do not write the id in any text you produce, including progress notes like "your sender ID is ...".
3. Answer from the script output only, by quoting it. The output includes `answer` and `expiresAtET` (already converted to Eastern Time by default). Reply with the `answer` text, copying the `expiresAtET` date verbatim (for example "Yes, you're World ID verified, active until Wed Dec 9, 2026 8:42 AM ET."). NEVER convert, compute or restate `expiresAt` (raw Unix seconds) yourself; past attempts produced wrong dates. If `answer` starts with NOT VERIFIED, say they are not currently verified and suggest they DM the verification bot and send /verify.
4. Never say, print or repeat the numeric Telegram id, the secret, or the socket path. Refer to people by name.
5. Being the owner, on an allowlist, or paired is NOT World ID verification. Always run the check; never answer from config or memory.
6. If the script exits non-zero, say the verification check is unavailable right now. Do not guess.

Verified means a unique Orb-verified human proved control of this Telegram account within the last enrollment window (default 5 days). The account could still be automated afterward, so use judgment.

Query World ID enrollment status for Telegram users via a private Unix domain socket.

**Agent Access**: Attach this skill only to the OpenClaw agent(s) that should be allowed to check verification (typically your main Telegram agent).

## Installation

### For your main OpenClaw agent

1. Copy this skill directory into the agent's workspace skills folder:

```bash
cp -r /path/to/openclaw-worldid-gate/openclaw/skills/worldid-status \
      ~/.openclaw/workspace/skills/worldid-status
chmod +x ~/.openclaw/workspace/skills/worldid-status/query-worldid-status
```

2. Add environment variables to OpenClaw configuration (`openclaw.json`) under `skills.entries.worldid-status.env`. Recommended defaults (override if your gate uses different paths):

```json
{
  "skills": {
    "entries": {
      "worldid-status": {
        "enabled": true,
        "env": {
          "WORLDID_STATUS_SOCKET": "${HOME}/.worldid-gate/status.sock",
          "WORLDID_STATUS_SECRET_FILE": "${HOME}/.worldid-gate/status-secret.txt"
        }
      }
    }
  }
}
```

If your OpenClaw build does not expand `${HOME}`, write the absolute path for the OS user that runs both the gate and the OpenClaw gateway (example: `/home/<openclaw-user>/.worldid-gate/status.sock`).

3. **APPEND** `"worldid-status"` to the existing `agents.entries.<agent-id>.skills` array (do not replace the existing list):

```json
{
  "agents": {
    "entries": {
      "<agent-id>": {
        "skills": ["worldid-status"]
      }
    }
  }
}
```

4. The skill typically hot-reloads (no gateway restart needed). Confirm with a fresh agent session (`/new`) before relying on it.

See `docs/OPENCLAW_CONFIG_EXAMPLE.md` for a fuller Telegram + OpenClaw configuration sketch (group allowlists, require-mention, visible replies, and AGENTS.md guidance).

### Required Permissions

The skill requires:
- **Execute permission** on the `query-worldid-status` script
- **Read permission** on `WORLDID_STATUS_SECRET_FILE`
- **Connect/write permission** on the Unix domain socket at `WORLDID_STATUS_SOCKET`

No other filesystem, network, or system access required. The script is read-only and makes no modifications to the gate service or database.

## When to Use

Use this skill to determine if a Telegram message sender or person being replied to is a World ID proven human.

**Primary purpose:** Help your OpenClaw agent decide who to respond to and how to treat humans versus bots in chats where multiple humans and bots interact.

**Common triggers:**
- Check if the current message sender is verified
- Check if someone being replied to is verified
- Decide whether to engage based on human verification status

## How It Works

This skill queries a private Unix domain socket endpoint that is:
- **NOT accessible via the public HTTP server**
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
sender.id = <numeric id from Conversation info>
```

When checking someone being replied to, use `sender_id` from the reply-chain block:
```
reply-chain: sender_id=<numeric id from reply-chain block>
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

**Privacy:** Prefer never logging Telegram user IDs in agent replies. Only the `verified` status, state, expiration, and a preformatted `answer` line are meant for the user.

## Guidance for the agent

**What `verified: true` means:**
- This Telegram account was verified by a unique Orb-verified human within the enrollment window
- The enrollment has not expired
- The account could still be automated afterward, so use judgment

**What `verified: false` means:**
- Not currently verified
- Could be a bot
- Could be an unenrolled person (has not completed World ID verification)
- Could be an expired enrollment

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
  "expiresAt": "<unix seconds, do not convert>",
  "action": "openclaw-enroll-v3",
  "expiresAtET": "Wed Dec 9, 2026 8:42 AM ET",
  "answer": "VERIFIED HUMAN: World ID verified (unique Orb-verified human), active until Wed Dec 9, 2026 8:42 AM ET"
}
```

**States:**
- `active`: User is verified and enrollment has not expired
- `expired`, `revoked`, `none`: Not currently verified

**Note:** Only `verified: true` with `state: "active"` indicates current valid verification.

## Security

- **Agent allowlist:** Only attach this skill to agents that should be allowed to query verification
- The bearer token is read from a file path specified in `WORLDID_STATUS_SECRET_FILE`
- The token is NEVER passed via command-line arguments (preventing process list exposure)
- The helper script uses curl with `--header @-` to keep secrets out of argv
- All queries are rate-limited by the gate service
- The Unix domain socket should be created with mode 0600 (owner-only access)
- Socket directory should be mode 0700 (owner-only access)
- Constant-time authentication on the gate prevents timing attacks

## Configuration

Required environment variables (set in OpenClaw for the agent that uses this skill):

```bash
WORLDID_STATUS_SOCKET=${HOME}/.worldid-gate/status.sock
WORLDID_STATUS_SECRET_FILE=${HOME}/.worldid-gate/status-secret.txt
```

Optional (used by the helper script when formatting `expiresAtET`):

```bash
# Default: America/New_York
WORLDID_STATUS_TZ=America/New_York
```

The gate service must be configured with matching socket and secret paths.

**Important:** Both the gate service and OpenClaw must use the SAME socket path and secret file. The secret file must:
- Contain at least 32 characters
- Have mode 0600 (owner-only read/write)
- Be readable by both the gate service and the OpenClaw process user

## Privacy

This endpoint returns **privacy-safe fields only**:
- `verified` (boolean)
- `state` (enum: active/expired/revoked/none)
- `expiresAt` (unix timestamp)
- `action` (string: the enrollment action scope)

Plus helper fields added by this script (not from the gate):
- `expiresAtET` (preformatted local time string)
- `answer` (ready-to-quote status line)

**Never exposed:**
- World ID nullifiers
- Proof payloads
- Session IDs
- Challenge nonces
- Signatures

## Error Handling

The helper script exits with non-zero status on errors:
- **Exit 1:** Invalid arguments
- **Exit 2:** Authentication failed (invalid or missing token)
- **Exit 3:** Network error or socket unavailable
- **Exit 4:** Rate limit exceeded

Check exit status in your agent code to handle failures appropriately.
