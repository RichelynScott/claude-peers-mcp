# PRD: MCP Server Tool Handler Tests (server.test.ts)

## Introduction

The MCP server in `server.ts` has 5 tool handlers (list_peers, send_message, set_summary, set_name, check_messages) plus a broadcast_message tool (added by prd-structured-messages.md). These handlers have ZERO test coverage. The broker has 19 integration tests in `broker.test.ts`, but nothing validates the MCP tool layer -- the schemas, input validation, error formatting, response content structure, or the full request-through-MCP-protocol-to-broker path.

This PRD creates `server.test.ts`, an integration test suite that spins up a real broker and connects an MCP client to a real MCP server over stdio. This tests the full stack: MCP protocol parsing, tool schema registration, tool handler logic, broker communication, and response formatting.

**Dependencies**: This PRD assumes both prior PRDs are implemented:
1. **Broker Auth** (prd-broker-auth.md): All broker endpoints require `Authorization: Bearer <token>`. The MCP server reads the token and includes it in `brokerFetch()` calls. `/health` is exempt.
2. **Structured Messages + Broadcast** (prd-structured-messages.md): Messages have `type`, `metadata`, `reply_to` fields. New `/broadcast` endpoint. New `broadcast_message` MCP tool. Updated `send_message` tool schema with optional type/metadata/reply_to parameters.

## Goals

- **G-1**: Achieve comprehensive test coverage of all 6 MCP tool handlers through the full MCP protocol (client -> stdio -> server -> broker -> response).
- **G-2**: Validate tool schema registration -- `listTools()` returns all 6 tools with correct names and input schemas.
- **G-3**: Validate error handling and error formatting for each tool (not-registered edge cases, invalid inputs, broker errors).
- **G-4**: Validate structured message features (type, metadata, reply_to) at the MCP tool layer, not just the broker HTTP layer.
- **G-5**: Validate the broadcast_message tool end-to-end.
- **G-6**: Test file is self-contained and follows the same patterns as `broker.test.ts` (real processes, temp DB, temp token, cleanup on teardown).
- **G-7**: ~20 tests total, completing in under 30 seconds.

## User Stories

### US-001: Tool registration validation

**Description:** As a developer, I want a test that verifies `listTools()` returns all 6 tools with correct names and schemas so that MCP clients can discover and invoke the tools correctly.

**Acceptance Criteria:**
- [ ] `client.listTools()` returns exactly 6 tools
- [ ] Tool names are: `list_peers`, `send_message`, `set_summary`, `set_name`, `check_messages`, `broadcast_message`
- [ ] Each tool has a non-empty `description` string
- [ ] Each tool has a valid `inputSchema` object with `type: "object"` and `properties`
- [ ] `send_message` schema includes optional `type`, `metadata`, `reply_to` properties (from structured messages PRD)
- [ ] `broadcast_message` schema includes required `message` and `scope` properties

### US-002: list_peers tool tests

**Description:** As a developer, I want tests that verify the list_peers tool returns correct peer data through the MCP protocol so that peer discovery works end-to-end.

**Acceptance Criteria:**
- [ ] Test: list_peers with scope "machine" returns empty when no other peers are registered (the MCP server itself is registered, but it excludes itself via `exclude_id`)
- [ ] Test: After registering a second peer directly via broker HTTP API, list_peers returns that peer with correct fields (ID, CWD, summary, etc.)
- [ ] Test: Scope filtering works -- register a peer in a different directory, verify scope "directory" excludes it while scope "machine" includes it
- [ ] All tests verify the MCP response format: `content` array with a single `text` item

### US-003: send_message tool tests

**Description:** As a developer, I want tests that verify the send_message tool correctly sends messages to other peers and handles error cases through the MCP protocol.

**Acceptance Criteria:**
- [ ] Test: Successfully sends a plain text message to a registered peer, response includes message ID and preview
- [ ] Test: Sending to a nonexistent peer ID returns an error response (`isError: true` in the MCP response)
- [ ] Test: Sends a message with `type: "query"` and `metadata`, verifiable by polling the recipient via broker HTTP API
- [ ] Test: Sends a message with `reply_to` referencing an existing message ID
- [ ] All tests verify the MCP response content text format (message ID confirmation, error messages)

### US-004: set_summary and set_name tool tests

**Description:** As a developer, I want tests that verify set_summary and set_name tools correctly update the peer's metadata so that other peers can see the updated information.

