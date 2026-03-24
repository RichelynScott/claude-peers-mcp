# PRD: Structured Message Protocol + Broadcast

## Introduction

Add typed messages and broadcast capability to the claude-peers broker. Today all messages are untyped plain text, routed 1:1 only. This feature introduces a `type` field (text, query, response, handoff, broadcast), optional structured `metadata`, a `reply_to` field for threading, and a new `/broadcast` endpoint for sending to all peers in a given scope. These are bundled because broadcast is semantically a message type that needs the type system to exist first.

**Dependency**: This PRD assumes broker authentication (prd-broker-auth.md) is implemented. All new endpoints require `Authorization: Bearer <token>`. Tests must include the auth token. Auth middleware runs before any new endpoint logic.

## Goals

- **G-1**: Messages carry a `type` field that enables semantic routing and display. Default is `"text"` for full backward compatibility.
- **G-2**: Messages carry optional `metadata` (JSON object) for structured payloads, enabling machine-readable task handoffs and scoped broadcasts.
- **G-3**: Messages carry an optional `reply_to` field linking to a parent message ID, enabling threaded conversations.
- **G-4**: A new `/broadcast` endpoint sends a message to all live peers in a given scope (machine/directory/repo) in a single atomic call.
- **G-5**: A new `broadcast_message` MCP tool exposes broadcast to Claude Code sessions.
- **G-6**: All existing messages in the database continue to work unmodified (type defaults to `"text"`, metadata/reply_to default to null).
- **G-7**: All existing tests pass. New tests cover message types, metadata validation, reply_to threading, and broadcast.

## User Stories

### US-001: Send a typed message

**Description:** As a Claude Code session, I want to send messages with a type field (text, query, response, handoff) so that the recipient knows the intent of the message without parsing its contents.

**Acceptance Criteria:**
- [ ] `send_message` MCP tool accepts optional `type` parameter with values: `"text"`, `"query"`, `"response"`, `"handoff"`, `"broadcast"`
- [ ] `send_message` MCP tool accepts optional `metadata` parameter (JSON object)
- [ ] `send_message` MCP tool accepts optional `reply_to` parameter (number, referencing a previous message ID)
- [ ] When `type` is omitted, it defaults to `"text"`
- [ ] The broker's `/send-message` endpoint accepts the new fields and persists them in SQLite
- [ ] Existing calls to `/send-message` that omit `type`, `metadata`, and `reply_to` continue to work identically (backward compatible)

### US-002: Receive typed messages with metadata

**Description:** As a Claude Code session receiving messages, I want to see the message type and metadata so that I can respond appropriately (e.g., answer a query, accept a handoff).

**Acceptance Criteria:**
- [ ] Channel notifications (pushed by `server.ts` polling loop) include `type` and `metadata` in the `meta` object alongside existing `from_id`, `from_name`, `from_summary`, `from_cwd`, `sent_at`
- [ ] The `check_messages` MCP tool output includes type, metadata, and reply_to for each message
- [ ] Messages with type `"query"` display as: `[QUERY] From <name> (<id>): <text>` with optional `topic` from metadata
- [ ] Messages with type `"handoff"` display as: `[HANDOFF] From <name> (<id>): <text>` followed by task details from metadata
- [ ] Messages with type `"response"` display as: `[RESPONSE] From <name> (<id>) re: msg#<reply_to>: <text>`
- [ ] Messages with type `"text"` display identically to current format (no prefix)

### US-003: Reply to a message (threading)

**Description:** As a Claude Code session, I want to reply to a specific message by ID so that conversations remain threaded and traceable.

**Acceptance Criteria:**
- [ ] `send_message` MCP tool accepts optional `reply_to` parameter (the message ID to reply to)
- [ ] When `reply_to` is provided, the broker validates that the referenced message ID exists in the database
- [ ] If the referenced message does not exist, the broker returns `{ ok: false, error: "Referenced message <id> not found" }`
- [ ] The `reply_to` value is stored in the `messages` table and returned in poll/check responses
- [ ] Threading works across types: a `"response"` can reply_to a `"query"`, a `"text"` can reply_to a `"handoff"`, etc.

