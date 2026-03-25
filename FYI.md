# FYI - claude-peers-mcp Decision Journal

## 2026-03-24 - LAN Federation Phase A: Implementation Complete
### What: Implemented all 13 user stories for LAN federation (manual mode) across 7 commits via 4 waves of parallel subagents
### Why: Enables Claude Code sessions on different machines on the same LAN to discover each other and exchange messages
### How: 4 waves of worktree subagents (2-3 parallel per wave): Wave 1 (types + federation.ts), Wave 2 (broker endpoints + CLI), Wave 3 (peer sync + server.ts), Wave 4 (test suite). Key implementation: federation.ts (155 lines, cert gen + HMAC + subnet), broker.ts (+434 lines, TLS server + endpoints + remote peer map), server.ts (LAN scope + remote routing), cli.ts (federation connect/disconnect/status). Architecture: broker.ts runs federation TLS server in-process; server.ts and cli.ts communicate via HTTP endpoints.
### Impact: 96 tests (21 federation + 75 existing), 290 assertions, all passing. 7 commits on branch `ralph/lan-federation-phase-a`. Ready for PAL codereview and PR.
### Related: `fe21727`, `67494ce`, `0b15f69`, `0c20250`, `7030c59`, `6a6d73f`, `b6a57a4`

## 2026-03-24 - PAL Codereview: Critical process isolation fix
### What: PAL codereview (Gemini 3.1 Pro) caught a critical architecture flaw in the prd.json — server.ts and broker.ts run as SEPARATE PROCESSES
### Why: Bug Fix #2 from PAL consensus incorrectly assumed server.ts and broker.ts run in the same process. In reality, server.ts spawns broker.ts via Bun.spawn() (line 106). They communicate via HTTP only.
### How: The codereview identified that US-011 (send to remote) and US-010 (list peers with LAN scope) cannot use in-process function calls or shared memory. Fixed by: (1) splitting federation endpoints into LAN-facing (PSK auth, for remote agents) and local-facing (bearer auth, for server.ts/cli.ts), (2) server.ts sends to /federation/send-to-remote HTTP endpoint instead of direct function call, (3) broker's /list-peers handles scope='lan' merging internally, (4) CLI commands route through broker endpoints. Also added Ed25519→RSA fallback, sync error handling, and 3 additional tests.
### Impact: Prevented Ralph from building a broken split-brain architecture. 6 PRD fixes applied in commit `1edfe5e`. This validates the PAL codereview workflow — the expert model caught what 4 consensus models missed.
### Related: `1edfe5e`

## 2026-03-24 - PAL Consensus + Local Verification: LAN Federation Architecture Validated
### What: Multi-model consensus (4 frontier models) + 5 local Bun API smoke tests validated the federation architecture and identified PRD refinements
### Why: Research-to-PRD Pipeline Phase 2 — validate architecture with external models before implementation
### How: PAL consensus (frontier preset): Gemini 3.1 Pro (9/10), Claude Opus 4.6 (8/10), GLM-5 (8/10), Claude Sonnet 4.6 (8/10). GPT-5.4 and GPT-5.3 Codex hit OpenAI quota limits. Local smoke tests verified HMAC-SHA256, OpenSSL cert gen (RSA + Ed25519), Bun.serve() TLS, os.networkInterfaces(), WSL2 detection.
### Impact: Architecture confirmed sound (avg 8.25/10). Key decisions and PRD refinements:

**ACCEPTED (unanimous or strong consensus):**
1. **Ed25519 over RSA-2048** for self-signed certs — faster (~1ms vs ~200ms), smaller, modern. Verified locally.
2. **In-process federation** (second Bun.serve()) — correct for dev tool, simplicity wins
3. **In-memory remote peers** — ephemeral state, never persisted to SQLite
4. **Shared PSK for Phase A** + `CLAUDE_PEERS_FEDERATION_PSK` env var override for future separation
5. **Colon separator** for hostname:peer_id — unambiguous (local IDs are alphanumeric)

**PRD BUGS FOUND:**
1. US-A12 auth confusion: Says federation endpoints need "bearer token AND PSK" — should be PSK only for remote, bearer only for localhost
2. FR-5 routing ambiguity: `/federation/send-to-remote` endpoint undefined in US-A12
3. HMAC canonicalization: `Object.keys().sort()` only sorts top-level keys — document this limitation or use recursive sort

