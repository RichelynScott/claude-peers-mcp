# PRD-001: MCP Server Startup Reliability Under Load

**Status**: Draft
**Author**: Claude (automated)
**Date**: 2026-03-26
**Priority**: High
**Estimated Effort**: Medium (2-3 focused sessions)

---

## 1. Introduction

### Problem Statement

When 6 or more Claude Code sessions are already connected to the claude-peers broker, new sessions intermittently fail to start their MCP server on the first attempt. The user sees a "Failed to connect" error in Claude Code's MCP dialog, but a manual retry succeeds.

### Root Cause Analysis

The startup sequence in `src/server.ts` (`main()` function, lines 750-880) follows a strictly serial path:

1. `ensureBroker()` — health check + optional broker spawn (up to 6s timeout: 30 iterations x 200ms, line 133)
2. Read auth token from disk
3. Gather context (cwd, git root, TTY)
4. Generate auto-summary (up to 3s, line 794)
5. `POST /register` to broker
6. Connect MCP over stdio

The broker (`src/broker.ts`) runs a single `Bun.serve()` instance (line 579) on `127.0.0.1:7899`. All endpoints share the same async fetch handler. With N connected peers, the broker handles:

- **N poll requests/second** (`/poll-messages`, 1s interval per peer via `POLL_INTERVAL_MS`)
- **N heartbeats every 15s** (`/heartbeat`, 15s interval via `HEARTBEAT_INTERVAL_MS`)
- Additional `/list-peers` calls (triggered per-message in `pollAndPushMessages` at line 660 to look up sender info)

With 6 peers connected, the broker handles approximately 6-8 requests/second of steady-state background traffic. A new session's `/register` POST competes equally with these requests. Under Bun's event loop, the `handleRegister` function (line 280) performs multiple synchronous SQLite operations (PID lookup, TTY eviction queries, INSERT) which block the event loop during execution. If the new MCP server's fetch to `/register` happens to queue behind a burst of poll/heartbeat requests, the cumulative delay can exceed Claude Code's ~6-second MCP initialization window, causing the startup to timeout and report failure.

### Who It Affects

- **Power users** running 6+ concurrent Claude Code sessions (multi-agent orchestration, Ralph autonomous loops, research pipelines)
- **Any user** during high-activity periods where multiple sessions start simultaneously (e.g., opening a workspace that launches several Claude Code instances at once)
- **LAN federation users** where the broker has additional federation sync traffic on top of local peers

### Current Behavior

1. User opens a new Claude Code session (or session auto-starts an MCP server)
2. `ensureBroker()` succeeds (broker is already running)
3. `POST /register` is sent to broker
4. Broker is busy processing poll/heartbeat requests from existing peers
5. The `/register` response is delayed
6. Claude Code's MCP init window (~6s) expires before the server completes `mcp.connect()`
7. User sees "Failed to connect" in Claude Code's MCP connection dialog
8. User clicks retry, which succeeds because the broker is momentarily less busy

---

## 2. Goals

### Primary Goals

1. **Zero-retry startup**: New MCP servers should connect successfully on the first attempt in 99%+ of cases, even with 10+ existing peers.
2. **Deterministic timeout behavior**: The server should have clear, configurable timeout boundaries rather than a fixed 6-second hardcoded limit.
3. **Graceful degradation**: When the broker genuinely cannot accept new connections (e.g., resource exhaustion), the error message should be actionable, not opaque.

### Secondary Goals

4. **Observability**: Startup timing should be logged so slowdowns can be diagnosed from `cpm-logs/server.log`.
5. **Backward compatibility**: No changes to the MCP protocol, tool definitions, or Claude Code integration points. Existing peers should not be disrupted during the rollout.

---

## 3. User Stories

### US-001: Retry Logic on MCP Server Startup

**As** a Claude Code user starting a new session while many peers are connected,
**I want** the MCP server to automatically retry its broker registration if the first attempt fails,
**So that** I never see "Failed to connect" due to transient broker load.

#### Acceptance Criteria