### US-004: Broadcast to all peers in scope

**Description:** As a Claude Code session, I want to send a message to all active peers in a given scope (machine, directory, or repo) so that I can announce work status, request help, or coordinate across sessions without sending individual messages.

**Acceptance Criteria:**
- [ ] New broker endpoint: `POST /broadcast` accepts `{ from_id, text, type?, metadata?, scope, cwd, git_root }`
- [ ] Broadcast creates one message row per live recipient (excluding sender), using the same peer filtering logic as `/list-peers`
- [ ] Each recipient's message row has the sender's `from_id` and the broadcast `type` (defaults to `"broadcast"` if not specified)
- [ ] Dead peers (failed PID liveness check) are skipped, not errored
- [ ] Response: `{ ok: true, recipients: <count>, message_ids: [<ids>] }`
- [ ] If no live peers exist in the scope (excluding sender), returns `{ ok: true, recipients: 0, message_ids: [] }`
- [ ] Message size limit (10KB) applies to the text field, same as `/send-message`
- [ ] Rate limiting: one `/broadcast` call counts as 1 request against the rate limit, not N (prevents penalizing legitimate broadcasts)
- [ ] All created messages are individually pollable and ackable by each recipient (uses existing two-phase delivery)

### US-005: Broadcast via MCP tool

**Description:** As a Claude Code session, I want a `broadcast_message` MCP tool so that I can broadcast without knowing the broker API details.

**Acceptance Criteria:**
- [ ] New MCP tool: `broadcast_message` with parameters: `message` (string, required), `scope` (enum: machine/directory/repo, required)
- [ ] Tool automatically sets `type` to `"broadcast"` and includes `cwd` and `git_root` from server state
- [ ] Tool returns: `"Broadcast sent to <N> peer(s) in scope '<scope>'"` with list of recipient count
- [ ] If no peers exist, returns: `"No peers found in scope '<scope>'. Broadcast not sent."`
- [ ] Tool is registered in the MCP server's TOOLS array and described in the instructions string

### US-006: CLI broadcast command

**Description:** As a CLI user, I want a `bun cli.ts broadcast` command so that I can send broadcasts from the terminal.

**Acceptance Criteria:**
- [ ] New CLI command: `bun cli.ts broadcast <scope> <message>`
- [ ] Scope must be one of: `machine`, `directory`, `repo`
- [ ] CLI reads `cwd` from `process.cwd()` and resolves `git_root` (same logic as `server.ts`)
- [ ] Prints: `"Broadcast sent to <N> peer(s)"` on success
- [ ] Prints: `"No peers in scope '<scope>'"` if recipients is 0
- [ ] Help text updated to include broadcast command

### US-007: Database migration for new columns

**Description:** As a developer, I want the database schema migration to add new columns without data loss so that existing databases upgrade seamlessly.

**Acceptance Criteria:**
- [ ] Three `ALTER TABLE` statements execute on broker startup (same pattern as `session_name` migration):
  - `ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'`
  - `ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT NULL`
  - `ALTER TABLE messages ADD COLUMN reply_to INTEGER DEFAULT NULL`
- [ ] Each ALTER is wrapped in try/catch (column already exists = no-op)
- [ ] Existing messages get `type='text'`, `metadata=NULL`, `reply_to=NULL` via column defaults
- [ ] New `CREATE TABLE IF NOT EXISTS messages` statement includes all three new columns for fresh databases
- [ ] No data migration script needed (defaults handle existing rows)

### US-008: Metadata validation

**Description:** As a developer, I want metadata to be validated per message type so that malformed payloads are rejected early.