**Acceptance Criteria:**
- [ ] Test: set_summary updates the summary, verifiable by listing peers via broker HTTP API
- [ ] Test: set_name updates the session name, verifiable by listing peers via broker HTTP API
- [ ] Both tests verify the MCP response confirms the update (contains the set value in the response text)

### US-005: check_messages tool tests

**Description:** As a developer, I want tests that verify the check_messages tool correctly retrieves and formats pending messages through the MCP protocol.

**Acceptance Criteria:**
- [ ] Test: check_messages returns "No new messages." when no messages are pending
- [ ] Test: After sending a message to the MCP server's peer via broker HTTP API, check_messages returns the message with correct sender and content
- [ ] Test: Message display includes type prefix for non-text types (e.g., `[QUERY]` for query type messages, per structured messages PRD)

### US-006: broadcast_message tool tests

**Description:** As a developer, I want tests that verify the broadcast_message tool correctly broadcasts to all peers in the specified scope.

**Acceptance Criteria:**
- [ ] Test: Broadcasts to machine scope, response indicates recipient count
- [ ] Test: Broadcasts when no other peers exist, response indicates 0 recipients
- [ ] Test: Broadcast messages are receivable by registered peers (verified by polling via broker HTTP API)

### US-007: Error handling edge cases

**Description:** As a developer, I want tests that verify the MCP server handles protocol-level errors correctly so that invalid tool calls produce clear error responses.

**Acceptance Criteria:**
- [ ] Test: Calling an unknown tool name via `client.callTool({ name: "nonexistent_tool", arguments: {} })` throws an MCP error or returns an error response
- [ ] Test: Calling send_message without required `to_id` parameter produces a meaningful error

## Functional Requirements

- **FR-1**: The test file uses Approach B (MCP client testing). It imports `Client` from `@modelcontextprotocol/sdk/client/index.js` and `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js` to connect to the MCP server over stdio.
- **FR-2**: The test file spins up a real broker process on a test port (18899 to avoid collision with broker.test.ts on 17899), with a temp SQLite database and temp auth token file.
- **FR-3**: The test file connects an MCP client to the server process (`bun server.ts`) via StdioClientTransport, passing `CLAUDE_PEERS_PORT` and `CLAUDE_PEERS_TOKEN` env vars so the server connects to the test broker.
- **FR-4**: The MCP server auto-registers itself with the broker on startup (in its `main()` function). Tests account for this -- the server's own peer ID is discoverable via broker HTTP API after connection.
- **FR-5**: To test messaging, tests register "helper" peers directly via broker HTTP API (bypassing MCP) and use those peers as send/receive targets.
- **FR-6**: The `post()` helper function includes the `Authorization: Bearer <token>` header (broker auth is a prerequisite).
- **FR-7**: All tool calls use `client.callTool({ name: "...", arguments: {...} })`. Results are typed as `{ content: Array<{ type: string, text: string }>, isError?: boolean }`.
- **FR-8**: Test teardown kills both the broker process and the MCP client transport, and cleans up temp DB and token files.
- **FR-9**: Tests run with `bun test server.test.ts` and complete in under 30 seconds.
- **FR-10**: The MCP server's auto-summary generation (via OpenAI gpt-5.4-nano) may be slow or fail in test environments. Tests must tolerate this -- the server should still register and become functional regardless of summary generation outcome. The 3-second timeout in `main()` handles this.

## Non-Goals (Out of Scope)

- **NG-1**: Testing the polling loop (`pollAndPushMessages`). Channel push notifications require the `claude/channel` experimental capability and a notification listener on the client, which adds significant complexity. The polling loop is an internal concern; message delivery is verified through `check_messages` and broker HTTP polling.
- **NG-2**: Testing broker startup/shutdown logic (`ensureBroker`, `cleanup`). The broker is managed externally in tests.
- **NG-3**: Testing auto-summary generation (`shared/summarize.ts`). This depends on an external OpenAI API call and is best-effort in the server.
- **NG-4**: Testing log file writes (`cpm-logs/`). Logging is observability, not core functionality.
- **NG-5**: Testing TTY detection, git root detection, or other environment-gathering logic. These are utility functions, not MCP tool handlers.
- **NG-6**: Modifying `server.ts`, `broker.ts`, `shared/types.ts`, or any other source file. This is a test-only PRD.
- **NG-7**: Performance testing or load testing. The 30-second timeout is a sanity check, not a performance benchmark.
- **NG-8**: Testing MCP protocol framing, JSON-RPC encoding, or transport-level behavior. The MCP SDK handles this; we test tool-level semantics.

