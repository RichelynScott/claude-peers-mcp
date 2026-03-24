# PRD: Broker Authentication via Shared Token

## Introduction

Add bearer-token authentication to the claude-peers broker daemon. Today the broker accepts unauthenticated requests from any process on localhost. While acceptable for single-user localhost operation, this is a prerequisite for the planned LAN cross-machine discovery feature (where unauthenticated access would be a critical vulnerability) and a defense-in-depth improvement even on localhost. A single auto-generated token stored at `~/.claude-peers-token` will be shared by the broker, all MCP server instances, and the CLI.

**Cross-cutting change**: This modifies every broker endpoint (except `/health`), both clients (`server.ts`, `cli.ts`), and all 19 existing tests. Every future feature that adds endpoints or clients must include the Authorization header.

## Goals

- **G-1**: No unauthenticated access to mutation/query endpoints. Only `/health` remains open.
- **G-2**: Zero-friction setup. Token is auto-generated on first broker start; no manual configuration needed.
- **G-3**: Token rotation without broker restart. Operator can rotate the token file and the broker picks it up within 60 seconds.
- **G-4**: Clear, actionable error messages when authentication fails (missing token file, invalid token, expired token after rotation).
- **G-5**: All 19 existing tests continue to pass (updated to include auth). New auth-specific tests added.
- **G-6**: No breaking changes to the MCP tool interface. Claude Code sessions see no difference in `list_peers`, `send_message`, etc.

## User Stories

### US-001: Auto-generated token on first broker start

**Description:** As a user starting claude-peers for the first time, I want the broker to automatically create a secure token file so that authentication works without any manual setup.

**Acceptance Criteria:**
- [ ] On startup, broker checks for token file at path from `CLAUDE_PEERS_TOKEN` env var (default: `~/.claude-peers-token`)
- [ ] If file does not exist, broker generates 32 cryptographically random bytes, hex-encodes them (64-char string), writes to token file with mode `0600`
- [ ] If file already exists, broker reads the token from it (trimming whitespace/newlines)
- [ ] Broker logs: `[CPM-broker] Token loaded from <path>` (never logs the token value itself)
- [ ] Token file contains only the hex string (no JSON, no headers, no newlines except optional trailing)

### US-002: Broker rejects unauthenticated requests

**Description:** As a security-conscious operator, I want the broker to reject any request without a valid token so that only authorized processes can interact with the peer network.

**Acceptance Criteria:**
- [ ] All POST endpoints require `Authorization: Bearer <token>` header
- [ ] GET `/health` remains unauthenticated (needed for liveness probes before token is available)
- [ ] Missing `Authorization` header returns HTTP 401 with body `{ "error": "Unauthorized" }`
- [ ] Invalid/wrong token returns HTTP 401 with body `{ "error": "Unauthorized" }` (no information leakage about expected token)
- [ ] Non-POST requests to non-`/health` paths (e.g., `GET /register`) remain unauthenticated (they return the static `"claude-peers broker"` text and expose no data)
- [ ] Auth check runs BEFORE rate limiting and request body parsing (fail fast)

### US-003: MCP server reads token and authenticates

**Description:** As a Claude Code MCP server instance, I want to automatically read the token and include it in all broker requests so that authentication is transparent to the Claude Code user.

**Acceptance Criteria:**
- [ ] On startup (in `main()`), `server.ts` reads token from `CLAUDE_PEERS_TOKEN` env var path (default: `~/.claude-peers-token`)
- [ ] Token is stored in a module-level variable and included as `Authorization: Bearer <token>` in every `brokerFetch()` call
- [ ] If token file does not exist at startup, `server.ts` logs a clear error and exits with code 1: `Fatal: Token file not found at <path>. Is the broker running?`
- [ ] If a `brokerFetch()` call receives HTTP 401, the server re-reads the token file (handles rotation) and retries the request once. If retry also fails, it throws the original error.
- [ ] The `isBrokerAlive()` function (GET `/health`) does NOT send the token (health is unauthenticated)