- [ ] The `main()` function in `server.ts` wraps the `/register` call in a retry loop with **3 attempts maximum**.
- [ ] Retry uses **exponential backoff**: attempt 1 at 0ms, attempt 2 after 1s, attempt 3 after 3s (total worst-case: ~4s of retry delay).
- [ ] Each individual `/register` fetch has an explicit `AbortSignal.timeout()` of **5 seconds** (prevents hanging on a single attempt).
- [ ] On retry, the server logs `[CPM-server] Register attempt N/3 failed: <reason>, retrying in Xs...` to stderr and `cpm-logs/server.log`.
- [ ] On final failure (all 3 attempts exhausted), the server logs a clear fatal message including broker URL and peer count (if available from `/health`), then exits with code 1.
- [ ] Successful registration after retry logs `[CPM-server] Registered as peer <id> (attempt N/3)`.
- [ ] `ensureBroker()` retry loop remains unchanged (it handles broker *spawn*, not registration).
- [ ] Existing tests in `server.test.ts` continue to pass.
- [ ] New test: mock broker that rejects the first `/register` call with HTTP 503, verify server retries and succeeds on attempt 2.

#### Technical Notes

The retry wraps only the `brokerFetch<RegisterResponse>("/register", {...})` call at line 797 of `server.ts`. The `ensureBroker()` call (line 752) already has its own 30-iteration retry loop for broker spawn. These are independent failure modes and should not share retry logic.

---

### US-002: Broker Prioritizes /register Over /heartbeat and /poll-messages

**As** the broker daemon handling many connected peers,
**I want** to process `/register` requests with higher priority than background `/heartbeat` and `/poll-messages` requests,
**So that** new sessions can connect quickly even when steady-state traffic is high.

#### Acceptance Criteria

- [ ] The broker's `fetch()` handler in `broker.ts` detects the request path **before** parsing the JSON body.
- [ ] `/register` requests are processed immediately (fast-path) without waiting behind queued poll/heartbeat body parsing.
- [ ] Implementation option A (recommended): Read the URL path first. If it is `/register`, parse body and handle synchronously before yielding back to the event loop. For `/heartbeat` and `/poll-messages`, consider deferring body parsing with `setImmediate` / `queueMicrotask` to allow `/register` to jump ahead.
- [ ] Implementation option B (alternative): Use a semaphore/queue that limits concurrent poll/heartbeat processing to N (e.g., 4), but always admits `/register` immediately regardless of queue depth.
- [ ] The optimization does NOT change the behavior or response format of any endpoint.
- [ ] Benchmark test: With 10 mock peers sending `/poll-messages` every 100ms, a `/register` request completes in under 500ms (measured from request send to response received).
- [ ] No regressions in `broker.test.ts`.

#### Technical Notes

Bun's `Bun.serve()` uses a single-threaded event loop similar to Node.js. The `async fetch()` handler at line 582 awaits `req.json()` for every POST request at line 636. This JSON body parsing is where the event loop yields. The key insight is that `/register` involves synchronous SQLite operations (which block the event loop) while `/poll-messages` also involves synchronous SQLite. The priority mechanism needs to work at the request scheduling level, not the SQLite level.

A practical approach: check `url.pathname` before the `switch` block. If the path is `/register`, process it inline. For `/heartbeat` and `/poll-messages`, wrap the handler in a `setTimeout(fn, 0)` to yield and let any pending `/register` run first. This is a cooperative yield, not true preemption, but it reduces head-of-line blocking for the common case.

---

### US-003: Configurable Startup Timeout

**As** a user or system administrator,
**I want** the MCP server's startup timeout to be configurable and default to a more generous value,
**So that** transient broker delays don't cause hard failures.

#### Acceptance Criteria

- [ ] New environment variable: `CLAUDE_PEERS_STARTUP_TIMEOUT_MS` (default: `15000`, i.e., 15 seconds).
- [ ] Also readable from the persistent config file (`~/.claude-peers-config.json`) under `{ "server": { "startup_timeout_ms": 15000 } }`. Env var overrides config file.
- [ ] The `ensureBroker()` function uses this timeout to calculate its retry iterations: `Math.ceil(timeout / 200)` instead of the current hardcoded `30`.
- [ ] The overall `main()` startup sequence is wrapped in an `AbortSignal.timeout(STARTUP_TIMEOUT_MS)` or equivalent, so the entire init (broker check + token read + context gather + summary + register + MCP connect) cannot exceed the configured timeout.
- [ ] The timeout value is logged at startup: `[CPM-server] Startup timeout: 15000ms`.
- [ ] Config file schema updated in `shared/config.ts`: add optional `server` section with `startup_timeout_ms`.
- [ ] If the user sets an unreasonably low value (< 3000ms), clamp to 3000ms and log a warning.
- [ ] Existing behavior preserved when no env var or config is set (default 15s is more generous than current 6s).
- [ ] New test: verify that `CLAUDE_PEERS_STARTUP_TIMEOUT_MS=5000` results in `ensureBroker()` using 25 iterations (5000/200).
- [ ] New test: verify that values below 3000 are clamped.

