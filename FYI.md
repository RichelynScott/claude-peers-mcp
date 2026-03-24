# FYI - claude-peers-mcp Decision Journal

## 2026-03-24 - Future: LAN cross-machine peer discovery
### What: Investigate enabling Claude Code sessions on different machines to communicate over the same local network
### Why: User and coworker (Rafi) are on the same LAN. Currently CPM only works on localhost (127.0.0.1). Cross-machine communication would enable real-time collaboration between their Claude Code sessions.
### How: TBD — needs research. Key considerations: (1) broker would need to bind to LAN IP instead of 127.0.0.1, (2) mDNS/Bonjour for auto-discovery vs manual IP config, (3) authentication is critical — shared secret token, mTLS, or pre-shared key, (4) encryption — TLS required for any non-localhost traffic, (5) firewall rules, (6) message signing to prevent spoofing. Security-first design: restrict to same subnet, require mutual auth, encrypt all traffic.
### Impact: Would transform CPM from single-machine tool to team collaboration backbone
### Related: Consult PAL MCP (Grok 4.20 + Gemini) for security architecture before implementation

## 2026-03-24 - Two-phase message delivery + liveness check
### What: Replaced at-most-once delivery with at-least-once via two-phase poll+ack. Added PID liveness check on send.
### Why: Messages were silently lost if channel notification failed after broker marked them delivered. User experienced "sent but never received" limbo. Grok 4.20 Reasoning (via PAL thinkdeep) recommended this over a 2s blocking wait approach.
### How: /poll-messages no longer marks delivered. New /ack-messages endpoint called by MCP server AFTER successful notification push. If ack fails, messages stay undelivered and retry next poll. handleSendMessage now checks target PID liveness with process.kill(pid, 0) before inserting — dead peers get immediate error instead of silent queueing. Returns message_id for tracking.
### Impact: At-least-once delivery guarantee. No more silent message loss. Dead peer detection on send. No added latency on happy path. 20 tests pass (52 assertions).
### Related: `de82a12`

## 2026-03-24 - PAL code review fixes
### What: Fixed 2 medium issues identified by PAL codereview (GPT-5.4 Pro)
### Why: Rate limit map grew unbounded (memory leak on long-running broker), log file append was O(n) per write (read entire file, concatenate, rewrite)
### How: Added 60s interval to clean expired rate limit entries. Replaced read-then-write log append with Bun.write append mode. Also fixed /health POST passthrough — now returns health for any HTTP method.
### Impact: Broker can run indefinitely without memory growth. Log file writes are O(1) regardless of file size.
### Related: `e7515e0`

## 2026-03-24 - Broker hardening sprint (cleanup, limits, rate limiting, tests)
### What: Comprehensive broker hardening + test suite + README rewrite
### Why: Backlog from ADD_MORE_2_CC knowledge transfer identified critical gaps: delivered messages never cleaned, no size limits, no rate limiting, zero tests, outdated README.
### How: PAL planner (Gemini 3.1 Pro) designed 2-wave parallel execution plan. Wave 1: broker hardening (message cleanup, 10KB size limit, 60req/min rate limiting) + CLI set-name command. Wave 2: 19-test broker test suite + full README rewrite. TDZ bug discovered and fixed during testing (cleanDeliveredMessages called before prepared statement declared).
### Impact: Broker is now production-hardened. 19 tests pass. README documents all fork features. Backlog HIGH items resolved, most MEDIUM items complete.
### Related: `c54dd1a`, `cca5691`

## 2026-03-24 - session_name feature implemented
### What: Added session_name as first-class field to peer registry
### Why: Claude Code sessions use /rename for human-friendly names, but list_peers only showed opaque 8-char IDs. Peers need to identify each other by name.
### How: New field in Peer/RegisterRequest types, ALTER TABLE migration for existing DBs, /set-name broker endpoint, set_name MCP tool, Name shown first in list_peers output, from_name in channel push meta, [SESSION_NAME] tag in CLI output.
### Impact: Peers can now identify each other by session name. Channel notifications include from_name metadata.
### Related: `6b8ec50`

## 2026-03-24 - Knowledge transfer from ADD_MORE_2_CC session
### What: Full backlog and architectural insights transferred from the session that adopted and configured claude-peers-mcp
### Why: ADD_MORE_2_CC completed initial setup (fork, ZSH wrapper, global CLAUDE.md docs, MCP scoping) and needed to hand off project ownership
### How: Via claude-peers channel messaging (dogfooding the tool itself)
### Impact: Backlog established below

## 2026-03-24 - Message observability improvements
### What: Full message logging to stderr and ~/.claude-peers-messages.log for both inbound and outbound messages
### Why: Channel notification preview in Claude Code UI truncates long messages. User needs to monitor inter-session communications in real time.
### How: Removed 80-char truncation in stderr log, added persistent log file for `tail -f` monitoring, logs both sent and received messages with timestamps and sender names.
### Impact: User can `tail -f ~/.claude-peers-messages.log` for full visibility

---

## Backlog (from ADD_MORE_2_CC knowledge transfer)

### HIGH Priority
| Item | Details | Status |
|------|---------|--------|
| Auto-summary SessionStart hook | Deterministic hook: reads cwd + git branch + TaskMaster state, calls cli.ts set-summary. | OPEN — lives in ~/.claude/hooks, separate task |
| ~~Message table cleanup~~ | ~~Delivered messages never deleted~~ | DONE `c54dd1a` — 7-day cleanup on 60s interval |

### MEDIUM Priority
| Item | Details | Status |
|------|---------|--------|
| ~~CLI set-name command~~ | ~~cli.ts has no set-name subcommand~~ | DONE `c54dd1a` |
| Broker auth | Auto-generated token at ~/.claude-peers-token, Authorization header. | OPEN — needs design for token lifecycle |
| ~~Test suite~~ | ~~Zero tests~~ | DONE `cca5691` — 19 tests in broker.test.ts |
| ~~README.md update~~ | ~~Still upstream's version~~ | DONE `cca5691` — full rewrite, 13 sections |
| ~~Message size limits~~ | ~~No limit on /send-message payload~~ | DONE `c54dd1a` — 10KB max |
| ~~Rate limiting~~ | ~~No rate limiting on any broker endpoint~~ | DONE `c54dd1a` — 60 req/min per IP |
| server.test.ts | MCP server tool handler tests (needs SDK mocking) | OPEN — deferred until broker tests establish patterns |

### LOW Priority
| Item | Details | Source |
|------|---------|--------|
| hcom bridge | Forward claude-peers discovery to hcom event log for unified visibility. | Opus 4.6 |
| Structured message protocol | Add message types (query, response, handoff, broadcast), ACK beyond delivered flag. | ADD_MORE_2_CC |
| Broadcast endpoint | /broadcast for sending to all peers or scoped groups. Currently 1:1 only. | ADD_MORE_2_CC |
| clink dual-bus registration | PAL's clink registers spawned agents with both hcom AND claude-peers. | GLM-5 |

### DEFERRED
| Item | Checkpoint | Exit Criteria |
|------|-----------|---------------|
| Bun-to-UV port evaluation | 2026-04-23 | Port ONLY if: (a) daily multi-session usage, (b) Bun causes friction, (c) team adoption expands. Otherwise accept Bun as permanent. |

### PAL MCP References
- Consensus continuation_id: `27f8435a-f91f-446b-a122-966003ad0f65` (5 models)
- Thinkdeep continuation_id: `0b8f06a3-4ef7-402b-94d7-150e0077f423` (Gemini 3.1 Pro)
- Memory file: `~/.claude/projects/-home-riche--claude/memory/project_claude_peers_setup.md`
