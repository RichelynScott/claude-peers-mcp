# HANDOFF -- claude-peers-mcp

Last updated: 2026-03-26

---

## PROJECT STATUS

- **Version**: 0.3.0 (public on GitHub as RichelynScott/claude-peers-mcp)
- **Branch**: `main` (clean, up to date with `origin/main`)
- **Tests**: 100 tests, 302 assertions, all passing (`bun test`)
- **LAN federation**: Live and battle-tested between WSL2 (darth-pc) and macOS (rafaels-macbook-pro)
- **Repo structure**: Organized into `src/`, `tests/`, `docs/` -- restructure is complete
- **OpenAI dependency**: Removed -- auto-summary is now deterministic git-based (no external APIs)
- **License**: MIT
- **Fork of**: louislva/claude-peers-mcp (upstream remote configured, monthly sync policy)

---

## ARCHITECTURE (CRITICAL -- READ THIS FIRST)

### Process Model

**broker.ts and server.ts are SEPARATE PROCESSES.** This is the single most important architectural fact.

```
Claude Code Session A          Claude Code Session B
    |                              |
    v                              v
[MCP Server A]                [MCP Server B]       <-- stdio, one per session
(src/server.ts)               (src/server.ts)
    |                              |
    +--- HTTP to localhost:7899 ---+
                  |
         [Broker Daemon]                            <-- singleton, one per machine
         (src/broker.ts)
         HTTP on 127.0.0.1:7899
         TLS on 0.0.0.0:7900  <-- Federation
         SQLite: ~/.claude-peers.db
```

- **server.ts** spawns **broker.ts** via `Bun.spawn()` if not already running. They communicate via HTTP.
- The **federation TLS server** runs **in-process** with broker.ts (second `Bun.serve()` on port 7900). So broker.ts CAN access federation state directly, but server.ts and cli.ts CANNOT -- they use HTTP endpoints.
- **LAN-facing** federation endpoints use PSK auth (`X-Claude-Peers-PSK` header)
- **Local-facing** endpoints (server.ts, cli.ts to broker.ts) use bearer token auth (`Authorization: Bearer`)
- **Channel push**: server.ts pushes messages to Claude Code via `notifications/claude/channel`. Requires `--dangerously-load-development-channels server:claude-peers` flag (auto-added by ZSH wrapper in `~/.zshrc`).

### Data Flow

1. Session starts -> MCP server (server.ts) spawns broker if needed -> registers via `POST /register`
2. MCP server polls `POST /poll-messages` every 1 second
3. On new messages: MCP server pushes via channel notification, then acks via `POST /ack-messages`
4. Two-phase delivery: messages stay undelivered until ack succeeds (at-least-once guarantee)
5. Heartbeat every 15 seconds from MCP server to broker
6. Broker cleans stale peers (dead PID) every 30 seconds, delivered messages after 7 days

### Federation Data Flow

1. User runs `bun src/cli.ts federation connect <ip>:7900`
2. CLI sends `POST /federation/connect` to local broker
3. Broker does TLS handshake to remote broker with PSK + HMAC-signed body
4. Remote broker validates PSK, subnet, HMAC -> accepts handshake
5. Both brokers periodically sync peer lists (every 30 seconds)
6. Cross-machine messages relayed: local broker -> TLS POST to remote broker -> remote broker delivers locally
7. Remote peer IDs use `hostname:peer_id` format (colon separator)

---

## KEY FILES

### Source Code (`src/`)

| File | Lines | Purpose |
|------|-------|---------|
| `src/broker.ts` | ~950 | Singleton HTTP daemon on :7899 + SQLite state + federation TLS on :7900. All routing logic. |
| `src/server.ts` | ~770 | MCP stdio server. One per Claude session. Spawns broker, registers, polls, pushes channel notifications. |
| `src/cli.ts` | ~850 | CLI utility. Status, peers, send, broadcast, federation commands, setup wizard. |
| `src/federation.ts` | ~230 | TLS cert gen (RSA-2048), HMAC-SHA256 signing, subnet validation, curl-based TLS fetch (Bun workaround). |
| `src/index.ts` | ~10 | Package entry point (re-exports). |
| `src/shared/types.ts` | ~120 | All TypeScript interfaces: Peer, Message, federation types, API request/response types. |
| `src/shared/token.ts` | ~25 | Shared bearer token file reader (`~/.claude-peers-token`). |
| `src/shared/config.ts` | ~50 | Persistent config file reader/writer (`~/.claude-peers-config.json`). |
| `src/shared/summarize.ts` | ~107 | Deterministic git-based auto-summary (branch + recent files). No external APIs. |

