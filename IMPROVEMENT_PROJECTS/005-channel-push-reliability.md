# PRD-005: Channel Push Notification Reliability

**Status**: Draft
**Author**: AI-assisted (Claude)
**Created**: 2026-03-26
**Priority**: High
**Estimated Effort**: Medium (2-3 days)

---

## 1. Introduction

Channel push notifications are the primary mechanism by which claude-peers delivers inter-session messages in real time. When a peer sends a message, the recipient's MCP server polls it from the broker, pushes it as a `notifications/claude/channel` notification via the MCP SDK, and then acknowledges delivery to the broker. This pipeline is fragile at multiple points, and failures are **silent** -- the sender believes delivery succeeded while the recipient never sees the message.

### Current Architecture

```
Sender Claude     Sender MCP     Broker (SQLite)     Recipient MCP     Recipient Claude
    |                 |                |                    |                    |
    |--send_message-->|                |                    |                    |
    |                 |--POST /send--->|                    |                    |
    |                 |<--{ok, msg_id}-|                    |                    |
    |<--"Sent"--------|                |                    |                    |
    |                 |                |<---POST /poll------|  (1s interval)     |
    |                 |                |---messages[]------>|                    |
    |                 |                |                    |--mcp.notification->|  (channel push)
    |                 |                |                    |  ...fire & forget  |
    |                 |                |<--POST /ack--------|                    |
    |                 |                |  (marks delivered)  |                    |
```

### Known Failure Modes

1. **Premature ack**: The MCP server acks messages immediately after calling `mcp.notification()`, but `notification()` is fire-and-forget. It resolves its Promise when the JSON-RPC message is written to stdout, NOT when Claude Code processes it. If Claude Code drops the notification (schema validation, internal error, channel not loaded), the message is permanently lost.

2. **Channel not loaded**: Without `--dangerously-load-development-channels` in the CLI invocation, Claude Code ignores all `notifications/claude/channel` messages. The MCP server has no way to detect this. Messages are polled, "pushed" into the void, acked, and gone.

3. **`/mcp` reconnect breaks channel**: When a user runs `/mcp` to reconnect MCP servers, Claude Code re-establishes the stdio transport but does NOT re-subscribe to channel notifications. The MCP server continues polling and pushing, but nothing arrives. Only a full `/exit` + restart recovers.

4. **Null meta values silently dropped**: Claude Code's internal schema validation rejects notification payloads where meta fields have `null` values. The server now uses conditional spread to omit optional fields (fixed in current code at line 688-693 of server.ts), but any regression here causes silent drops with no error.

5. **Model-dependent handling**: Different Claude models (Sonnet, Opus, Haiku) may handle channel notifications differently or with different priority. There is no specification guaranteeing behavior.

6. **`check_messages` is not a real fallback**: Because the poll loop acks messages as soon as `mcp.notification()` completes (even if Claude Code drops them), calling `check_messages` later returns nothing. The two-phase delivery (poll + ack) was designed to prevent this, but the ack happens too eagerly because there is no delivery confirmation signal from Claude Code.

---

## 2. Goals

1. **No silent message loss**: Every message either reaches Claude Code or triggers a visible warning to the user.
2. **Reliable fallback**: `check_messages` must return messages that were pushed but not confirmed as seen by the model.
3. **Self-diagnosing**: The system should detect when the channel push pipeline is broken and inform both the sender and recipient.
4. **Graceful degradation**: When channel push is unavailable, the system degrades to tool-based polling without losing messages.
5. **Observability**: Every delivery failure, retry, and degradation event is logged with enough context to diagnose.

---

## 3. User Stories

### US-001: Deferred Ack -- Don't Ack Until Claude Code Confirms Receipt

**As a** message recipient,
**I want** messages to remain undelivered in the broker until Claude Code has actually processed them,
**So that** messages are not permanently lost when channel push silently fails.