## Technical Considerations

### File Paths

| File | Change Type | Description |
|------|-------------|-------------|
| `/home/riche/MCPs/claude-peers-mcp/server.test.ts` | Create | New test file, ~350-450 lines |

No other files are modified.

### Test Infrastructure Setup

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

const TEST_PORT = 18899;  // Different from broker.test.ts (17899)
const TEST_DB = `/tmp/claude-peers-server-test-${Date.now()}.db`;
const TEST_TOKEN_PATH = `/tmp/claude-peers-server-test-token-${Date.now()}`;
const TEST_TOKEN = crypto.randomBytes(32).toString("hex");
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_DIR = "/home/riche/MCPs/claude-peers-mcp";

let brokerProcess: ReturnType<typeof Bun.spawn>;
let client: Client;
let transport: StdioClientTransport;
```

### beforeAll Sequence

The setup must happen in this exact order, because each step depends on the previous one:

1. **Write test token file** -- broker and server both need it on startup.
2. **Start broker process** -- must be alive before the MCP server tries to connect.
3. **Wait for broker health** -- poll GET `/health` up to 6 seconds (same as `broker.test.ts`).
4. **Create StdioClientTransport** -- spawns `bun server.ts` as a child process with test env vars.
5. **Create MCP Client and connect** -- initiates the MCP handshake over stdio. The server registers with the broker during its `main()` startup.
6. **Brief pause** -- allow 1-2 seconds for the server's `main()` to complete registration and summary generation timeout.

```typescript
beforeAll(async () => {
  // 1. Write test token
  fs.writeFileSync(TEST_TOKEN_PATH, TEST_TOKEN, { mode: 0o600 });

  // 2. Start broker
  brokerProcess = Bun.spawn(["bun", "broker.ts"], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
      CLAUDE_PEERS_TOKEN: TEST_TOKEN_PATH,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  // 3. Wait for broker
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // 4-5. Connect MCP client to server
  transport = new StdioClientTransport({
    command: "bun",
    args: ["server.ts"],
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_TOKEN: TEST_TOKEN_PATH,
    },
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);

  // 6. Allow server registration to complete
  await new Promise(r => setTimeout(r, 2000));
});
```

### afterAll Cleanup

```typescript
afterAll(async () => {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  brokerProcess?.kill();
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_TOKEN_PATH); } catch {}
});
```

### Helper: Authenticated POST to Broker

Tests need to register helper peers and send/poll messages directly via the broker HTTP API (bypassing MCP). This helper includes the auth token:

```typescript
async function post(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
```

### Helper: Register a Helper Peer

Helper peers are registered directly with the broker (not through MCP) for use as message targets. They need a real alive PID for the broker's liveness check:

```typescript
async function registerHelperPeer(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data } = await post("/register", {
    pid: process.pid,  // Test runner PID (alive)
    cwd: "/tmp/helper-peer",
    git_root: null,
    tty: null,
    session_name: "helper",
    summary: "test helper",
    ...overrides,
  });
  return (data as { id: string }).id;
}
```

### Helper: Extract Text from MCP Tool Result

All MCP tool results follow the pattern `{ content: [{ type: "text", text: "..." }] }`. This helper extracts the text:

```typescript
function resultText(result: Awaited<ReturnType<typeof client.callTool>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map(c => c.text).join("\n");
}
```

### Discovering the MCP Server's Own Peer ID

The MCP server registers itself with the broker during `main()`. To send messages TO the MCP server (for `check_messages` testing), tests need to discover its peer ID. This is done by listing all peers via broker HTTP API and finding the one that is NOT a helper peer:

```typescript
async function getServerPeerId(): Promise<string> {
  const { data } = await post("/list-peers", {
    scope: "machine",
    cwd: "/tmp",
    git_root: null,
  });
  const peers = data as Array<{ id: string; cwd: string }>;
  // The server's cwd is PROJECT_DIR; helper peers use /tmp paths
  const serverPeer = peers.find(p => p.cwd === PROJECT_DIR);
  if (!serverPeer) throw new Error("MCP server peer not found in broker");
  return serverPeer.id;
}
```

### Third PID for Multi-Peer Tests

Some tests (broadcast, scope filtering) need multiple helper peers with different PIDs (the broker deduplicates by PID on re-register). Spawn a long-running process:

```typescript
let sleepProcess: ReturnType<typeof Bun.spawn>;