### Tests (`tests/`)

| File | Tests | Purpose |
|------|-------|---------|
| `tests/broker.test.ts` | 43 | Broker HTTP API + federation endpoints. Uses test broker on port 17899. |
| `tests/server.test.ts` | 18 | MCP server integration via `@modelcontextprotocol/sdk` Client over stdio. |
| `tests/federation.test.ts` | 22 | TLS cert gen, HMAC signing/verification, subnet validation, hostname normalization. |
| `tests/cli.test.ts` | 17 | CLI commands + auto-summary generation. |

### Documentation

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project instructions for Claude Code sessions (runtime, conventions, architecture). |
| `CHANGELOG.md` | Version history in Keep a Changelog format. |
| `README.md` | Public-facing docs (310 lines, 13 sections). |
| `docs/TROUBLESHOOTING.md` | Diagnostic guide, common issues, restart checklist. |
| `HANDOFF.md` | This file. Gitignored -- local-only session context. |

### Config and Meta

| File | Purpose |
|------|---------|
| `package.json` | v0.3.0, bun runtime, `@modelcontextprotocol/sdk` dependency. |
| `.mcp.json` | Project-local MCP config (relative path: `./src/server.ts`). |
| `.gitignore` | Ignores: cpm-logs/, .claude/, archive/, tasks/, FYI.md, HANDOFF.md, logs/. |
| `LICENSE` | MIT license. |
| `tsconfig.json` | TypeScript config. |

---

## CONFIGURATION FILES (ALL LOCATIONS)

### MCP Server Registration

The MCP server is registered in THREE places (any can override):

| File | Path | Scope | Notes |
|------|------|-------|-------|
| `~/.claude.json` | `mcpServers.claude-peers` | Global (all sessions, all dirs) | Absolute path: `/home/riche/MCPs/claude-peers-mcp/src/server.ts` |
| `~/.claude/.mcp.json` | `mcpServers.claude-peers` | Sessions in `~/.claude/` dir | Same absolute path |
| `<project>/.mcp.json` | `mcpServers.claude-peers` | Project-local | Relative path: `./src/server.ts` |

**Important**: Project-level `.mcp.json` overrides global. If you change paths, update ALL config files. Claude Code caches MCP config in memory -- `/mcp` reconnect uses the CACHED path, not the file on disk. Must `/exit` and relaunch to pick up path changes.

### Runtime Configuration

| File | Purpose |
|------|---------|
| `~/.claude-peers-token` | Bearer auth token (auto-generated, 64-char hex). Shared across all local components AND copied to remote machines for federation PSK. |
| `~/.claude-peers-config.json` | Persistent federation config (`{ federation: { enabled, port, subnet } }`). Created by setup wizard. Env vars override these values. |
| `~/.claude-peers.db` | SQLite database (peers table + messages table). WAL mode. |
| `~/.claude-peers-federation.crt` | Self-signed TLS cert (RSA-2048, 365-day validity). Auto-generated on first federation start. |
| `~/.claude-peers-federation.key` | TLS private key (mode 0600). Auto-generated alongside cert. |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PEERS_PORT` | `7899` | Broker HTTP port |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database path |
| `CLAUDE_PEERS_TOKEN` | `~/.claude-peers-token` | Auth token file path |
| `CLAUDE_PEERS_FEDERATION_ENABLED` | `false` | Enable LAN federation |
| `CLAUDE_PEERS_FEDERATION_PORT` | `7900` | Federation TLS port |
| `CLAUDE_PEERS_FEDERATION_SUBNET` | auto-detected | Allowed CIDR range. WSL2 defaults to `0.0.0.0/0` because NAT range != LAN range. |
| `CLAUDE_PEERS_FEDERATION_CERT` | `~/.claude-peers-federation.crt` | TLS cert path |
| `CLAUDE_PEERS_FEDERATION_KEY` | `~/.claude-peers-federation.key` | TLS key path |

### ZSH Wrapper (Channel Push)

In `~/.zshrc`:
```bash
claude() {
    command claude --dangerously-load-development-channels server:claude-peers "$@"
}
```
This auto-enables channel push so incoming peer messages appear as live interrupts in Claude Code sessions. Without it, messages are consumed by the MCP server before Claude sees them.

---

## MCP TOOLS

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_peers` | `scope`: machine/directory/repo/lan | Discover other sessions. Returns ID, name, PID, cwd, git_root, summary, timestamps. |
| `send_message` | `to_id`, `text`, `type?`, `metadata?`, `reply_to?` | Send to a peer. Remote peers: `hostname:peer_id`. Types: text/query/response/handoff/broadcast. |
| `broadcast_message` | `message`, `scope` | Send to all peers in scope (machine/directory/repo/lan). |
| `set_name` | `name` | Set session name visible to peers (call after `/rename`). |
| `set_summary` | `summary` | Set work summary. Convention: `[SessionName] description`. |
| `check_messages` | (none) | Diagnostic only -- without channel push, MCP server auto-consumes messages before Claude sees them. |