**Acceptance Criteria**:
- Messages polled from the broker are NOT acked after `mcp.notification()` returns.
- Instead, messages enter a local "pending confirmation" state in the MCP server's memory.
- Messages are only acked when one of the following confirmation signals occurs:
  - Claude Code calls `check_messages` (proves the model is actively receiving/processing messages).
  - Claude Code calls `send_message` with a `reply_to` referencing a pending message.
  - A configurable confirmation timeout (default: 30s) expires without error, AND the MCP transport is still connected (optimistic confirmation).
- If the MCP server restarts or the transport disconnects before confirmation, unacked messages remain in the broker for re-delivery.

**Technical Notes**:
- The MCP SDK `notification()` method returns `Promise<void>` that resolves when the JSONRPC message is written to stdout. It does NOT indicate Claude Code processed it. (Source: `protocol.js` line 781-847 in the SDK.)
- Current code at `server.ts` line 697-698 pushes `msg.id` to `ackedIds` immediately after `mcp.notification()` returns, then batch-acks at line 722-728.
- The pending confirmation buffer must be bounded (e.g., max 100 messages) to prevent memory leaks if confirmation never arrives.

**Implementation Sketch**:
```typescript
// In-memory pending buffer
const pendingMessages = new Map<number, { msg: Message; pushedAt: number }>();

// After mcp.notification():
pendingMessages.set(msg.id, { msg, pushedAt: Date.now() });
// Do NOT ack yet.

// Confirmation triggers:
// 1. Timer: every 30s, ack messages older than 30s (optimistic)
// 2. check_messages call: ack all pending, return any new undelivered
// 3. reply_to match: ack the referenced message
```

---

### US-002: Detect When Channel Push Is Not Working and Warn the User

**As a** Claude Code user,
**I want** the system to detect when channel push notifications are not being received,
**So that** I know to restart my session or use manual polling.

**Acceptance Criteria**:
- The MCP server tracks whether channel push has ever successfully delivered a message in the current session (heuristic: a `check_messages` or `send_message` call within 60s of a push implies the model is alive and processing).
- If 3+ messages are pushed without any confirmation signal, the server logs a warning: `[CPM-server] WARNING: Channel push may not be working. Messages pushed but no confirmation received.`
- The warning is also surfaced the next time any tool is called (e.g., `list_peers` or `send_message` returns a `_warnings` field in the response).
- A new `channel_push_status` field is added to the `/health` endpoint response, reporting: `working`, `degraded` (pushes sent but unconfirmed), or `unavailable`.

**Technical Notes**:
- Claude Code does not provide a "message received" callback via the MCP protocol. The only signals are indirect: the model calling tools proves it is active.
- The `--dangerously-load-development-channels` flag is checked by Claude Code internally; the MCP server cannot query whether it is set.
- Warning injection into tool responses is a pragmatic workaround: since the model reads tool results, embedding warnings there ensures visibility.

---

### US-003: Make `check_messages` a Real Fallback

**As a** Claude Code instance whose channel push is broken,
**I want** `check_messages` to return messages that were pushed but not confirmed,
**So that** I can still receive messages even when the push pipeline fails.

**Acceptance Criteria**:
- `check_messages` returns the union of:
  1. Messages in the pending confirmation buffer (pushed but not yet acked).
  2. Messages from the broker that are still undelivered (new messages since last poll).
- Messages returned via `check_messages` are marked as confirmed (acked to broker) since the model is now explicitly reading them.
- Duplicate suppression: if a message was already pushed via channel AND returned by `check_messages`, it appears only once.
- The tool description is updated to: "Check for messages. Returns any unconfirmed pushed messages AND any new messages from the broker. Use this if channel notifications are not appearing."

**Technical Notes**:
- Current implementation at `server.ts` line 536-581 calls `brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId })`, which returns only undelivered messages. But since the poll loop already acked them, this returns empty.
- With US-001's deferred ack, unconfirmed messages remain undelivered in the broker, so `check_messages` naturally picks them up.
- The pending buffer provides a second source for messages that were polled but not yet acked.