**Acceptance Criteria:**
- [ ] `metadata` must be a valid JSON object (or null/omitted). Arrays, strings, numbers are rejected with `{ ok: false, error: "metadata must be a JSON object" }`
- [ ] `metadata` is stored as a JSON string in SQLite via `JSON.stringify()`
- [ ] `metadata` is parsed back to an object via `JSON.parse()` when returned in poll/check responses
- [ ] No per-type schema validation at the broker level (validation is informational, not enforced). The broker stores whatever valid JSON object is provided.
- [ ] Total message payload (text + JSON.stringify(metadata)) must not exceed 10KB

### US-009: Tests for structured messages and broadcast

**Description:** As a developer, I want comprehensive tests for all new functionality so that regressions are caught early.

**Acceptance Criteria:**
- [ ] New describe block: `"Structured Messages"` with tests:
  - Send message with type `"query"` and verify it's stored/returned correctly
  - Send message with type `"handoff"` and metadata, verify metadata round-trips through JSON serialization
  - Send message with `reply_to` referencing an existing message, verify it's stored
  - Send message with `reply_to` referencing a nonexistent message, verify error response
  - Send message with invalid metadata (non-object), verify error response
  - Send message without type field, verify it defaults to `"text"`
  - Verify existing message format (no type/metadata/reply_to) still works
- [ ] New describe block: `"Broadcast"` with tests:
  - Register 2+ peers, broadcast with scope `"machine"`, verify each peer gets a message
  - Broadcast returns correct `recipients` count and `message_ids` array
  - Broadcast excludes the sender from recipients
  - Broadcast with scope `"directory"` only reaches peers in matching directory
  - Broadcast with scope `"repo"` only reaches peers in matching git_root
  - Broadcast to scope with no peers returns `{ ok: true, recipients: 0, message_ids: [] }`
  - Broadcast respects 10KB message size limit
  - Broadcast counts as 1 request against rate limit
- [ ] All tests include auth token in requests (per broker-auth dependency)
- [ ] All existing 19 tests (+ auth tests from prd-broker-auth) continue to pass

## Functional Requirements

- **FR-1**: New `MessageType` type: `"text" | "query" | "response" | "handoff" | "broadcast"`. Defined in `shared/types.ts`.
- **FR-2**: `Message` interface gains three fields: `type: MessageType` (required), `metadata: Record<string, unknown> | null` (nullable), `reply_to: number | null` (nullable).
- **FR-3**: `SendMessageRequest` interface gains three optional fields: `type?: MessageType` (defaults to `"text"`), `metadata?: Record<string, unknown>`, `reply_to?: number`.
- **FR-4**: New `BroadcastRequest` interface: `{ from_id: PeerId, text: string, type?: MessageType, metadata?: Record<string, unknown>, scope: "machine" | "directory" | "repo", cwd: string, git_root: string | null }`.
- **FR-5**: New `BroadcastResponse` interface: `{ ok: boolean, recipients: number, message_ids: number[] }`.
- **FR-6**: The `insertMessage` prepared statement is updated to include `type`, `metadata` (as JSON string), and `reply_to` columns.
- **FR-7**: The `handleSendMessage` function validates: (a) `type` is a valid `MessageType` value if provided, (b) `metadata` is a plain object if provided, (c) `reply_to` references an existing message ID if provided, (d) combined size of `text` + `JSON.stringify(metadata)` does not exceed 10KB.
- **FR-8**: New `handleBroadcast` function: (a) resolves recipient list using `handleListPeers` logic with the provided scope/cwd/git_root, excluding `from_id`, (b) runs all inserts in a single SQLite transaction for atomicity, (c) returns recipient count and array of message IDs, (d) applies same 10KB size limit as send-message.
- **FR-9**: The `/broadcast` endpoint is rate-limited as 1 request (same bucket as `/send-message`). This means a broadcast to 50 peers counts as 1 against the 60/min limit, not 50.
- **FR-10**: Channel notifications in `pollAndPushMessages()` include `type` and `metadata` in the `meta` object. The `metadata` field is parsed from its JSON string storage before inclusion.
- **FR-11**: The `check_messages` tool handler formats output with type-specific prefixes: `[QUERY]`, `[RESPONSE]`, `[HANDOFF]`, `[BROADCAST]`. Messages with type `"text"` have no prefix (backward compatible display).
- **FR-12**: The `send_message` tool handler passes the new optional fields (`type`, `metadata`, `reply_to`) through to the broker when provided.
- **FR-13**: The `broadcast_message` tool's `inputSchema` defines `message` (string, required) and `scope` (enum string, required). The tool sets `type: "broadcast"` and populates `cwd`/`git_root` from server state (`myCwd`/`myGitRoot`).
- **FR-14**: MCP server instructions text (in the `Server` constructor) is updated to document the new `broadcast_message` tool and the `type`/`metadata`/`reply_to` parameters on `send_message`.