---

## KNOWN ISSUES AND WORKAROUNDS

### Active Issues

1. **Bun 1.3.x fetch() + self-signed TLS**: `tls: { rejectUnauthorized: false }` does not work in Bun. Federation uses `curl -sk` subprocess workaround via `federationFetch()` in `src/federation.ts`. Monitor Bun releases for a fix.

2. **Channel push after `/mcp` reconnect**: `/mcp` restores tool access but may not re-establish channel subscriptions. Full `/exit` + session restart required for channel push to work again.

3. **MCP startup under load (6+ sessions)**: New sessions sometimes fail to connect because broker is busy with heartbeats/polls from existing peers. Works on retry. Potential fixes: retry logic in server init, increase startup timeout, prioritize `/register` requests.

4. **Sonnet 4.6 channel push**: Sonnet 4.6 sessions did not always display `<channel>` push notifications. Fixed by full session restart with ZSH wrapper active. Root cause unclear -- possibly model behavior difference.

5. **WSL2 subnet auto-detection**: Always defaults to `0.0.0.0/0` because WSL2 NAT range (172.x.x.x) is not the LAN. Security relies on PSK auth + TLS instead of subnet filtering.

### Resolved Issues (Historical Context)

- **Zombie MCP servers**: Fixed in v0.3.0 with parent death detection + TTY-based eviction. `bun src/cli.ts restart` for manual cleanup.
- **Murder-suicide loop**: Stale MCP detection via `pgrep` was killing the detector itself. Removed pgrep approach. (`74c9216`, `79db726`)
- **Ed25519 TLS + macOS LibreSSL**: Handshake failures. Fixed by defaulting to RSA-2048. (`4ea0036`)
- **HMAC nested object stripping**: `JSON.stringify` replacer array strips nested keys. Fixed with manual sorted-key object construction. (`ee4a330`)
- **Channel notification null values**: Claude Code silently drops notifications with null fields. Fixed by omitting nulls entirely. (`eb4c72b`)
- **stdin listener killing server**: Removed stdin close handler that was terminating server.ts on startup. (`d373be7`)

---

## GIT STATE

### Branches

| Branch | Status | Description |
|--------|--------|-------------|
| `main` | Active, clean | Current working branch. All federation work merged. |
| `ralph/lan-federation-phase-a` | Merged | Phase A implementation branch. 35+ commits. Keep for reference. |

### Remotes

| Remote | URL |
|--------|-----|
| `origin` | `https://github.com/RichelynScott/claude-peers-mcp.git` |
| `upstream` | `https://github.com/louislva/claude-peers-mcp.git` |

Upstream sync policy: Monthly `git fetch upstream`, cherry-pick selectively. Upstream has open PRs to watch.

### Worktrees

There are 4 agent worktrees in `.claude/worktrees/` from previous subagent runs. These contain stale copies of tasks/ PRDs and can be cleaned up with `git worktree remove`.

---

## COMPLETED WORK (FULL HISTORY)

### v0.1.0 (2026-03-24) -- Initial Fork

- Forked from louislva/claude-peers-mcp
- Added `session_name` as first-class field with schema migration
- `set_name` MCP tool for human-friendly session names
- `from_name` metadata in channel push
- `[SESSION_NAME]` tags in CLI output
- Full message logging (stderr + file, O(1) append)

### v0.2.0 (2026-03-24) -- Hardening Sprint