### US-004: CLI reads token and authenticates

**Description:** As a CLI user, I want `bun cli.ts` commands to automatically authenticate with the broker so that I can manage peers without manual token handling.

**Acceptance Criteria:**
- [ ] On startup, `cli.ts` reads token from `CLAUDE_PEERS_TOKEN` env var path (default: `~/.claude-peers-token`)
- [ ] Token is included as `Authorization: Bearer <token>` in every `brokerFetch()` call
- [ ] If token file does not exist, CLI prints `Error: Token file not found at <path>. Is the broker running?` and exits with code 1
- [ ] `bun cli.ts status` works (it calls both unauthenticated `/health` and authenticated `/list-peers`)

### US-005: Token rotation via CLI

**Description:** As an operator, I want to rotate the broker token via CLI command so that I can invalidate a potentially compromised token.

**Acceptance Criteria:**
- [ ] New CLI command: `bun cli.ts rotate-token`
- [ ] Generates 32 cryptographically random bytes, hex-encodes to 64-char string
- [ ] Writes new token to the token file path (same path the broker reads from), mode `0600`
- [ ] Prints: `Token rotated. New token written to <path>. Broker will pick it up within 60 seconds.`
- [ ] Does NOT call any broker endpoint (rotation is file-based, broker re-reads periodically)

### US-006: Broker re-reads token periodically

**Description:** As an operator who has rotated the token, I want the broker to pick up the new token without a restart so that connected sessions can seamlessly re-authenticate.

**Acceptance Criteria:**
- [ ] Broker re-reads the token file every 60 seconds (on an interval timer)
- [ ] If the file contents changed, broker updates its in-memory token and logs: `[CPM-broker] Token reloaded from <path>`
- [ ] If the file is missing during re-read (deleted accidentally), broker keeps the previous token and logs a warning: `[CPM-broker] Warning: Token file missing at <path>, keeping previous token`
- [ ] Broker also re-reads on `SIGHUP` signal for immediate rotation (in addition to the 60s interval)

### US-007: Existing tests updated with authentication

**Description:** As a developer, I want all 19 existing broker tests to pass with authentication enabled so that the test suite validates the authenticated broker.

**Acceptance Criteria:**
- [ ] Test setup (`beforeAll`) generates a test token file at a temp path (e.g., `/tmp/claude-peers-test-token`)
- [ ] Broker test process is started with `CLAUDE_PEERS_TOKEN=/tmp/claude-peers-test-token` env var
- [ ] The `post()` helper function includes `Authorization: Bearer <token>` header in all requests
- [ ] The `/health` GET test does NOT include the Authorization header (verifies it works without auth)
- [ ] Test teardown (`afterAll`) cleans up the temp token file
- [ ] All 19 existing tests pass without logic changes (only header additions)

### US-008: New auth-specific tests

**Description:** As a developer, I want dedicated tests for authentication behavior so that regressions are caught early.

**Acceptance Criteria:**
- [ ] Test: POST to `/register` without Authorization header returns 401
- [ ] Test: POST to `/register` with wrong token returns 401
- [ ] Test: POST to `/register` with correct token returns 200
- [ ] Test: GET `/health` without Authorization header returns 200 (exempt)
- [ ] Test: POST to `/send-message` without Authorization header returns 401
- [ ] Test: All auth tests are in a new `describe("Authentication")` block, placed AFTER the Health tests and BEFORE Registration tests
- [ ] Total test count: 19 existing + at least 5 new auth tests = 24+ tests

## Functional Requirements