**IMPLEMENTATION GOTCHAS:**
1. WSL2 subnet: `os.networkInterfaces()` returns 172.x.x.x (wrong) — use `ip route show default` as primary detection
2. PID liveness check: Must bypass process.kill(pid,0) for remote from_ids
3. Hostname: Normalize to lowercase, truncate >63 chars, reject colons at startup
4. Federation startup: Wrap in try/catch for graceful degradation
5. `fetch()` TLS: `tls: { rejectUnauthorized: false }` verified working in Bun (non-standard but functional)
6. Tailscale interface: /32 routes need special handling in subnet detection

**SKIPPED:**
- Gemini's derived LAN PSK (SHA256(token+"LAN_FEDERATION")) — elegant but adds complexity for minimal gain in trusted LAN scenario. Override env var is simpler.

### Related: PAL continuation_id: `435275f0-6c9c-4add-9992-3d08e68f021b`

## 2026-03-24 - Deep Research: LAN Discovery Prerequisites
### What: Iterative recursive deep research (breadth 4, depth 2) on Bun TLS, WSL2 mDNS, bonjour-service compatibility, self-signed cert generation, and federated broker patterns
### Why: PRD `tasks/prd-lan-discovery.md` explicitly requires deep research before implementation. Key unknowns: Can Bun serve TLS? Will mDNS work on WSL2? Can Bun generate self-signed certs?
### How: 4 parallel Firecrawl searches + 2 DeepWiki codebase analyses (oven-sh/bun) + 3 targeted scrapes + Microsoft WSL docs. 16 unique sources consulted. Key findings: (1) `Bun.serve()` TLS fully sufficient — `tls: { key, cert }` with `Bun.file()`, (2) No built-in cert gen — must shell out to `openssl req -newkey rsa:2048 -noenc ...`, (3) Bun `dgram` fully supports multicast (`addMembership`, `setBroadcast`, `setMulticastTTL`) so `bonjour-service` should work, (4) WSL2 NAT mode blocks multicast entirely, mirrored mode officially supports it but has known bugs (packets visible on Wireshark but not delivered), (5) `dnsTunneling=false` required for .local name resolution in WSL2.
### Impact: **Phase A (manual federation) is confirmed feasible and low-risk.** Phase B (mDNS) is medium-risk on WSL2 — design for graceful degradation. Full report at `.firecrawl/deep-research-lan-discovery.md` (296 lines).
### Related: `9007d28`

## 2026-03-24 - Full backlog implementation (Phases 1-3)
### What: Implemented 4 major features from backlog PRDs + MCP server test suite, coordinated hook implementation via CPM
### Why: User requested full backlog execution using the Backlog-to-Ralph Pipeline pattern
### How: Parallel worktree subagents for Phase 1 (auto-summary CLI + broker auth), sequential for Phase 2 (structured messages), Phase 3 (server tests). Hook routed to CLAUDE_GLOBAL_SESH via CPM for ~/.claude/ implementation. Key decisions: (1) auto-summary hook uses cwd-based peer matching, not PID (PRD open question resolved by CLAUDE_GLOBAL_SESH), (2) server tests use MCP Client over stdio for full-stack testing, (3) LAN discovery deferred — needs deep research on Bun TLS + WSL2 mDNS.
### Impact: 75 tests (40 broker + 17 CLI + 18 server), 205 assertions, all passing. 6 new files, 5 major features shipped. Only LAN discovery (Phase 4) remains — requires deep research before implementation.
### Related: `8d52439`, `57ee55a`, `133d09e`, `67baf9f`

## 2026-03-24 - Structured Message Protocol + Broadcast
### What: Added typed messages (text/query/response/handoff/broadcast), JSON metadata, reply_to threading, and /broadcast endpoint
### Why: Messages were untyped plain text, 1:1 only. Peers need semantic routing (query vs handoff vs broadcast) and group communication.
### How: Schema migration (3 ALTER TABLE for type/metadata/reply_to columns), handleSendMessage validates type+metadata+reply_to, handleBroadcast uses handleListPeers for scope filtering with transactional multi-insert, MCP tools updated (send_message gains 3 optional params, new broadcast_message tool), channel notifications include type/metadata/reply_to in meta, check_messages formats with type prefixes. 15 new tests (7 structured + 8 broadcast). All 40 broker tests pass.
### Impact: Peers can now send typed messages with structured payloads, thread conversations via reply_to, and broadcast to all peers in a scope. Fully backward compatible — existing callers without new fields work identically.
### Related: `133d09e`

