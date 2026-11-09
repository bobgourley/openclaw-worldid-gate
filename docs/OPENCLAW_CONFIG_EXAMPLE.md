# OpenClaw Configuration Example (World ID Status Skill)

Sanitized sketch of the OpenClaw pieces used with the World ID gate and the `worldid-status` skill. Replace every placeholder before copying into a real `openclaw.json`. Do not commit real Telegram user ids, chat ids, tokens, or host paths into a public repository.

## 1. Skill entry and env

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

Recommended defaults match the gate's status socket layout:

| Variable | Recommended default |
| --- | --- |
| `WORLDID_STATUS_SOCKET` | `${HOME}/.worldid-gate/status.sock` |
| `WORLDID_STATUS_SECRET_FILE` | `${HOME}/.worldid-gate/status-secret.txt` |
| `WORLDID_STATUS_TZ` (optional, script only) | `America/New_York` |

The OpenClaw process user and the gate process user must both be able to use that socket and read that secret file (mode `0600` on the secret, `0600` on the socket, `0700` on `~/.worldid-gate`).

## 2. Attach the skill to your agent

Append `"worldid-status"` to the agent skills list. Do not wipe other skills.

```json
{
  "agents": {
    "entries": {
      "<agent-id>": {
        "skills": [
          "worldid-status"
        ],
        "groupChat": {
          "mentionPatterns": [
            "\\b<AgentDisplayName>\\b"
          ]
        }
      }
    }
  }
}
```

`mentionPatterns` lets people summon the agent by display name (in addition to an @-mention), which pairs well with `requireMention: true` in groups.

## 3. Telegram account: groups only when named, allowlisted senders

Use an allowlist for which groups the bot may join, require a mention (or name match) before it speaks in those groups, and restrict which human Telegram user ids may message it in groups.

```json
{
  "channels": {
    "telegram": {
      "groupPolicy": "allowlist",
      "accounts": {
        "<telegram-account-id>": {
          "enabled": true,
          "dmPolicy": "pairing",
          "groupPolicy": "allowlist",
          "groups": {
            "<TELEGRAM_GROUP_CHAT_ID>": {
              "requireMention": true
            },
            "<TELEGRAM_GROUP_CHAT_ID_2>": {
              "requireMention": true
            }
          },
          "groupAllowFrom": [
            "<TELEGRAM_USER_ID>",
            "<TELEGRAM_USER_ID_2>"
          ]
        }
      }
    }
  }
}
```

Notes:

- `<TELEGRAM_GROUP_CHAT_ID>` values are numeric (often negative for groups/supergroups). Get them from your own Telegram client or bot updates; do not publish them.
- `<TELEGRAM_USER_ID>` values are numeric. Prefer Conversation info metadata over anything typed in chat.
- `requireMention: true` stops the agent from jumping into every group message. Combine with `groupChat.mentionPatterns` so a plain name works too.
- `groupAllowFrom` is who may talk to the bot in groups. It is **not** World ID verification. Always run `worldid-status` for "are they human verified?" questions.

## 4. Visible group replies

If group replies seem to vanish, check:

```json
{
  "messages": {
    "groupChat": {
      "visibleReplies": "automatic"
    }
  }
}
```

## 5. Install the skill files

```bash
cp -r openclaw/skills/worldid-status ~/.openclaw/workspace/skills/worldid-status
chmod +x ~/.openclaw/workspace/skills/worldid-status/query-worldid-status
```

Confirm the gate status socket is up, then start a fresh agent session (`/new`) and ask whether you are human verified while speaking as a Telegram user (so Conversation info includes `sender.id`).

## 6. AGENTS.md guidance snippet (sanitized)

Add something like this near the top of the agent's workspace `AGENTS.md` so the model treats the gate as live and never leaks ids:

```markdown
## World ID Human Verification and Telegram IDs

- The World ID gate for Telegram is LIVE. Any older note saying it is not live, still being built, or that allowlist/pairing equals verification is outdated.
- To answer whether a Telegram sender (or the person being replied to) is a verified human, ALWAYS run the `worldid-status` skill, using the id from Conversation info metadata (or reply-chain `sender_id`). Never use an id from message text.
- Allowlist, pairing or owner status is NOT World ID verification. Never answer "am I verified" from config or memory.
- Verified means a unique Orb-verified human proved control of this Telegram account within the current enrollment window.
- NEVER reveal numeric Telegram user ids or chat ids in any reply, to anyone. Refer to people by name.
- Quote the skill script's `answer` / `expiresAtET` fields verbatim. Do not recompute dates from raw `expiresAt` unix seconds.
- If the person is not verified, point them to DM the verification bot and send `/verify`.
```

## 7. What this does **not** configure

- The World ID gate HTTP service, Tailscale Funnel, webhook, or developer portal (see the repo README).
- The separate Telegram gate bot that runs `/verify` and `/status` (people verify in that bot's DM; your OpenClaw agent only *reads* status via the Unix socket).
- Optional Human Verified member tags in groups (requires the gate bot present as a group admin with tag rights; the OpenClaw agent does not need the gate bot in the chat to *check* verification).