---

### US-004: Automatic Retry for Failed Channel Push Notifications

**As a** message recipient,
**I want** failed channel push notifications to be retried automatically,
**So that** transient failures don't cause permanent message loss.

**Acceptance Criteria**:
- If `mcp.notification()` throws an error (transport disconnected, not connected), the message is placed in a retry queue.
- Retry schedule: 3 attempts with exponential backoff (2s, 4s, 8s).
- After all retries are exhausted, the message remains unacked in the broker (per US-001) and is logged as a delivery failure.
- Retry attempts are logged: `[CPM-server] Retrying channel push for msg#123 (attempt 2/3)`.
- The retry queue is bounded (max 50 messages) to prevent unbounded growth.

**Technical Notes**:
- Currently, `mcp.notification()` can throw `Error('Not connected')` if the transport is closed (SDK `protocol.js` line 782-784).
- The current code does not catch errors from `mcp.notification()` -- it awaits the call and assumes success. A try/catch around the notification call would capture transport-level failures.
- Note: `mcp.notification()` succeeding (no throw) does NOT mean Claude Code received the message. It only means the bytes were written to the stdio pipe. This is why US-001's deferred ack is the primary defense, and US-004's retry only helps with transport-level failures.

**Implementation Sketch**:
```typescript
const retryQueue: Array<{ msg: Message; attempts: number; nextRetryAt: number }> = [];

// In pollAndPushMessages:
try {
  await mcp.notification({ ... });
  pendingMessages.set(msg.id, { msg, pushedAt: Date.now() });
} catch (e) {
  log(`Channel push failed for msg#${msg.id}: ${e.message}`);
  retryQueue.push({ msg, attempts: 1, nextRetryAt: Date.now() + 2000 });
}