## 2026-03-24 - Backlog-to-Ralph Pipeline: 6 PRDs + 5 prd.json created
### What: Converted entire project backlog into Ralph-compatible PRDs using the Backlog-to-Ralph Pipeline workflow
### Why: User wanted all backlog items addressed systematically with autonomous execution capability via Ralph
### How: PAL Planner (Grok 4.20 + Gemini 3.1 Pro) analyzed backlog → tiered items (Ralph vs direct subagent) → mapped dependency graph → phased PRD creation via parallel subagents → Ralph prd.json conversion. Key decisions: (1) bundled structured messages + broadcast into one PRD (broadcast IS a message type), (2) deferred server.test.ts until after auth + structured messages to avoid testing moving API, (3) split auto-summary into CLI (this repo) + hook (~/.claude/) due to cross-directory concern, (4) LAN discovery converted Phase A only (manual federation), (5) hcom bridge + clink dual-bus too small for Ralph → direct subagent tasks.
### Impact: 6 PRDs (2170+ lines total), 5 Ralph prd.json files (45 stories total), ready for phased autonomous execution. Workflow pattern documented and integrated into research-methodologies skill by ADD_MORE_2_CC session.
### Related: `8f344b9` through `4b885be` (11 commits). PAL continuation_id: `0c4aa37b-6f43-4e16-bb9a-88265ae318a5`

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
| ~~Auto-summary SessionStart hook~~ | ~~Deterministic hook: reads cwd + git branch + TaskMaster state, calls cli.ts set-summary.~~ | DONE `57ee55a` (CLI) + `b4e388c` (hook in ~/.claude/) |
| ~~Message table cleanup~~ | ~~Delivered messages never deleted~~ | DONE `c54dd1a` — 7-day cleanup on 60s interval |

### MEDIUM Priority
| Item | Details | Status |
|------|---------|--------|
| ~~CLI set-name command~~ | ~~cli.ts has no set-name subcommand~~ | DONE `c54dd1a` |
| ~~Broker auth~~ | ~~Auto-generated token at ~/.claude-peers-token, Authorization header.~~ | DONE `8d52439` — token gen, auth middleware, rotation, SIGHUP re-read |
| ~~Test suite~~ | ~~Zero tests~~ | DONE `cca5691` — 19 tests in broker.test.ts |
| ~~README.md update~~ | ~~Still upstream's version~~ | DONE `cca5691` — full rewrite, 13 sections |
| ~~Message size limits~~ | ~~No limit on /send-message payload~~ | DONE `c54dd1a` — 10KB max |
| ~~Rate limiting~~ | ~~No rate limiting on any broker endpoint~~ | DONE `c54dd1a` — 60 req/min per IP |
| ~~server.test.ts~~ | ~~MCP server tool handler tests (needs SDK mocking)~~ | DONE `67baf9f` — 18 tests via MCP Client over stdio |

### LOW Priority
| Item | Details | Source |
|------|---------|--------|
| hcom bridge | Forward claude-peers discovery to hcom event log for unified visibility. | Opus 4.6 |
| ~~Structured message protocol~~ | ~~Add message types (query, response, handoff, broadcast), ACK beyond delivered flag.~~ | DONE `133d09e` |
| ~~Broadcast endpoint~~ | ~~/broadcast for sending to all peers or scoped groups. Currently 1:1 only.~~ | DONE `133d09e` |
| clink dual-bus registration | PAL's clink registers spawned agents with both hcom AND claude-peers. | GLM-5 |

### DEFERRED
| Item | Checkpoint | Exit Criteria |
|------|-----------|---------------|
| Bun-to-UV port evaluation | 2026-04-23 | Port ONLY if: (a) daily multi-session usage, (b) Bun causes friction, (c) team adoption expands. Otherwise accept Bun as permanent. |

### PAL MCP References
- Consensus continuation_id: `27f8435a-f91f-446b-a122-966003ad0f65` (5 models)
- Thinkdeep continuation_id: `0b8f06a3-4ef7-402b-94d7-150e0077f423` (Gemini 3.1 Pro)
- Memory file: `~/.claude/projects/-home-riche--claude/memory/project_claude_peers_setup.md`
