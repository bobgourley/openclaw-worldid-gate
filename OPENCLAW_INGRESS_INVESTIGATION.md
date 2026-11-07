# OpenClaw 2026.9.8 Ingress Enforcement Investigation

**Source**: OpenClaw commit `fc23bc864e4553c2d215e479eeec47b67a0bf943`  
**Version**: 2026.9.8 (verified in `package.json`)  
**Investigation Date**: 2026-11-07  
**Scope**: READ-ONLY source investigation, no deployment, no live testing

## Executive Summary

**SAFE CLAIM**: OpenClaw Telegram ingress enforces authorization BEFORE history/session access.  
**UNKNOWN**: Whether supported extension/hook exists for dynamic World ID verification at that boundary.  
**FINDING**: Current authorization uses static config (`allowFrom`, `groupPolicy`, `groups`). No documented extension point found for pre-history dynamic verification.

## Ingress Flow with GitHub Permalinks

### 1. Telegram Update Receipt → Authorization → History Access

**Flow documented in**: `extensions/telegram/src/bot-handlers.inbound-pipeline.ts`

```
Line 141: authorizeInboundMessage() called (for location/edit updates)
Line 174: authorizeInboundMessage() called (for regular inbound messages)
Line 186: if (!gate.allowed) { return { kind: "ignored" }; } ← EARLY EXIT if unauthorized
Line 198: resolveTelegramSessionState() ← HISTORY ACCESS (only after authorization succeeds)
Line 209: resolvePromptContextAmbientWatermark() ← HISTORY WATERMARK
```

**GitHub permalink** (lines 130-220):  
https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-handlers.inbound-pipeline.ts#L130-L220

**Key evidence**: Authorization gate check (`!gate.allowed`) returns early at line 186, preventing `resolveTelegramSessionState` (line 198) from executing.

### 2. Authorization Implementation

**File**: `extensions/telegram/src/bot-handlers.inbound-authorization.ts`

```
Line 320: authorizeInboundMessage() function begins
Line 325-333: resolveTelegramEventAuthorizationContext() - resolves static config
Line 347-351: resolveTelegramDmAllow() - resolves DM allowlist from static config
Line 358-376: shouldSkipGroupMessage() - checks group allowlist from static config
Line 385-395: enforceTelegramDmAccess() - DM pairing enforcement
```

**GitHub permalink** (lines 320-400):  
https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/bot-handlers.inbound-authorization.ts#L320-L400

**Key evidence**: Authorization uses `groupConfig`, `topicConfig`, `effectiveGroupAllow`, `effectiveDmAllow` resolved from static configuration. No dynamic lookup/verification hook observed.

### 3. Config Schema for Groups

**File**: `extensions/telegram/src/config-schema.ts`

```
Line 93: groupPolicy: GroupPolicySchema.optional() (topic level)
Line 96: allowFrom: z.array(z.union([z.string(), z.number()])).optional() (topic level)
Line 107: groupPolicy: GroupPolicySchema.optional() (group level)
Line 131: allowFrom: z.array(z.union([z.string(), z.number()])).optional() (group level)
Line 185: groups: z.record(z.string(), TelegramGroupSchema.optional()).optional()
```

**GitHub permalink** (lines 80-200):  
https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/telegram/src/config-schema.ts#L80-L200

**Structure**:
```json5
{
  channels: {
    telegram: {
      groupPolicy: "allowlist" | "open" | "disabled",  // Root level
      groupAllowFrom: [12345, 67890],  // Root level sender filter
      groups: {
        "-1001234567890": {  // Negative group chat ID
          enabled: true,
          requireMention: true,
          groupPolicy: "allowlist",  // Per-group override
          allowFrom: [12345, 67890],  // Per-group sender override
          topics: {
            "42": {  // Forum topic ID
              allowFrom: [12345]  // Per-topic sender override
            }
          }
        }
      }
    }
  }
}
```

**Inheritance**: Per-group `allowFrom` overrides `groupAllowFrom`. Per-topic `allowFrom` overrides group-level.

## Update Type Coverage

**Covered in authorization flow** (`bot-handlers.inbound-pipeline.ts`):
- Regular messages (line 174)
- Edited messages (line 141, via `handleEditedMessage`)
- Channel posts (via `handleChannelPost`)
- Location messages (line 141)
- Media messages (handled in same pipeline)
- Callbacks (separate authorization in `bot-handlers.inbound-authorization.ts` lines 65-75)
- Replies/mentions (parsed in context resolution)

**Evidence**: All inbound message-like updates flow through `handleInboundMessageLike` which calls `authorizeInboundMessage` before `resolveTelegramSessionState`.

## Transport Parsing