## Non-Goals (Out of Scope)

- **NG-1**: Per-type schema enforcement at the broker level. The broker stores any valid JSON object as metadata. Application-level schema validation (e.g., "handoff metadata must have a `task` field") is the sender's responsibility.
- **NG-2**: Message threading UI or tree rendering. `reply_to` is a flat parent reference, not a full thread data structure. Rendering threaded conversations is a consumer concern.
- **NG-3**: Delivery receipts or read receipts. The existing two-phase poll/ack is the delivery mechanism. No additional acknowledgment types are added.
- **NG-4**: Broadcast deduplication. If a peer calls `/broadcast` twice with the same text, recipients get two copies. Idempotency keys are future work.
- **NG-5**: Multicast groups or named channels. Broadcast uses the existing scope mechanism (machine/directory/repo), not user-defined groups.
- **NG-6**: Changes to `shared/summarize.ts` or auto-summary generation.
- **NG-7**: Changes to the broker auth system (covered by prd-broker-auth.md).
- **NG-8**: `server.test.ts` (MCP server tool handler tests). Remains a separate backlog item.
- **NG-9**: CLI display of threaded message trees. The CLI `send` command gains type support, but thread visualization is out of scope.
- **NG-10**: WebSocket-based push for broadcast. Broadcast messages are delivered via the same 1s polling loop as all other messages.

## Technical Considerations

### File Paths (all in `/home/riche/MCPs/claude-peers-mcp/`)

| File | Changes |
|------|---------|
| `shared/types.ts` | Add `MessageType` type, update `Message` and `SendMessageRequest` interfaces, add `BroadcastRequest` and `BroadcastResponse` interfaces |
| `broker.ts` | Schema migration (3 ALTER TABLE), update `insertMessage` prepared statement, add `reply_to` validation query, update `handleSendMessage` for new fields + validation, add `handleBroadcast` function, add `/broadcast` route in switch, add `/broadcast` to rate-limit-counted paths |
| `server.ts` | Update `send_message` tool schema (add optional type/metadata/reply_to params) and handler (pass new fields to broker), add `broadcast_message` tool definition and handler, update `pollAndPushMessages` channel notification meta to include type/metadata, update `check_messages` handler to format typed messages, update MCP instructions text |
| `cli.ts` | Add `broadcast` command, update help text |
| `broker.test.ts` | Add "Structured Messages" describe block (7+ tests), add "Broadcast" describe block (8+ tests) |

### Database Schema

Current `messages` table:
```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (from_id) REFERENCES peers(id),
  FOREIGN KEY (to_id) REFERENCES peers(id)
);
```

After migration:
```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  text TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  metadata TEXT DEFAULT NULL,
  reply_to INTEGER DEFAULT NULL,
  sent_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (from_id) REFERENCES peers(id),
  FOREIGN KEY (to_id) REFERENCES peers(id)
);
```

Migration strategy (same pattern as `session_name` on line 61 of `broker.ts`):
```typescript
try { db.run("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT NULL"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN reply_to INTEGER DEFAULT NULL"); } catch {}
```

### Prepared Statement Changes

Current `insertMessage` (line 131-134 of `broker.ts`):
```typescript
const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);
```