- **FR-1**: Token generation uses `crypto.getRandomValues()` (Web Crypto API, available in Bun) to produce 32 bytes of cryptographic randomness, hex-encoded to a 64-character string.
- **FR-2**: Token file path is configurable via `CLAUDE_PEERS_TOKEN` environment variable, defaulting to `${HOME}/.claude-peers-token`.
- **FR-3**: Token file permissions are set to `0600` (owner read/write only) on creation and rotation. Use `fs.chmodSync()` or equivalent.
- **FR-4**: Auth middleware in the broker runs as the first check after URL parsing, before rate limiting, before body parsing. Pseudocode:
  ```
  if (path !== "/health" && req.method === "POST") {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || authHeader !== `Bearer ${currentToken}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  ```
- **FR-5**: The `brokerFetch()` function in `server.ts` accepts the token as a parameter or reads from module state. The `Authorization` header is merged with the existing `Content-Type` header.
- **FR-6**: The `brokerFetch()` function in `cli.ts` follows the same pattern. Since `cli.ts` has a different `brokerFetch()` implementation (supports GET without body), both the POST and GET-with-auth paths must include the header.
- **FR-7**: Token re-read on 401 in `server.ts` is single-attempt (retry once). This prevents infinite loops if the token file itself is corrupt.
- **FR-8**: The SIGHUP handler for token re-read is additive — it does not replace the existing SIGINT/SIGTERM handlers in any file.
- **FR-9**: The `rotate-token` CLI command does not require the broker to be running. It only writes the file.

## Non-Goals (Out of Scope)

- **NG-1**: Per-peer tokens or ACLs. All authenticated clients share one token. Per-peer auth is a future consideration for LAN mode.
- **NG-2**: TLS/HTTPS on the broker. TLS is needed for LAN discovery but is out of scope for this localhost-only auth feature.
- **NG-3**: Token expiration or time-based rotation. The token is valid until manually rotated.
- **NG-4**: Changes to `shared/types.ts`. Authentication is transport-level (HTTP headers), not application-level (request/response types).
- **NG-5**: Changes to the MCP tool schemas or tool behavior. The tools (`list_peers`, `send_message`, etc.) are unaffected.
- **NG-6**: Automatic token distribution to other machines. This is a single-machine feature; LAN token sharing is future work.
- **NG-7**: The `hcom bridge`, `structured messages`, or `broadcast endpoint` backlog items.
- **NG-8**: `server.test.ts` (MCP server tests). That remains a separate backlog item.

## Technical Considerations

### File Paths (all in `/home/riche/MCPs/claude-peers-mcp/`)

| File | Changes |
|------|---------|
| `broker.ts` | Token generation/loading, auth middleware, 60s re-read interval, SIGHUP handler |
| `server.ts` | Read token on startup, add to `brokerFetch()` headers, 401 retry-with-reread logic |
| `cli.ts` | Read token on startup, add to `brokerFetch()` headers, new `rotate-token` command |
| `broker.test.ts` | Generate test token, pass `CLAUDE_PEERS_TOKEN` to broker process, update `post()` helper, add auth test block |
| `shared/types.ts` | No changes |

### Token Helper Extraction

Both `server.ts` and `cli.ts` need to read the token file. To avoid duplication, consider extracting a shared helper:

```typescript
// In shared/token.ts (new file, ~20 lines)
export const TOKEN_PATH = process.env.CLAUDE_PEERS_TOKEN ?? `${process.env.HOME}/.claude-peers-token`;