**Telegram Webhook/Polling**: `extensions/telegram/src/bot-core.ts` creates Grammy bot instance.  
**Update authentication**: Telegram transport layer (Grammy) validates webhook signature or polling session.  
**Account ID binding**: Resolved in `extensions/telegram/src/accounts.ts` via `resolveTelegramAccount()`.  
**initData validation**: NOT performed at this layer. That's specific to Telegram Mini Apps, not bot messages.

**IMPORTANT**: Bot messages do NOT carry Telegram `initData` HMAC. Only Telegram Mini App webviews include `initData`. Our enrollment service validates `initData` in Mini App context, not bot message ingress.

## Dynamic Expiry/Revoke Enforcement

**Current mechanism**: Static allowlist sync only.

**Static sync limitations**:
1. Cannot enforce expiry without manual allowlist updates
2. Cannot enforce revocation without manual allowlist removal
3. No per-message dynamic enrollment query

**Required for dynamic enforcement**:
- Pre-authorization hook to query enrollment registry per update
- Block unauthorized updates BEFORE history access/buffering

**Gap identified**: No documented extension point for dynamic per-update verification before session state access.

## Extension/Hook Investigation

**Searched**:
- `src/plugin-sdk/channel-ingress-runtime.ts` (357 lines) - ingress lifecycle, no pre-authorization hook found
- `src/channels/message-access/runtime-types.ts` - `ChannelIngressContextBinding` structure (final binding, not extension point)
- `docs/channels/telegram/access-control.md` - static config only, no extension mechanism documented

**Imports in authorization file**:
```typescript
import type { ChannelIngressContextBinding } from "openclaw/plugin-sdk/channel-ingress-runtime";
```

`ChannelIngressContextBinding` is a result type (agentId, sessionKey, messageId), NOT an extension point.

**Conclusion**: No documented extension/hook mechanism found for injecting dynamic verification before history access.

## Minimal Reviewable Integration

### Option A: OpenClaw Patch (Required)

**Add extension point in**: `extensions/telegram/src/bot-handlers.inbound-authorization.ts`

**Proposed hook location**: Between line 376 (after static `shouldSkipGroupMessage`) and line 398 (before `resolveTelegramSessionState`).

**Hook signature**:
```typescript
// NEW: Dynamic authorization hook (extensible)
type DynamicAuthorizationHook = (params: {
  chatId: number;
  senderId: string;
  senderUsername: string;
  isGroup: boolean;
  groupConfig: TelegramGroupConfig | undefined;
}) => Promise<{ allowed: boolean; reason?: string }>;

// In createTelegramHandlerAuthorization():
const dynamicAuthHook = telegramDeps.getDynamicAuthorizationHook?.(); // NEW

// In authorizeInboundMessage(), after line 376:
if (dynamicAuthHook) {
  const dynamicGate = await dynamicAuthHook({
    chatId: params.chatId,
    senderId: params.senderId,
    senderUsername: params.senderUsername,
    isGroup: params.isGroup,
    groupConfig,
  });
  if (!dynamicGate.allowed) {
    logVerbose(`Blocked by dynamic authorization: ${dynamicGate.reason ?? 'denied'}`);
    return { allowed: false };
  }
}
```

**Integration**:
1. OpenClaw patch adds `getDynamicAuthorizationHook` to Telegram extension deps
2. World ID enrollment service registers hook implementation via OpenClaw extension API
3. Hook queries enrollment registry HTTP service (localhost:3000)
4. Returns `{ allowed: true }` for enrolled accounts, `{ allowed: false, reason: 'not enrolled' }` otherwise

**Deployment boundary**:
- Enrollment HTTP service runs on Mac mini (localhost:3000)
- OpenClaw reads `WORLDID_ENROLLMENT_URL=http://localhost:3000` from env
- Hook makes HTTP GET `/api/enrollment/query?telegram_user_id={senderId}` per update
- Cache enrollment status with short TTL (30s) to reduce query overhead

### Option B: Config-Only (INSUFFICIENT)

**Static allowlist sync**:
1. Enrollment service writes enrolled user IDs to file
2. OpenClaw reloads config on file change (requires restart or hot-reload if supported)
3. Updates `channels.telegram.groups.<groupId>.allowFrom` array

**Fatal limitation**: Cannot enforce expiry or revocation without config reload. Static allowlist does not support dynamic lifecycle (30-day TTL, immediate revocation).

## Safe vs Unknown Claims

### ✅ SAFE CLAIMS (Source-backed)

1. **Authorization happens BEFORE history access**: Lines 174-198 in `bot-handlers.inbound-pipeline.ts` show `authorizeInboundMessage` guards `resolveTelegramSessionState`.
2. **Authorization uses static config**: `bot-handlers.inbound-authorization.ts` lines 325-376 resolve `groupConfig`, `topicConfig`, `allowFrom` from static configuration.
3. **Group config schema**: `config-schema.ts` lines 80-200 define `groupPolicy`, `groupAllowFrom`, per-group `allowFrom`.
4. **Early exit on unauthorized**: Line 186 returns `{ kind: "ignored" }` if `!gate.allowed`, preventing session/history access.
5. **All update types covered**: Regular messages, edits, callbacks, media flow through same authorization gate.