Updated:
```typescript
const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, type, metadata, reply_to, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0)
`);
```

New prepared statement for `reply_to` validation:
```typescript
const selectMessageExists = db.prepare(`
  SELECT id FROM messages WHERE id = ?
`);
```

### Broadcast Implementation Notes

`handleBroadcast` reuses `handleListPeers` to resolve the recipient list. It wraps all message inserts in a SQLite transaction for atomicity:

```typescript
function handleBroadcast(body: BroadcastRequest): BroadcastResponse {
  // Size check
  const metadataStr = body.metadata ? JSON.stringify(body.metadata) : null;
  if (body.text.length + (metadataStr?.length ?? 0) > 10240) {
    return { ok: false, recipients: 0, message_ids: [] }; // with error
  }

  // Resolve recipients using existing list-peers logic
  const peers = handleListPeers({
    scope: body.scope,
    cwd: body.cwd,
    git_root: body.git_root,
    exclude_id: body.from_id,
  });

  if (peers.length === 0) {
    return { ok: true, recipients: 0, message_ids: [] };
  }

  const type = body.type ?? "broadcast";
  const now = new Date().toISOString();
  const messageIds: number[] = [];

  // Atomic: all messages inserted in one transaction
  const insertAll = db.transaction(() => {
    for (const peer of peers) {
      const result = insertMessage.run(
        body.from_id, peer.id, body.text, type, metadataStr, null, now
      );
      messageIds.push(Number(result.lastInsertRowid));
    }
  });
  insertAll();

  return { ok: true, recipients: peers.length, message_ids: messageIds };
}
```

### Rate Limiting for /broadcast

The current rate-limit block (lines 319-334 of `broker.ts`) checks `path === "/send-message"`. This must be expanded to also match `"/broadcast"`:

```typescript
if ((path === "/send-message" || path === "/broadcast") && req.method === "POST") {
  // ... existing rate limit logic
}
```

This means a broadcast counts as 1 request, regardless of how many recipients it creates messages for.

### Channel Notification Metadata Update

Current meta in `pollAndPushMessages` (lines 504-510 of `server.ts`):
```typescript
meta: {
  from_id: msg.from_id,
  from_name: fromName,
  from_summary: fromSummary,
  from_cwd: fromCwd,
  sent_at: msg.sent_at,
}
```

Updated:
```typescript
meta: {
  from_id: msg.from_id,
  from_name: fromName,
  from_summary: fromSummary,
  from_cwd: fromCwd,
  sent_at: msg.sent_at,
  type: msg.type,
  metadata: msg.metadata ? JSON.parse(msg.metadata as string) : null,
  reply_to: msg.reply_to,
}
```

### Type Validation in handleSendMessage

Valid types are a closed set. Validate at the broker level:
```typescript
const VALID_TYPES = new Set(["text", "query", "response", "handoff", "broadcast"]);