export function readTokenSync(): string {
  const file = Bun.file(TOKEN_PATH);
  if (!file.size) throw new Error(`Token file not found at ${TOKEN_PATH}`);
  // Read synchronously for startup
  const content = require("fs").readFileSync(TOKEN_PATH, "utf-8");
  return content.trim();
}
```

This is optional — inline reading in each file is also acceptable given only two consumers.

### Broker Startup Sequence

Current broker startup order:
1. Database setup + migrations
2. Stale peer cleanup
3. Start HTTP server

New order:
1. **Token generation/loading** (before anything else)
2. Database setup + migrations
3. Stale peer cleanup
4. Start HTTP server
5. **Start token re-read interval (60s)**
6. Register SIGHUP handler

### Impact on `ensureBroker()` in `server.ts`

The `ensureBroker()` function in `server.ts` spawns the broker if `/health` returns non-OK. Since `/health` is unauthenticated, no changes needed to `ensureBroker()` itself. The token file will already exist when the broker creates it, so `server.ts` can read it after `ensureBroker()` returns.

Race condition consideration: `server.ts` calls `ensureBroker()`, which spawns broker, which generates the token file. Then `server.ts` reads the token file. Since `ensureBroker()` polls `/health` until the broker is responsive (up to 6s), the token file will exist by the time `ensureBroker()` returns.

### Constant-Time Token Comparison

Use `crypto.timingSafeEqual()` (available in Bun via Node.js crypto module) to compare the provided token against the stored token. This prevents timing attacks, which matters especially for the future LAN feature.

```typescript
import { timingSafeEqual } from "crypto";

function isValidToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
```

### Rate Limiting Interaction

Auth check must run BEFORE rate limiting. A 401 rejection should NOT count against the rate limit (prevents a DoS vector where an attacker exhausts the rate limit with bad tokens, blocking legitimate requests).

### Backward Compatibility

This is a **breaking change for raw HTTP callers** (e.g., `curl` users, custom scripts hitting the broker directly). This is acceptable because:
- The broker is not a public API
- Only three consumers exist: `server.ts`, `cli.ts`, `broker.test.ts`
- All three are updated in this change

## Success Metrics

| Metric | Target |
|--------|--------|
| All existing tests pass | 19/19 green |
| New auth tests pass | 5+ new tests green |
| Token file created automatically on first run | Verified in test |
| 401 returned for missing/wrong token | Verified in test |
| `/health` works without token | Verified in test |
| Token rotation picked up within 60s | Verified manually (or with adjusted interval in test) |
| No secrets logged | Grep broker.log for token value returns zero matches |
| `server.ts` 401-retry works | Manual verification: rotate token, verify server recovers |

## Test Plan

### Updated Existing Tests (19 tests in `broker.test.ts`)

All existing test infrastructure changes:

1. `beforeAll`: Write a random test token to `/tmp/claude-peers-test-token`, start broker with `CLAUDE_PEERS_TOKEN=/tmp/claude-peers-test-token`
2. `post()` helper: Add `Authorization: Bearer <token>` to headers
3. `afterAll`: Clean up `/tmp/claude-peers-test-token`
4. No logic changes to any existing test assertions

### New Auth Tests (describe block: "Authentication")

```
test("POST /register without Authorization returns 401")
test("POST /register with wrong token returns 401")
test("POST /register with valid token returns 200")
test("GET /health without Authorization returns 200")
test("POST /send-message without Authorization returns 401")
```

### Manual Verification Checklist

- [ ] Fresh install: start broker, verify `~/.claude-peers-token` created with mode 0600
- [ ] Start MCP server: verify it reads token and registers successfully
- [ ] CLI status: verify it shows peers (authenticated)
- [ ] CLI rotate-token: verify new token written
- [ ] After rotation: verify broker picks up new token within 60s
- [ ] After rotation: verify MCP server retries with new token on 401
- [ ] curl without token: verify 401
- [ ] curl with token: verify 200

## Open Questions

1. **Token file location for tests**: The PRD specifies `/tmp/claude-peers-test-token`. Should this use `mktemp` for uniqueness to avoid collisions with parallel test runs? (Recommendation: yes, use `Bun.spawn(["mktemp"])` or `crypto.randomUUID()` suffix.)

2. **SIGHUP on WSL2**: Verify that `SIGHUP` works correctly under WSL2. If not, the 60s interval alone is sufficient and SIGHUP can be treated as best-effort.

3. **Shared token helper file**: Should `shared/token.ts` be created, or should token reading be inlined in `server.ts` and `cli.ts`? (Recommendation: create `shared/token.ts` to avoid duplication and ensure consistent path resolution. But keep it simple -- under 25 lines.)