// In beforeAll (after broker is ready):
sleepProcess = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });

// In afterAll:
sleepProcess?.kill();
```

Then register helper peers using `process.pid` and `sleepProcess.pid` for distinct PIDs.

### MCP callTool Interface

The MCP client's `callTool` method signature:
```typescript
const result = await client.callTool({
  name: "tool_name",
  arguments: { key: "value" },
});
// result.content: Array<{ type: string, text: string }>
// result.isError?: boolean
```

For error responses from tool handlers (where the handler returns `isError: true`), the MCP SDK may either:
- Return a result with `isError: true` on the result object
- Throw an error

Tests should handle both possibilities -- check `isError` if present, or catch thrown errors. The server.ts handlers consistently return `isError: true` in the response object for application-level errors (e.g., "Not registered with broker yet", "Failed to send: Peer xyz not found"), so the MCP SDK should surface these as non-throwing results with `isError: true`.

### Note on "Not Registered" Edge Case

Several tool handlers check `if (!myId)` and return an error "Not registered with broker yet". In the test setup, the MCP server registers during `main()` before the MCP protocol handshake completes. By the time `client.connect(transport)` resolves and the 2-second pause elapses, `myId` is always set. This means the "not registered" path cannot be tested via MCP client without complex timing manipulation. This is acceptable -- the path is simple and obvious. Tests focus on the paths that ARE reachable through normal MCP client interaction.

### Test Describe Block Structure

```
describe("Tool Registration")     — 1 test
describe("list_peers")             — 3 tests
describe("send_message")           — 4 tests
describe("set_summary")            — 1 test
describe("set_name")               — 1 test
describe("check_messages")         — 3 tests
describe("broadcast_message")      — 3 tests
describe("Error Handling")         — 2 tests
                                   --------
                            Total: ~18-20 tests