// In handleSendMessage:
const type = body.type ?? "text";
if (!VALID_TYPES.has(type)) {
  return { ok: false, error: `Invalid message type: ${type}` };
}
```

### Metadata Size Accounting

The 10KB limit currently checks `body.text.length`. With metadata, the check becomes:
```typescript
const metadataStr = body.metadata ? JSON.stringify(body.metadata) : null;
const totalSize = body.text.length + (metadataStr?.length ?? 0);
if (totalSize > 10240) {
  return { ok: false, error: "Message too large (text + metadata max 10KB)" };
}
```

### Broker Auth Dependency

Per prd-broker-auth.md:
- `/broadcast` is a POST endpoint and requires `Authorization: Bearer <token>`
- Auth middleware runs before rate limiting and body parsing
- Tests must include the auth token (same pattern as updated `post()` helper in broker.test.ts)
- The `/broadcast` endpoint follows the same auth pattern as `/send-message`

### MCP Tool Schema: send_message Update

Current inputSchema has `to_id` (string, required) and `message` (string, required). Add:
```typescript
type: {
  type: "string" as const,
  enum: ["text", "query", "response", "handoff", "broadcast"],
  description: 'Message type. Defaults to "text". Use "query" for questions expecting a response, "response" for replies, "handoff" for task delegation.',
},
metadata: {
  type: "object" as const,
  description: "Optional structured metadata. For handoff: { task, files?, context? }. For query/response: { topic? }.",
},
reply_to: {
  type: "number" as const,
  description: "Message ID to reply to (for threading). The referenced message must exist.",
},
```

These are not added to `required` (backward compatible).

### MCP Tool Schema: broadcast_message

```typescript
{
  name: "broadcast_message",
  description: "Send a message to all Claude Code instances in a scope (machine, directory, or repo). Useful for announcements, help requests, or coordination.",
  inputSchema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string" as const,
        description: "The message to broadcast",
      },
      scope: {
        type: "string" as const,
        enum: ["machine", "directory", "repo"],
        description: 'Scope of broadcast. "machine" = all instances. "directory" = same working directory. "repo" = same git repository.',
      },
    },
    required: ["message", "scope"],
  },
}
```

### Backward Compatibility Summary

| Component | Before | After | Compatible? |
|-----------|--------|-------|-------------|
| `/send-message` API | `{ from_id, to_id, text }` | `{ from_id, to_id, text, type?, metadata?, reply_to? }` | Yes (new fields optional) |
| `Message` response | `{ id, from_id, to_id, text, sent_at, delivered }` | `{ id, from_id, to_id, text, type, metadata, reply_to, sent_at, delivered }` | Yes (additive) |
| Existing DB rows | No type/metadata/reply_to | `type='text'`, `metadata=NULL`, `reply_to=NULL` via defaults | Yes (column defaults) |
| `send_message` MCP tool | `{ to_id, message }` | `{ to_id, message, type?, metadata?, reply_to? }` | Yes (new params optional) |
| Channel notifications | `meta: { from_id, from_name, ... }` | `meta: { from_id, from_name, ..., type, metadata, reply_to }` | Yes (additive) |
| CLI send command | `bun cli.ts send <id> <msg>` | Unchanged (plain text, type defaults to "text") | Yes |

## Success Metrics

| Metric | Target |
|--------|--------|
| All existing tests pass | 19+ existing (including auth tests from prd-broker-auth) green |
| New structured message tests pass | 7+ tests green |
| New broadcast tests pass | 8+ tests green |
| Backward compatibility | Existing `/send-message` calls without new fields work identically |
| Existing DB upgrade | Broker starts without error on database lacking new columns |
| Broadcast atomicity | All-or-nothing message creation for broadcast recipients |
| Type round-trip | `type` field persists through send -> store -> poll -> ack lifecycle |
| Metadata round-trip | `metadata` JSON survives serialization to SQLite TEXT and back |
| reply_to validation | Invalid reply_to returns clear error, valid reply_to persists |

## Test Plan

### New Tests: "Structured Messages" describe block

Placement: after "Messaging" describe block, before "Edge Cases".

```
test("Send message with type 'query' stores and returns type correctly")
  - Send with type: "query", poll, verify message has type: "query"

test("Send message with type 'handoff' and metadata round-trips correctly")
  - Send with type: "handoff", metadata: { task: "review PR", files: ["server.ts"] }
  - Poll, verify metadata is an object (not a string) with correct contents

test("Send message with reply_to referencing existing message succeeds")
  - Send message A, get message_id
  - Send message B with reply_to: A's message_id
  - Poll, verify B has reply_to set correctly

test("Send message with reply_to referencing nonexistent message fails")
  - Send with reply_to: 999999
  - Verify response: { ok: false, error: contains "not found" }

test("Send message with invalid metadata (non-object) fails")
  - Send with metadata: "not an object" (via raw POST, bypassing TS types)
  - Verify response: { ok: false, error: contains "metadata must be a JSON object" }

