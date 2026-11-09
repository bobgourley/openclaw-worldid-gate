# Deployment Guide

This document describes the new environment variables and deployment requirements for the World ID gate service.

## New Environment Variables

The following environment variables must be added to `bin/launch-private-service.cjs` on the Mac Mini deployment:

### Status Socket Configuration

```bash
# Enable private status socket for OpenClaw integration
WORLDID_STATUS_SOCKET=/path/to/worldid-status.sock
WORLDID_STATUS_SECRET_FILE=/path/to/status-secret.txt
```

**WORLDID_STATUS_SOCKET**: Path to Unix domain socket for private enrollment status queries. Must be accessible by OpenClaw process. Created with mode 0600 (owner-only).

**WORLDID_STATUS_SECRET_FILE**: Path to file containing bearer authentication secret (minimum 32 characters). File must have mode 0600. The secret is loaded at startup and used for constant-time authentication.

**Security Notes**:
- The status socket is **NOT** mounted on the public HTTP server (port 3000)
- All queries require bearer authentication
- Rate limited to 100 requests per minute per endpoint
- Only returns privacy-safe fields (no nullifiers, proofs, or session IDs)

### Member Tags Configuration

```bash
# Enable member tags (requires bot admin with can_manage_tags)
MEMBER_TAGS_ENABLED=true
MEMBER_TAG_TEXT="Human Verified"
MEMBER_TAG_SWEEP_INTERVAL_HOURS=24
```

**MEMBER_TAGS_ENABLED**: Set to `true` to enable automatic member tag management. Requires the bot to be an administrator in the target chat with `can_manage_tags` permission.

**MEMBER_TAG_TEXT**: Text to display on member tags. Maximum 16 characters, no emoji allowed. Default: `Human Verified`

**MEMBER_TAG_SWEEP_INTERVAL_HOURS**: How often to run the expiry sweeper that removes tags from expired/revoked enrollments. Default: 24 hours. The sweeper runs once at startup and then periodically at this interval.

**Note**: OPENCLAW_ALLOWED_GROUP must be set when member tags are enabled. This is the chat where tags will be applied.

## OpenClaw Skill Configuration

The status query functionality is exposed to OpenClaw agents via a skill at `deploy/openclaw-skill/worldid-status/`.

Add to OpenClaw configuration:

```yaml
skills:
  entries:
    worldid-status:
      apiKey:
        primaryEnv: WORLDID_STATUS_SECRET
      path: /path/to/worldid-gate/deploy/openclaw-skill/worldid-status
```

The skill provides the `query-worldid-status` helper script that OpenClaw agents can use to check enrollment status.

## Status Socket Response Format

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

**Privacy**: No nullifiers, proofs, session IDs, nonces, signatures, or tokens are ever returned.

## Member Tags Behavior

### Tag Application
- Applied immediately after successful enrollment
- Applied after session renewal or reactivation
- Skipped for administrators and creators
- Skipped if user not in group
- Logs conflict if different tag already exists (does not overwrite)

### Tag Removal
- Removed immediately on enrollment revocation
- Removed by expiry sweeper (runs at startup + periodic interval)
- Only removed if the gate applied it (tracked in member_tags table)
- Only removed if the live tag still matches what the gate applied

### Failure Handling
- **Tag operations never block enrollment**
- If bot lacks can_manage_tags permission at startup, tagging is disabled with a warning
- Tag application/removal failures are logged but do not prevent enrollment success
- The service continues normally even if Telegram API calls fail

## Migration Notes

### Schema v4 Migration

The service automatically migrates the database to schema v4 on first startup after deployment. This migration:

- Creates the `member_tags` table for tracking applied tags
- Is idempotent (safe to run multiple times)
- Preserves all existing enrollment data
- Does not require downtime

No manual intervention required.

## Logging

### Status Socket Logs
- Socket binding logged at startup: `[StatusSocket] Listening on /path/to/socket (mode 0600)`
- Each query is rate-limited but not individually logged (privacy consideration)
- Authentication failures and errors are logged

### Member Tags Logs
- Permission check result logged at startup
- Sweeper interval logged at startup: `[MemberTag] Permission check passed, starting sweeper (interval: 24h)`
- Tag conflicts logged: `[MemberTag] Tag conflict: user 123 has different tag "Other Tag"`
- Tag operation failures logged: `[MemberTag] Failed to apply tag (enrollment still valid): <error>`
- Sweeper runs are not logged (reduce noise)

### OpenClaw Dispatcher Context
- For each admitted message, logs: `[gate] sender World ID verified, expires YYYY-MM-DD`
- No nullifiers, user IDs, or sensitive data in logs
- Helps operators understand admission flow without exposing PII

## Security Checklist

Before deploying to production:

- [ ] Status socket path is in a secure directory (not world-readable)
- [ ] Status secret file has mode 0600 and contains strong secret (32+ characters)
- [ ] Status secret is not committed to git or logged
- [ ] OpenClaw profile has WORLDID_STATUS_SOCKET and WORLDID_STATUS_SECRET environment variables set
- [ ] Bot is administrator in target chat with can_manage_tags permission
- [ ] MEMBER_TAG_TEXT is appropriate for your community (16 chars max, no emoji)
- [ ] Test status socket with `curl --unix-socket /path/to/socket -H "Authorization: Bearer <secret>" http://localhost/status/123`
- [ ] Verify /status/123 returns 404 on public HTTP server (port 3000)
- [ ] Verify member tags are applied after enrollment
- [ ] Verify member tags are removed on revocation

## Rollback Plan

If issues arise:

1. **Disable member tags**: Set `MEMBER_TAGS_ENABLED=false` and restart
2. **Disable status socket**: Remove `WORLDID_STATUS_SOCKET` and `WORLDID_STATUS_SECRET_FILE` env vars and restart
3. Both features are independent and can be disabled separately without affecting core enrollment functionality
4. Database schema v4 migration is forward-only (no rollback), but member_tags table can be safely ignored if feature is disabled