#### Technical Notes

The current hardcoded 6-second timeout comes from `ensureBroker()` (line 133: `for (let i = 0; i < 30; i++)` with 200ms sleep = 6 seconds). But the full startup path includes additional time for auto-summary generation (up to 3s, line 794) and the `/register` call itself. The total startup window should account for all phases, not just broker health checks.

The `PeersConfig` interface in `src/shared/config.ts` should be extended:

```typescript
export interface PeersConfig {
  federation?: { enabled?: boolean; port?: number; subnet?: string };
  server?: { startup_timeout_ms?: number };
}
```

---

### US-004: Graceful Error Message When Broker Is Overloaded

**As** a user whose MCP server fails to start,
**I want** a clear, actionable error message explaining why startup failed and what I can do,
**So that** I don't have to guess whether to retry, restart the broker, or investigate deeper.

#### Acceptance Criteria

- [ ] When all registration retries are exhausted (US-001), the fatal error includes:
  - Broker URL attempted (`http://127.0.0.1:7899`)
  - Whether the broker is reachable (health check result)
  - Number of currently connected peers (from `/health` response, which returns `{ status: "ok", peers: N }`)
  - Suggestion text: "The broker may be overloaded with N active peers. Try again or run `bun cli.ts kill-broker` to restart it."
- [ ] When `ensureBroker()` itself fails (broker won't start), the error includes:
  - The broker script path
  - Whether port 7899 is in use by another process
  - Suggestion: "Check if another process is using port 7899: `lsof -i :7899`"
- [ ] Error messages are written to both stderr and `cpm-logs/server.log`.
- [ ] The exit code is `1` for all startup failures (unchanged from current behavior).
- [ ] The error message format is a single multi-line string (not multiple `log()` calls that could be interleaved with other output).
- [ ] New test: simulate broker returning 503 on `/register` for all retries, verify the error message contains peer count and suggestion text.

#### Technical Notes

The current fatal error at line 877-879 is generic: `Fatal: ${e.message}`. The enhanced error should be constructed in a `buildStartupErrorMessage()` helper that probes `/health` for diagnostics before logging the failure. This probe should have its own short timeout (1s) so it doesn't delay the error report.

---

### US-005: Startup Timing Observability

**As** a developer debugging slow MCP startups,
**I want** each startup phase to be timed and logged,
**So that** I can identify which phase is the bottleneck.

#### Acceptance Criteria

- [ ] Each phase of `main()` is timed with `performance.now()` or `Date.now()`:
  - Phase 1: `ensureBroker()` duration
  - Phase 2: Token read duration
  - Phase 3: Context gathering (cwd, git root, TTY) duration
  - Phase 4: Auto-summary generation duration (including whether it was clipped by the 3s timeout)
  - Phase 5: `/register` call duration (including retry attempts)
  - Phase 6: `mcp.connect()` duration
  - Total startup time
- [ ] On successful startup, a summary line is logged: `[CPM-server] Startup complete in Xms (broker=Yms, register=Zms, total=Xms)`.
- [ ] On failed startup, the timing of the last completed phase is included in the error for diagnosis.
- [ ] No new dependencies introduced (use built-in timing APIs only).

#### Technical Notes

This is a logging-only change to `main()` in `server.ts`. No behavioral changes to any endpoint. The timing data should use millisecond precision. Example log output:

```
[CPM-server] Startup timing: broker=12ms, token=1ms, context=45ms, summary=1203ms, register=89ms, mcp=23ms, total=1373ms
```

---

### US-006: Broker Health Endpoint Enhancement

**As** the MCP server performing startup diagnostics,
**I want** the `/health` endpoint to return load information,
**So that** the server can make informed retry decisions.

#### Acceptance Criteria

- [ ] The `/health` endpoint (line 587-589 of `broker.ts`) response is extended to include:
  - `peers`: number of registered peers (already present)
  - `uptime_ms`: broker uptime in milliseconds
  - `requests_last_minute`: approximate number of requests handled in the last 60 seconds
  - `pending_messages`: count of undelivered messages in the messages table
- [ ] The response remains backward-compatible: existing fields (`status`, `peers`) are unchanged.
- [ ] Request counting uses a simple ring buffer or counter that resets every 60 seconds (no external dependencies).
- [ ] The MCP server's retry logic (US-001) can optionally log the health response when a `/register` attempt fails, providing context for diagnosis.
- [ ] New test: verify `/health` returns the new fields with correct types.

#### Technical Notes

The broker already tracks rate limits per IP for `/send-message` (line 609-623). A similar lightweight counter can track total requests per minute. Implementation: increment an atomic counter on every `fetch()` entry, and reset it on a 60-second interval (similar to the existing `rateLimits` cleanup at `setInterval`).

Uptime can be computed from a `const BROKER_START_TIME = Date.now()` captured at module load.

---

## 4. Technical Considerations

### Bun.serve() Concurrency Model

Bun's HTTP server uses a single-threaded event loop. The `async fetch()` handler processes one request at a time through its synchronous portions. Key bottlenecks:

- **`req.json()` body parsing** (line 636): Async but fast for small payloads
- **SQLite operations** (`handleRegister`, `handlePollMessages`, etc.): **Synchronous** via `bun:sqlite` — these block the event loop
- **PID liveness checks** (`process.kill(pid, 0)` in `handleListPeers`, `handleSendMessage`): Synchronous syscalls

The `handleRegister` function (line 280-312) performs 2-3 SQLite queries synchronously (PID lookup, TTY eviction scan, INSERT). Under load, if these operations take even 1-2ms each, and there are 6+ poll requests queued ahead, the cumulative delay can reach 20-50ms per request cycle, creating a multi-hundred-millisecond queue for the registration request.

### SQLite WAL Mode

The broker uses WAL mode (`PRAGMA journal_mode = WAL`, line 138) which allows concurrent reads. However, all operations go through the same Bun event loop thread, so concurrency benefits are limited to preventing write starvation, not actual parallel execution.

### Request Volume Scaling

| Peers | Polls/sec | Heartbeats/sec | Total Background RPS |
|-------|-----------|----------------|----------------------|
| 2     | 2         | 0.13           | ~2.1                 |
| 6     | 6         | 0.40           | ~6.4                 |
| 10    | 10        | 0.67           | ~10.7                |
| 15    | 15        | 1.00           | ~16.0                |
| 20    | 20        | 1.33           | ~21.3                |

At 10+ peers, the broker handles 10+ requests/second just for background maintenance. Each poll triggers a SQLite SELECT. The `/poll-messages` handler (line 532-544) is fast (single prepared statement), but at 10 RPS, it still occupies the event loop for ~10-20ms per second cumulative.

Additionally, `pollAndPushMessages()` in `server.ts` (line 660) calls `/list-peers` for every received message to look up sender info. During active message traffic, this multiplies the load.

### Backward Compatibility

All changes are internal to the broker and MCP server startup path. No changes to:
- MCP tool definitions or response formats
- CLI interface (`cli.ts`)
- SQLite schema
- Auth token mechanism
- Federation protocol
- Channel push notification format

### Migration Path

1. **Phase 1** (this PRD): Server-side retry + configurable timeout + better errors
2. **Phase 2** (future): Broker-side priority queue + health enhancements
3. **Phase 3** (future, if needed): Move to WebSocket connections for peers to eliminate polling overhead entirely

---

## 5. Non-Goals

The following are explicitly **out of scope** for this PRD:

1. **Replacing HTTP polling with WebSockets** — This would eliminate the background RPS problem entirely but is a significant architectural change. Tracked separately as a future enhancement.

2. **Multi-threaded broker** — Bun supports worker threads, but introducing them for the broker adds complexity disproportionate to the problem. The single-threaded model is correct for the current scale (up to ~20 peers).

3. **Client-side connection pooling or keep-alive optimization** — The `brokerFetch` helper creates a new connection per request. HTTP keep-alive could reduce overhead but is a Bun runtime concern, not an application-level fix.

4. **Reducing poll frequency dynamically** — Adaptive polling (e.g., backing off when no messages are received) would reduce load but changes message delivery latency characteristics. This is a separate optimization.

5. **Claude Code MCP timeout configuration** — The ~6-second startup window is imposed by Claude Code's MCP host, not by claude-peers. We cannot change it from the MCP server side. All mitigations must work within that constraint.

6. **Broker sharding or clustering** — Running multiple broker instances for load distribution is unnecessary at the current scale (single machine, <50 peers).

7. **Auto-summary removal during startup** — The 3-second auto-summary generation (line 794) could be made fully non-blocking to speed up startup, but this is an independent optimization that doesn't address the core registration timeout issue.

---

## 6. Success Metrics

### Primary Metrics

| Metric | Current State | Target | Measurement Method |
|--------|---------------|--------|--------------------|
| First-attempt startup success rate | ~85% at 6+ peers (estimated from user reports) | 99%+ at 10+ peers | Automated test: start 12 MCP servers concurrently, count successful registrations |
| Startup time (p95) | ~4-6s (includes auto-summary) | <3s with retry, <5s worst case | `cpm-logs/server.log` timing output (US-005) |
| User-visible "Failed to connect" errors | ~1 in 6 new sessions when loaded | <1 in 100 | Manual testing over 1-week observation period |

### Secondary Metrics

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Startup error message clarity | Error includes broker URL, peer count, and actionable suggestion | Code review of error formatting |
| Startup timing visibility | All 6 phases timed and logged | `server.log` inspection |
| Config discoverability | Timeout configurable via env var and config file | Documentation + test |

### Validation Plan

1. **Unit tests**: Each user story has specific test criteria (see acceptance criteria above)
2. **Load test**: Script that spawns N concurrent MCP server processes against a running broker, measures registration success rate and latency distribution
3. **Manual soak test**: Run 8+ Claude Code sessions for 1 hour, start 2 new sessions every 10 minutes, verify zero "Failed to connect" errors
4. **Regression test**: Existing `broker.test.ts` (40 tests), `server.test.ts` (18 tests), and `cli.test.ts` (17 tests) all pass with no modifications

---

## 7. Implementation Order

The user stories have natural dependencies and should be implemented in this order:

```
US-005 (Startup Timing)       ─── no deps, logging only
  |
US-003 (Configurable Timeout) ─── depends on understanding current timing (US-005)
  |
US-001 (Retry Logic)          ─── uses configurable timeout (US-003)
  |
US-004 (Graceful Errors)      ─── enhances retry failure path (US-001)
  |
US-006 (Health Enhancement)   ─── provides data for error messages (US-004)
  |
US-002 (Broker Priority)      ─── independent broker change, test last for regressions
```

**Recommended implementation**: US-005 and US-003 can be done in a single session. US-001 and US-004 together in a second session. US-006 and US-002 in a third session.

---

## 8. Open Questions

1. **What is Claude Code's actual MCP startup timeout?** The 6-second figure is inferred from the `ensureBroker()` loop (30 x 200ms). The actual Claude Code host timeout may be different and should be verified from Claude Code's documentation or source code.

2. **Should the broker expose a `/ready` endpoint distinct from `/health`?** The `/health` endpoint currently checks if the broker is responding. A `/ready` endpoint could indicate the broker has completed all startup tasks (DB migrations, stale peer cleanup, federation init) and is ready to accept registrations.

3. **Is the per-message `/list-peers` call in `pollAndPushMessages()` necessary?** Line 660-673 of `server.ts` calls `/list-peers` for every received message just to look up the sender's name and summary. This could be cached or included in the message payload by the broker to reduce request volume by ~30-50% during active messaging.

---

## Appendix A: Key Source File References

| File | Lines | Relevance |
|------|-------|-----------|
| `src/server.ts` | 100-141 | `ensureBroker()` — broker spawn + 6s health check loop |
| `src/server.ts` | 750-880 | `main()` — full startup sequence |
| `src/server.ts` | 53-89 | `brokerFetch()` — HTTP client with 401 retry |
| `src/server.ts` | 644-734 | `pollAndPushMessages()` — per-message `/list-peers` call |
| `src/broker.ts` | 280-312 | `handleRegister()` — SQLite eviction + insert |
| `src/broker.ts` | 532-544 | `handlePollMessages()` — undelivered message query |
| `src/broker.ts` | 579-686 | `Bun.serve()` — HTTP server with shared fetch handler |
| `src/broker.ts` | 587-589 | `/health` endpoint — current minimal implementation |
| `src/shared/config.ts` | 1-53 | Config file loading (needs `server` section) |

## Appendix B: Related Backlog Items

- **WebSocket migration**: Replace HTTP polling with persistent WebSocket connections for message delivery. Would eliminate ~90% of background RPS. Major architectural change, tracked separately.
- **Sender info caching**: Cache peer metadata in the MCP server to avoid per-message `/list-peers` calls. Quick win, independent of this PRD.
- **Adaptive poll interval**: Increase poll interval when no messages are pending (e.g., 1s -> 5s after 30s idle). Reduces broker load at the cost of message delivery latency.