test("Send message without type field defaults to 'text'")
  - Send with only from_id, to_id, text (no type field)
  - Poll, verify message has type: "text"

test("Send message with invalid type value fails")
  - Send with type: "invalid_type"
  - Verify response: { ok: false, error: contains "Invalid message type" }
```

### New Tests: "Broadcast" describe block

Placement: after "Structured Messages", before "Edge Cases".

Requires 3 live peers: use `brokerProc.pid` for peer A, `process.pid` for peer B, and a third process PID (spawn a `sleep 60` process for peer C's PID).

```
test("Broadcast to machine scope reaches all peers except sender")
  - Register peers A, B, C in different directories
  - Broadcast from A with scope "machine"
  - Poll B and C: both have the broadcast message
  - Poll A: no message (sender excluded)

test("Broadcast returns correct recipients count and message_ids")
  - Broadcast from A to scope "machine" (B and C are alive)
  - Verify response: recipients: 2, message_ids.length: 2

test("Broadcast with scope 'directory' only reaches same-directory peers")
  - Register A at /tmp/dir1, B at /tmp/dir1, C at /tmp/dir2
  - Broadcast from A with scope "directory", cwd: /tmp/dir1
  - Poll B: has message. Poll C: no message.

test("Broadcast with scope 'repo' only reaches same-repo peers")
  - Register A with git_root /tmp/repo1, B with git_root /tmp/repo1, C with git_root /tmp/repo2
  - Broadcast from A with scope "repo", git_root: /tmp/repo1
  - Poll B: has message. Poll C: no message.

test("Broadcast to scope with no other peers returns zero recipients")
  - Register only A at /tmp/lonely
  - Broadcast from A with scope "directory", cwd: /tmp/lonely
  - Verify response: { ok: true, recipients: 0, message_ids: [] }

test("Broadcast respects 10KB message size limit")
  - Broadcast with text > 10KB
  - Verify error response

test("Broadcast sets type to 'broadcast' by default")
  - Broadcast without explicit type
  - Poll recipient, verify message has type: "broadcast"

test("Broadcast counts as 1 request against rate limit, not N")
  - Send 59 regular messages (just under 60/min limit)
  - Send 1 broadcast to 3 peers
  - Verify broadcast succeeds (total = 60, not 62)
```

### Test Infrastructure

- Third PID for peer C: spawn `Bun.spawn(["sleep", "60"])` in `beforeAll`, kill in `afterAll`
- All tests use the auth token from the broker-auth test setup
- Broadcast tests need unique cwd/git_root per peer to test scope filtering
- Poll and ack helpers: extract reusable `pollMessages(peerId)` and `ackMessages(peerId, ids)` functions in test file

## Open Questions

1. **Metadata size in the 10KB limit**: Should metadata count toward the 10KB limit alongside text, or should it have its own separate limit? (Recommendation: combined limit of 10KB for `text + JSON.stringify(metadata)`. Simpler, prevents circumventing the limit by putting content in metadata.)

2. **reply_to across peers**: Should `reply_to` validation check that the referenced message was sent to or from the current sender? Or allow cross-peer threading (e.g., A replies to a message that was between B and C)? (Recommendation: no sender validation — just check the message exists. Cross-peer threading enables group coordination patterns like "replying to the broadcast I received".)

3. **Broadcast type override**: Should callers be able to override the `type` field on broadcast (e.g., broadcast a "query" to all peers)? The PRD allows it (`type?` defaults to `"broadcast"` but is overridable). (Recommendation: allow override. A broadcast query ("does anyone have X?") is a valid use case.)

4. **Message log format**: The `messages.log` file currently logs plain text messages. Should the log format include type/metadata? (Recommendation: yes, include type prefix and metadata summary in log entries. Keep the detailed metadata in the "Full message" section.)

5. **Future: per-type rate limits**: Should query/handoff/broadcast types have different rate limits than text? (Recommendation: not in this iteration. Single rate limit is sufficient. Per-type limits are future work if abuse patterns emerge.)