// Retry loop (runs on poll interval):
for (const item of retryQueue) {
  if (Date.now() >= item.nextRetryAt && item.attempts < 3) {
    try {
      await mcp.notification({ ... });
      pendingMessages.set(item.msg.id, { msg: item.msg, pushedAt: Date.now() });
      // Remove from retry queue
    } catch {
      item.attempts++;
      item.nextRetryAt = Date.now() + 2000 * Math.pow(2, item.attempts - 1);
    }
  }
}
```

---

### US-005: Health Check Tool That Verifies Channel Push Is Working

**As a** Claude Code user or automated monitoring system,
**I want** a tool that verifies whether the channel push pipeline is functioning end-to-end,
**So that** I can diagnose delivery issues without trial and error.

**Acceptance Criteria**:
- A new MCP tool `channel_health` is added.
- When called, it returns a diagnostic report:
  - `transport_connected`: Whether the MCP transport is open.
  - `channel_push_status`: `working` / `degraded` / `unavailable` (same as US-002).
  - `messages_pushed`: Total messages pushed via channel this session.
  - `messages_confirmed`: Total messages with confirmation signal.
  - `messages_pending`: Count of messages in the pending confirmation buffer.
  - `messages_retry_queue`: Count of messages awaiting retry.
  - `last_push_at`: ISO timestamp of last successful notification push.
  - `last_confirmation_at`: ISO timestamp of last confirmation signal.
  - `uptime_seconds`: How long the MCP server has been running.
- The tool also performs a self-test: pushes a synthetic "ping" notification and checks if the transport accepted it without error.
- Results are logged to `cpm-logs/server.log` for historical tracking.

**Technical Notes**:
- `mcp._transport` is a private field in the SDK, but its presence can be inferred from whether `notification()` throws `Error('Not connected')`.
- The self-test ping should use a distinct notification method or a meta flag so it is not confused with real messages by Claude Code.
- Alternative: instead of a synthetic ping, simply report the ratio of pushed/confirmed messages as a health signal.

---

### US-006: Startup Channel Push Validation

**As a** Claude Code user,
**I want** the MCP server to validate channel push capability during startup,
**So that** I know immediately if messages will be silently dropped for this session.

**Acceptance Criteria**:
- On startup (after `mcp.connect()`), the server sends a "hello" channel notification as a connectivity test.
- If the notification throws, the server logs a warning: `[CPM-server] WARNING: Channel push failed on startup. Messages will only be available via check_messages tool.`
- The warning is embedded in the response of the first tool call the model makes (similar to US-002).
- A `channel_available` flag is maintained in server state; when false, the poll loop skips push attempts and instead accumulates messages for `check_messages` retrieval.

**Technical Notes**:
- A successful `mcp.notification()` on startup does NOT guarantee Claude Code will display channel messages (the `--dangerously-load-development-channels` flag check happens on the Claude Code side). But a thrown error definitively means push is broken.
- The hello notification could use content like: `"claude-peers MCP server connected. Channel push active."` This is benign if displayed, and informative.

---

### US-007: Sender Delivery Status Feedback

**As a** message sender,
**I want** to know whether my message was actually delivered to the recipient,
**So that** I can retry or use alternative communication if delivery failed.

**Acceptance Criteria**:
- The broker tracks three delivery states: `undelivered` (0), `pushed` (1), `confirmed` (2).
- The recipient's MCP server updates state to `pushed` after calling `mcp.notification()`, and to `confirmed` after receiving a confirmation signal (per US-001).
- A new broker endpoint `GET /message-status?id=<msg_id>` returns the delivery state.
- The `send_message` tool response includes a `message_id` (already present) that the sender can use to check delivery status.
- A new MCP tool `message_status` allows the sender to query delivery state of a previously sent message.
- Delivery states: `queued` (in broker, not yet polled), `pushed` (notification sent), `confirmed` (model processed), `expired` (TTL exceeded without delivery).

**Technical Notes**:
- The `messages` table currently has `delivered INTEGER NOT NULL DEFAULT 0`. This would change to a multi-state column: 0=undelivered, 1=pushed, 2=confirmed.
- The broker's `handleAckMessages` would need to accept a `state` parameter to distinguish push-ack from confirm-ack.
- This is a breaking schema change requiring migration.

---

## 4. Technical Considerations

### 4.1 MCP SDK Notification Semantics

The core challenge is that `mcp.notification()` (from `@modelcontextprotocol/sdk`) is a one-way fire-and-forget operation:

```typescript
// From protocol.js (SDK source):
async notification(notification, options) {
    if (!this._transport) {
        throw new Error('Not connected');
    }
    // ... writes JSON-RPC message to transport (stdout) ...
    // Returns void — no delivery confirmation
}
```

The method only guarantees the bytes were written to the stdio pipe. It cannot confirm:
- Claude Code read the bytes from the pipe
- Claude Code parsed the JSON-RPC message
- Claude Code schema-validated the notification params
- Claude Code rendered the channel notification to the model
- The model processed/acknowledged the notification

This is an inherent limitation of the MCP protocol's notification model (JSON-RPC 2.0 notifications are one-way by spec). Any delivery confirmation must be built at the application layer.

### 4.2 Two-Phase Delivery Already Exists but Acks Too Eagerly

The current codebase already implements two-phase delivery (poll + ack), introduced in commit `de82a12`. The design intent was correct:

```
Phase 1: Poll undelivered messages from broker
Phase 2: Ack only after successful push
```

However, the current implementation (server.ts lines 652-728) treats a successful `await mcp.notification()` as proof of delivery. Since the SDK resolves the promise on stdout write (not on Claude Code receipt), this is a false positive. The fix (US-001) is to add a **Phase 3**: wait for an application-layer confirmation signal before acking.

### 4.3 The `--dangerously-load-development-channels` Flag

Claude Code requires this CLI flag to process `notifications/claude/channel` messages from MCP servers. Without it:
- The MCP server starts normally
- Registration and tool calls work fine
- `mcp.notification()` succeeds (bytes written to pipe)
- Claude Code silently ignores the notification
- The message is acked and gone

This flag is currently injected by a ZSH wrapper function in `~/.zshrc`. If a user starts Claude Code without the wrapper (e.g., from a different shell, a script, or an SSH session), channel push silently breaks.

**Detection is impossible from the MCP server side.** The flag is evaluated internally by Claude Code's notification dispatcher. The MCP server sees no error, no rejection, no signal. This makes US-002 and US-005 necessarily heuristic-based (absence of confirmation signals implies channel may not be loaded).

### 4.4 `/mcp` Reconnect Behavior

When a user runs `/mcp` in Claude Code:
1. Claude Code tears down the existing stdio transport to each MCP server.
2. Claude Code respawns the MCP server processes (or reconnects to existing ones, depending on the MCP configuration).
3. The new transport is established.
4. Claude Code does NOT re-send the channel subscription capability.

This means after `/mcp`, the MCP server has a fresh transport but channel push does not work. The MCP server cannot detect this because:
- The transport is connected (notifications don't throw)
- Bytes are written to stdout successfully
- But Claude Code's notification dispatcher is not routing channel messages

**Workaround**: Detect transport reconnection (the `mcp.connect()` establishing a new transport) and re-send the startup hello notification. If the hello is never acknowledged (heuristic), warn via tool responses.

### 4.5 Claude Code's Schema Validation

Claude Code performs internal schema validation on channel notification params. Observed behavior:
- `null` values in the `meta` object cause the entire notification to be dropped.
- Missing `content` field causes the notification to be dropped.
- Unknown fields in `meta` are tolerated (passed through).
- The `meta` object must be a flat key-value map (no nested objects confirmed to work reliably).

The current code already handles this (server.ts lines 686-693 use conditional spread to omit optional fields), but this is fragile -- any new field added without the spread pattern reintroduces the bug.

**Recommended defense**: A `sanitizeNotificationMeta()` function that strips `null`/`undefined` values from the meta object before every notification call.

### 4.6 Backward Compatibility

- US-001 (deferred ack) changes ack timing but does not change the broker API. Fully backward compatible.
- US-003 (check_messages enhancement) changes tool behavior but not the API contract. Backward compatible.
- US-007 (delivery states) changes the `delivered` column semantics. Requires schema migration. Existing messages with `delivered=1` would map to state `2` (confirmed, since they predate this feature).

### 4.7 Performance Considerations

- The pending confirmation buffer (US-001) adds memory usage proportional to unconfirmed messages. Bounded at 100 messages (~50KB worst case). Negligible.
- The retry queue (US-004) adds a retry scan on each poll interval (1s). Bounded at 50 items. Negligible.
- The optimistic confirmation timeout (US-001, 30s default) means acks are delayed by up to 30s compared to today. This affects broker cleanup (delivered messages cleaned after 7 days) but has no user-visible impact.
- Sender status queries (US-007) add HTTP calls. These are on-demand (user-initiated), not on a timer.

---

## 5. Non-Goals

1. **Guaranteed exactly-once delivery**: The system targets at-least-once delivery. Duplicate messages are acceptable and should be handled by the recipient (idempotency via message_id).

2. **End-to-end encryption**: Message content is plaintext over localhost. TLS exists for federation (cross-machine) but not for local broker communication. Local security relies on bearer token auth and localhost binding.

3. **Persistent message queue**: The broker is not a durable message queue. Messages have a 7-day TTL after delivery. Undelivered messages persist until the peer re-registers or the broker restarts, but there is no replay or dead-letter queue.

4. **Upstream MCP SDK changes**: This PRD works within the current MCP SDK's notification semantics. We will not fork or patch the SDK to add delivery confirmation.

5. **Cross-model compatibility guarantees**: While we log and warn about potential model-specific behavior differences, we do not commit to testing against every Claude model variant.

6. **Removing the `--dangerously-load-development-channels` requirement**: This is a Claude Code platform decision. We can only work around it with detection and fallbacks.

7. **Real-time WebSocket push**: The current architecture (stdio MCP transport + poll loop) is retained. A WebSocket-based push channel would require MCP protocol changes outside our scope.

---

## 6. Success Metrics

| Metric | Current State | Target | How to Measure |
|--------|--------------|--------|----------------|
| **Silent message loss rate** | Unknown (no tracking) | 0% (every loss generates a warning) | Count messages with `pushed` state that never reach `confirmed` within 60s |
| **Channel push detection time** | Never detected | < 60s after first failed push | Time from first unconfirmed push to warning in tool response |
| **check_messages fallback effectiveness** | 0% (always returns empty after push) | 100% (returns all unconfirmed messages) | Test: disable channel flag, send message, call check_messages |
| **Retry success rate for transient failures** | 0% (no retry) | > 90% of transport-level failures recovered | Count retry successes vs total retry attempts |
| **Mean time to diagnose push issues** | Minutes to hours (manual debugging) | < 10s (call channel_health tool) | User reports, support tickets |
| **Message delivery confirmation rate** | 0% (no confirmation tracking) | > 95% of messages reach confirmed state within 30s | Broker query: `SELECT COUNT(*) WHERE state >= 2 AND pushed_within_30s` |

### Test Plan

| Test Case | User Story | Method |
|-----------|-----------|--------|
| Send message, verify it stays unacked for 30s before optimistic confirmation | US-001 | Integration test: mock broker, verify ack timing |
| Send 5 messages with channel push disabled, call check_messages, verify all 5 returned | US-003 | Integration test: start server without channel flag |
| Kill transport mid-push, verify retry attempts logged and message eventually delivered | US-004 | Unit test: mock mcp.notification to throw, verify retry queue |
| Call channel_health, verify all diagnostic fields populated | US-005 | Unit test: call tool handler, check response schema |
| Start server, push hello notification, verify startup validation logged | US-006 | Integration test: capture server.log output |
| Send message, query message_status, verify state transitions | US-007 | Integration test: send message, poll status endpoint |
| 3 unconfirmed pushes trigger warning in next tool response | US-002 | Integration test: push 3 messages, call list_peers, check for warning |

---

## 7. Implementation Priority

| Phase | User Stories | Rationale |
|-------|-------------|-----------|
| **Phase 1: Stop the bleeding** | US-001, US-003 | Deferred ack + real fallback eliminates silent message loss. Highest impact, moderate effort. |
| **Phase 2: Detection and diagnostics** | US-002, US-005, US-006 | Warnings and health checks make failures visible. Medium impact, low effort. |
| **Phase 3: Resilience** | US-004 | Retry logic handles transient failures. Lower impact (most failures are not transient). |
| **Phase 4: Full observability** | US-007 | Sender-side delivery tracking. Nice to have, higher effort (schema migration). |

---

## 8. Open Questions

1. **Optimistic confirmation timeout value**: 30s is proposed. Too short risks premature ack; too long delays broker cleanup. Should this be configurable via environment variable?

2. **Confirmation signal heuristics**: The model calling any tool within N seconds of a push is treated as implicit confirmation. Is this too loose? Could a model call `list_peers` for unrelated reasons while channel messages are silently dropped?

3. **Synthetic ping notification**: Should US-006's startup hello use a reserved notification method (e.g., `notifications/claude/channel/ping`) or the standard channel method with a special meta flag? The former is cleaner but may be rejected by Claude Code's schema validation.

4. **Message replay window**: With deferred ack, messages could be delivered twice (once via push, once via `check_messages`). The model should deduplicate by `message_id`. Should we add dedup guidance to the MCP server instructions?

5. **Federation interaction**: Does the deferred ack model work for federated (cross-machine) messages, where the relay hop adds latency? The remote broker acks relay receipt, but the local confirmation timeout starts from the local push. Need to verify timing.