- Bearer token auth on all broker POST endpoints (auto-generated at `~/.claude-peers-token`)
- Token rotation via SIGHUP + periodic re-read (60s)
- Structured message protocol (types: text/query/response/handoff/broadcast, metadata, reply_to, threading)
- Broadcast endpoint + `broadcast_message` MCP tool
- Two-phase message delivery (poll + ack) for at-least-once guarantee
- PID liveness check on send (dead peers get immediate error)
- Message ID returned on send
- Message cleanup (7-day TTL on delivered), rate limiting (60 req/min), message size limit (10KB)
- Deterministic git-based auto-summary (replaced OpenAI gpt-5.4-nano dependency)
- MCP server integration test suite (18 tests via MCP Client over stdio)
- Broker test suite (40 tests, 205 assertions)
- CLI + auto-summary test suite (17 tests)
- Centralized `cpm-logs/` directory
- README rewrite (13 sections)
- TROUBLESHOOTING.md

### v0.3.0 (2026-03-25) -- Federation + Public Release

- **LAN Federation Phase A**: Manual cross-machine peer discovery via `connect <ip>`
  - TLS encrypted transport with self-signed RSA-2048 certificates
  - PSK authentication for all federation endpoints
  - HMAC-SHA256 message signing for relay requests
  - Configurable CIDR subnet filtering
  - Federation CLI: connect, disconnect, status, guided setup wizard
  - Cross-machine `list_peers(scope="lan")` and `send_message` to `hostname:peer_id`
  - LAN broadcast with `broadcast_message(scope="lan")`
  - Persistent config file (`~/.claude-peers-config.json`)
  - 22 federation-specific tests
- **Zombie MCP server prevention**: Parent death detection + TTY-based eviction
- **Repo restructure**: src/, tests/, docs/ organization
- **OpenAI dependency removed**: Deterministic git-based summary only
- **Security fixes**: IP spoofing (use `server.requestIP()`), HMAC canonicalization, Bun TLS workaround (curl)
- **Public release**: GitHub at RichelynScott/claude-peers-mcp, MIT license
- Battle-tested: WSL2 (darth-pc) <-> macOS (rafaels-macbook-pro) federation working

---

## IMMEDIATE NEXT ACTIONS (PRIORITIZED)

### Priority 1: Setup Simplification (High -- for public adoption)

Federation setup requires too many manual steps (env vars, token copying, broker restart, port forwarding, bidirectional connect). Improvements:
1. Make `~/.claude-peers-config.json` the ONLY config method (already implemented, but env vars still needed for enable)
2. Auto-reconnect on broker startup (remember last connected remotes in config file)
3. Token sharing via QR code or secure exchange protocol
4. One-command setup that handles everything

### Priority 2: MCP Server Startup Reliability (Medium)

6+ sessions cause connection failures on new session startup. Options:
1. Add retry logic with exponential backoff to MCP server initialization
2. Increase broker startup timeout from 6 to 15 seconds
3. Prioritize `/register` requests in broker over heartbeat/poll traffic
4. Connection pooling or request queuing in broker

### Priority 3: Phase B -- mDNS Auto-Discovery (Low)

Auto-discover federation peers via mDNS/Bonjour instead of manual IP connect. Research complete:
- Works on macOS/native Linux, unreliable on WSL2 mirrored mode
- Graceful degradation designed (fall back to manual connect on WSL2)

### Priority 4: Phase C -- WSL2 Documentation + Detection (Low)

Partially done. Federation setup wizard handles WSL2 port forwarding. Remaining:
- Auto-detection of WSL2 with inline guidance
- Port forwarding automation improvements
- More comprehensive WSL2-specific docs

### Priority 5: Rafi Channel Push Investigation (Low)

Sonnet 4.6 sessions did not display channel push notifications. Fixed by full restart with ZSH wrapper. Root cause unclear -- low priority since workaround exists.

---

## CRITICAL BEHAVIOR RULES