```

### Environment Considerations

- **OPENAI_API_KEY**: The server's auto-summary feature calls OpenAI. If the env var is unset in tests, the summary generation fails silently and falls back gracefully (server still registers with empty summary). Tests do not need to set this env var.
- **Working directory**: The MCP server's `process.cwd()` will be `PROJECT_DIR` (passed as `cwd` to StdioClientTransport). This affects how list_peers scope filtering works -- the server peer's `cwd` is the project directory.
- **Git root**: The MCP server calls `git rev-parse --show-toplevel` on startup. Since `PROJECT_DIR` is a git repo, `myGitRoot` will be set. This enables repo-scope testing.

### Port Collision Avoidance

- `broker.test.ts` uses port 17899
- `server.test.ts` uses port 18899
- Production broker uses port 7899

Running `bun test` will execute both test files. The different ports prevent collision if they run in parallel (Bun's test runner behavior may vary). If sequential execution is needed, this is handled naturally by Bun's test runner which runs files sequentially by default.

### Test Timeout

Set `bun test` timeout to 30 seconds. The main timing costs are:
- Broker startup: ~1-2s
- MCP client connection + server registration: ~3-4s (includes 2s pause for summary timeout)
- Test execution: ~5-10s
- Total: ~10-16s expected, 30s ceiling

If Bun's default test timeout is insufficient, individual tests can use the `timeout` option:
```typescript
test("name", async () => { ... }, { timeout: 10_000 });
```

Or set it globally in the `describe` block or via `bunfig.toml`.

## Success Metrics

| Metric | Target |
|--------|--------|
| All server tests pass | 18-20 green |
| All existing broker tests still pass | 19+ green (broker.test.ts unmodified) |
| Tool registration complete | listTools returns 6 tools with correct schemas |
| list_peers coverage | Empty, populated, and scope-filtered cases |
| send_message coverage | Success, error, structured message fields |
| set_summary/set_name coverage | Update verifiable via broker HTTP API |
| check_messages coverage | Empty, populated, type-prefixed display |
| broadcast_message coverage | Success, zero-recipients, verifiable delivery |
| Error handling coverage | Unknown tool, missing required params |
| Test runtime | Under 30 seconds |

## Test Plan

### Test Matrix

| # | Describe Block | Test Name | What It Verifies |
|---|---------------|-----------|------------------|
| 1 | Tool Registration | listTools returns all 6 tools with correct schemas | Tool discovery, schema completeness |
| 2 | list_peers | Returns no peers when server is alone | Empty state, self-exclusion |
| 3 | list_peers | Returns a registered helper peer | Peer data formatting, field presence |
| 4 | list_peers | Scope filtering: directory scope excludes peers in other directories | Scope logic through MCP layer |
| 5 | send_message | Sends message to a registered peer successfully | Happy path, response format with msg ID |
| 6 | send_message | Returns error for nonexistent peer ID | Error handling, isError flag |
| 7 | send_message | Sends structured message with type and metadata | Structured messages through MCP |
| 8 | send_message | Sends message with reply_to referencing existing message | Threading through MCP |
| 9 | set_summary | Updates summary, verifiable via broker API | Summary persistence |
| 10 | set_name | Updates session name, verifiable via broker API | Name persistence |
| 11 | check_messages | Returns "No new messages" when empty | Empty state |
| 12 | check_messages | Returns messages after peer sends one via broker API | Message retrieval through MCP |
| 13 | check_messages | Displays type prefix for non-text messages | Structured message display formatting |
| 14 | broadcast_message | Broadcasts to machine scope, reports recipient count | Broadcast happy path |
| 15 | broadcast_message | Reports 0 recipients when no other peers exist | Empty broadcast |
| 16 | broadcast_message | Broadcast messages are pollable by recipients | End-to-end delivery verification |
| 17 | Error Handling | Unknown tool name produces error | Protocol-level error handling |
| 18 | Error Handling | Missing required parameter produces error | Input validation |

### Verification Strategy

Each test uses one of two verification approaches:

1. **MCP response verification**: Check the `content[0].text` string and optional `isError` flag from the MCP tool call result. Used for all tool calls.

2. **Broker HTTP cross-check**: After an MCP tool call that mutates state (send_message, set_summary, set_name, broadcast), verify the state change by querying the broker directly via HTTP API (e.g., `/list-peers` to check summary/name, `/poll-messages` to check message delivery). This confirms the MCP tool correctly communicated with the broker.

### Test Ordering

Tests within each `describe` block may share state (e.g., a helper peer registered in one test is used by the next). Bun runs tests within a describe block in order. The describe blocks themselves are ordered to build up state progressively:

1. **Tool Registration** -- stateless, runs first
2. **list_peers** -- registers helper peers that subsequent tests can use
3. **send_message** -- uses helper peers from list_peers tests
4. **set_summary / set_name** -- modifies the MCP server's own peer metadata
5. **check_messages** -- requires messages to be sent TO the MCP server peer
6. **broadcast_message** -- requires multiple helper peers
7. **Error Handling** -- stateless edge cases, runs last

## Open Questions

1. **MCP client error behavior**: Does `client.callTool()` throw an exception for unknown tool names, or does it return a result with an error field? The test should handle both patterns. (Recommendation: wrap in try/catch and assert either the thrown error or the result's isError field. Verify empirically during implementation.)

2. **Server registration timing**: The 2-second pause after `client.connect()` assumes the server's `main()` completes within that window (including the 3-second summary generation race). If the OpenAI call hangs, the server still registers after the 3s timeout. A 2s pause should be sufficient since `ensureBroker()` returns quickly when the test broker is already running. (Recommendation: if tests are flaky, increase to 4 seconds or poll the broker for the server's peer registration.)

3. **Bun test parallelism**: If `bun test` runs `broker.test.ts` and `server.test.ts` in parallel, port conflicts could occur (17899 vs 18899 prevents this). However, both files spawn broker processes that try to clean stale peers -- this could interfere if they share a PID space. (Recommendation: the separate temp DB files prevent data conflicts. If issues arise, run files sequentially: `bun test broker.test.ts && bun test server.test.ts`.)

4. **StdioClientTransport env propagation**: Does `StdioClientTransport` forward the `env` option to the spawned child process correctly? The `@modelcontextprotocol/sdk` documentation suggests it does, but this should be verified during implementation. If not, the server would connect to the production broker instead of the test broker. (Recommendation: verify by checking the server's stderr output or by confirming the server's peer appears in the test broker's peer list.)

5. **check_messages ack behavior**: The `check_messages` tool handler calls `/poll-messages` but does NOT call `/ack-messages` (unlike the polling loop which does two-phase delivery). This means messages retrieved via `check_messages` remain "undelivered" in the broker and will be returned again on subsequent polls. Tests should account for this -- calling `check_messages` twice may return the same messages. (Recommendation: acknowledge this in the test and verify the behavior explicitly, or ack messages via broker HTTP API between test assertions.)