### ⚠️ UNKNOWN (Not verified in source)

1. **Whether extension hook exists**: No documented extension mechanism found for pre-authorization dynamic verification.
2. **Runtime config hot-reload**: Docs say `allowFrom` changes apply without reconnect (line 13-15 of `access-control.md`), but internal hot-reload mechanism not verified in source.
3. **Whether OpenClaw can be safely patched**: Extension API stability unknown, upgrade compatibility unknown.
4. **Performance of per-update HTTP query**: No benchmarks, latency impact unknown.
5. **Cache eviction on revocation**: If caching enrollment status, cache invalidation on revocation requires separate mechanism.

### ❌ CANNOT CLAIM (Not in scope)

1. **Live deployment behavior**: Source investigation only, no running instance tested.
2. **Actual OpenClaw 2026.9.8 installation config**: No Mac mini access, no config inspection.
3. **Whether Bob's instance uses groups or DMs**: Unknown, config not provided.
4. **Whether World ID Mini App is already integrated**: Unknown, no live testing.

## Next Approval Needed

**Decision**: OpenClaw Patch vs. Static Sync vs. External Proxy

1. **OpenClaw Patch** (dynamic enforcement):
   - Requires: Modifying `extensions/telegram/src/bot-handlers.inbound-authorization.ts`
   - Approval: Bob must approve patching OpenClaw source
   - Risk: Maintenance burden on OpenClaw upgrades
   - Benefit: True dynamic enforcement (expiry, revocation, per-update queries)

2. **Static Sync** (periodic allowlist updates):
   - Requires: Config file writes + OpenClaw config hot-reload
   - Approval: Bob must confirm hot-reload behavior in 2026.9.8
   - Risk: Expiry/revocation delay (only on next sync)
   - Benefit: No OpenClaw patch required

3. **External Proxy** (Telegram Bot API proxy):
   - Requires: Intercepting Telegram webhook/polling updates before OpenClaw
   - Approval: Bob must approve network topology change
   - Risk: Complex proxy logic, potential message loss
   - Benefit: No OpenClaw modification

**Recommended**: OpenClaw Patch with dynamic hook (Option 1), pending Bob approval.

## Config Schema Location for Groups

**Primary file**: `extensions/telegram/src/config-schema.ts` lines 80-200  
**Root config structure**: `channels.telegram.groups` (line 185)  
**Per-group schema**: `TelegramGroupSchema` (line 102-110)  
**Inheritance**: Root `groupPolicy`/`groupAllowFrom` → per-group `groupPolicy`/`allowFrom` → per-topic `allowFrom`

**Manual bypass prevention**: Per-group `allowFrom` REPLACES root `groupAllowFrom` (no merge). To preserve root restrictions:
- Set restrictive `groupAllowFrom` at root
- Do NOT set per-group `allowFrom` for protected groups
- Per-group `allowFrom: []` blocks all senders in that group
- Per-group `allowFrom: ["*"]` requires `groupPolicy: "open"` (line 107)

**Unrelated rules preserved**: `requireMention`, `enabled`, `topics`, `skills`, `systemPrompt` are independent of `allowFrom` and preserved during sync.

## Limitation: No Generic Channel-Ingress-Runtime Pattern

**Cannot promise**: "No history touches from generic channel-ingress-runtime.ts pattern"

**Reason**: Source shows Telegram-specific authorization in `extensions/telegram/src/bot-handlers.inbound-authorization.ts`, not a generic `src/channels/*/channel-ingress-runtime.ts` pattern. Other channels (Discord, Slack, etc.) may have different authorization flows.

**Telegram-specific claim only**: The authorization-before-history guarantee applies to Telegram extension at commit fc23bc864e4553c2d215e479eeec47b67a0bf943. Other channel types not investigated.

## Summary

**Ingress flow**: Telegram update → Grammy transport auth → OpenClaw account resolution → `authorizeInboundMessage` (static config) → early exit if `!gate.allowed` → `resolveTelegramSessionState` (history access) → agent dispatch.

**Extension point**: NOT FOUND in documented APIs. OpenClaw patch required for dynamic verification hook.

**Config schema**: `channels.telegram.groups.<chatId>.allowFrom` array with per-group override semantics.

**Dynamic enforcement**: NOT POSSIBLE with static config alone. Requires either:
1. OpenClaw patch (dynamic hook before history access)
2. External proxy (intercept Telegram updates before OpenClaw)

**Source-backed recommendation**: Pursue OpenClaw patch to add `getDynamicAuthorizationHook` extension point in Telegram authorization flow, pending Bob approval for modifying OpenClaw source.