1. **Bun runtime**: Use `bun`, not `node` or `ts-node`. Use `Bun.serve()`, `bun:sqlite`, `Bun.file`, `bun test`.
2. **broker.ts and server.ts are SEPARATE PROCESSES**: They communicate via HTTP. server.ts spawns broker.ts via `Bun.spawn()`. Never import broker functions into server.ts.
3. **Never commit secrets**: No tokens, PSKs, or keys. `~/.claude-peers-token` is the auth source.
4. **Archive, don't delete**: Move files to `archive/` instead of `rm`. Git-stage both the deletion and the archive add.
5. **Tests must pass before committing**: `bun test` (100 tests, 302 assertions).
6. **Federation uses curl**: `federationFetch()` uses `curl -sk` subprocess because Bun's `fetch()` does not properly support `tls: { rejectUnauthorized: false }` for self-signed certs.
7. **Channel push requires ZSH wrapper**: The `--dangerously-load-development-channels server:claude-peers` flag must be active or messages are invisible to Claude.
8. **MCP config caching**: Claude Code caches MCP config in memory. Path changes require full `/exit` + relaunch, not just `/mcp`.
9. **Test broker uses port 17899**: Test suites spin up their own broker on a different port with a temp DB to avoid interfering with production.
10. **Commit style**: `type(scope): description` (e.g., `feat(federation):`, `fix(server):`, `docs:`, `test:`, `chore:`).

---

## TESTING

```bash
bun test                           # All 100 tests
bun test tests/broker.test.ts      # Broker + federation endpoints (43)
bun test tests/server.test.ts      # MCP server integration (18)
bun test tests/federation.test.ts  # TLS/PSK/HMAC/subnet (22)
bun test tests/cli.test.ts         # CLI + auto-summary (17)
```

If tests fail after code changes:
```bash
lsof -ti :17899 | xargs kill -9 2>/dev/null   # Kill leftover test broker
rm -f /tmp/claude-peers-test.db                 # Clean temp DB
bun test                                        # Re-run
```

---

## CLI QUICK REFERENCE

```bash
bun src/cli.ts status                          # Broker health + peer list
bun src/cli.ts peers                           # Compact peer list
bun src/cli.ts send <id> <message>             # Send message to peer
bun src/cli.ts broadcast <scope> <message>     # Broadcast to scope
bun src/cli.ts set-name <id> <name>            # Set peer name
bun src/cli.ts restart                         # Kill broker + all MCP servers
bun src/cli.ts kill-broker                     # Stop broker only
bun src/cli.ts federation setup                # Guided setup wizard
bun src/cli.ts federation connect <ip>:7900    # Connect to remote
bun src/cli.ts federation disconnect <ip>:7900 # Disconnect from remote
bun src/cli.ts federation status               # Show federation state
```

---

## SQLITE DIRECT ACCESS

```bash
sqlite3 ~/.claude-peers.db
.tables                                          # peers, messages
SELECT * FROM peers;                             # All registered peers
SELECT * FROM messages WHERE delivered = 0;      # Pending messages
SELECT * FROM messages ORDER BY sent_at DESC LIMIT 10;  # Recent messages
```

---

## DEPENDENCIES

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.27.1 | MCP protocol implementation (Server, StdioServerTransport, schemas) |
| `bun` | 1.x+ | Runtime (HTTP server, SQLite, file I/O, process spawning, test runner) |
| `typescript` | ^5 | Type checking (devDependency) |
| `@types/bun` | latest | Bun type definitions (devDependency) |

No other dependencies. No Express, no better-sqlite3, no dotenv, no ws, no OpenAI.

---

## OBSERVABILITY

Logs in `cpm-logs/` (gitignored):

| File | Contents |
|------|----------|
| `cpm-logs/messages.log` | All sent/received messages with timestamps and sender names |
| `cpm-logs/broker.log` | Broker lifecycle: startup, cleanup, errors |
| `cpm-logs/server.log` | MCP server: registration, polling, errors |
| `cpm-logs/federation.log` | Federation: TLS, handshakes, peer sync, relay |

```bash
tail -f cpm-logs/*.log    # Watch everything
```

---

## USER CONTEXT

- **Owner**: Riche (WSL2 Ubuntu on Windows 11 Pro, hostname: darth-pc)
- **Collaborator**: Rafi (macOS, hostname: rafaels-macbook-pro)
- **Use case**: Multi-session Claude Code collaboration (same machine) + cross-machine federation (LAN)
- **Power usage**: 6+ concurrent Claude Code sessions is common
- **PAL MCP**: Available for code review, debug, consensus, thinkdeep
- **hcom**: Complementary tool for cross-tool agent coordination (Gemini, Codex)
