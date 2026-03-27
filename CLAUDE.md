# claude-peers-mcp

Peer discovery and messaging MCP for Claude Code instances. Supports LAN federation for cross-machine collaboration.

## Project Structure

```
src/                    # Source code
  broker.ts             # Broker state, timers, server lifecycle, SIGHUP hot-reload (524 lines)
  broker-handlers.ts    # Request handlers in factory closures — hot-reloadable (720 lines)
  server.ts             # MCP stdio server (one per Claude Code instance) + channel push + simple push-ack
  cli.ts                # CLI utility (federation init/join/doctor/refresh-wsl2)
  federation.ts         # TLS cert gen, HMAC signing, subnet utils, curl-based TLS fetch
  mdns.ts               # mDNS auto-discovery via bonjour-service
  index.ts              # Entry point
  shared/
    types.ts            # All TypeScript interfaces + BrokerContext/BrokerStatements
    token.ts            # Shared token file reader for auth
    summarize.ts        # Deterministic git-based auto-summary (no external APIs)
    config.ts           # Config file reader/writer (~/.claude-peers-config.json)
tests/                  # Test suites (104 tests, 318 assertions)
  broker.test.ts        # Broker + federation endpoint tests (43 tests)
  cli.test.ts           # CLI + auto-summary tests (17 tests)
  server.test.ts        # MCP server integration tests (18 tests)
  federation.test.ts    # Federation TLS/PSK/HMAC/subnet tests (22 tests)
docs/                   # Documentation
  TROUBLESHOOTING.md    # Diagnostic guide
cpm-logs/               # Runtime logs (gitignored)
tasks/                  # PRDs and project planning files
```

## Architecture

- **broker.ts** and **server.ts** are **SEPARATE PROCESSES**. server.ts spawns broker.ts via `Bun.spawn()`. They communicate via HTTP to localhost:7899.
- The **federation TLS server** runs **in-process** with broker.ts (second `Bun.serve()` on port 7900). So broker.ts CAN access federation state directly, but server.ts and cli.ts CANNOT — they use HTTP endpoints.
- **LAN-facing** federation endpoints use PSK auth (`X-Claude-Peers-PSK` header)
- **Local-facing** endpoints (server.ts, cli.ts) use bearer token auth (`Authorization: Bearer`)

## CRITICAL: Broker Reload After Code Changes

**The broker is a long-running daemon.** Unlike server.ts (restarted by `/mcp`), the broker process persists across MCP reconnects. Code changes to these files require a broker reload to take effect:

| File Changed | Broker Reload Required? | Why |
|---|---|---|
| `src/broker-handlers.ts` | **YES** — SIGHUP hot-reload | Handler code runs in the broker process |
| `src/broker.ts` | **YES** — full restart | State/lifecycle code, SIGHUP won't pick up changes here |
| `src/server.ts` | No — `/mcp` reconnect is enough | Runs in MCP server process, not broker |
| `src/shared/types.ts` | **YES if broker types changed** | Interfaces used by both processes |
| `src/cli.ts` | No | CLI runs as one-shot commands |

**How to reload:**
```bash
# Hot-reload (preserves connections, swaps handler code only):
kill -HUP $(lsof -ti :7899)
# Or: bun src/cli.ts reload-broker

# Full restart (drops connections, reloads everything):
bun src/cli.ts kill-broker
# Broker auto-restarts on next /mcp reconnect
```

**After committing changes to broker-handlers.ts or broker.ts, ALWAYS reload the live broker.** Do not wait for the user to report that changes aren't working. This has caused repeated issues.

### Which sessions need restart?

Changes propagate differently depending on which process runs the code:

| Change Type | Broker Action | Session Action | Other sessions affected? |
|---|---|---|---|
| `broker-handlers.ts` only | SIGHUP (`kill -HUP`) | Nothing — takes effect immediately for all | Yes — all sessions use the same broker |
| `broker.ts` (state/lifecycle) | Kill + let auto-restart | `/mcp` on one session to trigger respawn | Yes — all sessions use the same broker |
| `server.ts` only | Nothing | `/mcp` on each session you want updated | No — each session runs its own server.ts |
| Both broker + server | SIGHUP the broker, then `/mcp` | `/mcp` on sessions you want updated | Broker changes affect all; server.ts changes only affect reconnected sessions |

**You do NOT need to restart all sessions.** Sessions that don't `/mcp` reconnect will still work — they just won't get new server.ts features until they reconnect. Broker changes (SIGHUP or restart) affect all sessions immediately.

### Post-commit checklist

After committing changes, run these steps in order:
```bash
# 1. If broker-handlers.ts changed — hot-reload:
kill -HUP $(lsof -ti :7899)

# 2. If broker.ts changed — full restart:
bun src/cli.ts kill-broker
# Then /mcp in any session to trigger auto-respawn

# 3. If server.ts changed — reconnect target sessions:
# User runs /mcp in each session that needs the update
# (or restart all 3 if it's a team like CPM_SESH + workers)
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_peers(scope)` | Discover peers. Scope: machine/directory/repo/lan |
| `send_message(to_id, text, type?, metadata?, reply_to?)` | Send message to peer. Remote peers use `hostname:peer_id` format. Tracks delivery. |
| `broadcast_message(message, scope)` | Send to all peers in scope (machine/directory/repo/lan) |
| `set_name(name)` | Set session name (from /rename). Auto-regenerates summary with name + TTY prefix. |
| `set_summary(summary)` | Set work summary visible to peers. Update frequently with specific task descriptions. |
| `check_messages()` | Poll broker for undelivered messages. Reliable fallback when channel push isn't working. |
| `message_status(message_id)` | Check delivery status of a previously sent message |
| `channel_health()` | Diagnose messaging health: broker status, pending messages, dedup state |

## Running

```bash
# ZSH wrapper auto-includes --dangerously-load-development-channels flag.
claude

# CLI:
bun src/cli.ts status              # broker status + all peers
bun src/cli.ts peers               # list peers
bun src/cli.ts send <id> <msg>     # send message
bun src/cli.ts reload-broker       # hot-reload broker config (SIGHUP)
bun src/cli.ts kill-broker         # stop broker daemon
bun src/cli.ts federation init     # one-command federation setup
bun src/cli.ts federation join <cpt-url>  # join via connection URL
bun src/cli.ts federation token    # generate join URL
bun src/cli.ts federation doctor   # diagnose federation health
bun src/cli.ts federation status   # federation state
bun src/cli.ts federation connect <host>:<port>  # connect to remote
bun src/cli.ts federation refresh-wsl2  # update WSL2 port forwarding
```

## Observability

Logs in `cpm-logs/` (gitignored): `messages.log`, `broker.log`, `server.log`, `federation.log`
- Monitor: `tail -f cpm-logs/*.log`
- CLI: `bun src/cli.ts status`

## Bun

Default to Bun, not Node.js.
- `Bun.serve()` for HTTP, `bun:sqlite` for SQLite, `Bun.file` for file I/O
- `bun test` for tests, `bun install` for deps
- Bun auto-loads .env — don't use dotenv

## Testing

```bash
bun test                           # All 104 tests, 318 assertions
bun test tests/broker.test.ts      # Broker + federation endpoints (43)
bun test tests/server.test.ts      # MCP server integration (18)
bun test tests/federation.test.ts  # Federation TLS/PSK/HMAC (22)
bun test tests/cli.test.ts         # CLI + auto-summary (17)
```

## Key Files

| File | Purpose |
|------|---------|
| `CHANGELOG.md` | Version history |
| `CLAUDE.md` | This file — project instructions |
| `src/broker.ts` | Broker state, db, timers, server lifecycle, SIGHUP hot-reload (524 lines) |
| `src/broker-handlers.ts` | Request handler factories — `createBrokerFetch(ctx)` + `createFederationFetch(ctx)` (720 lines) |
| `src/server.ts` | MCP server + three-layer delivery (push/piggyback/safety-net) + auto-reconnect + session name persistence |
| `src/cli.ts` | CLI: init, join, token, doctor, refresh-wsl2, connect, status |
| `src/mdns.ts` | mDNS auto-discovery via bonjour-service |
| `src/federation.ts` | TLS cert gen, HMAC, subnet, curl fetch, WSL2 detection |
| `src/shared/types.ts` | All TypeScript interfaces + BrokerContext/BrokerStatements |
| `src/shared/config.ts` | Config file reader/writer with remotes/mdns support |
| `src/shared/summarize.ts` | Git-based auto-summary with session name support |

## Known Issues

- **Bun 1.3.x fetch() + self-signed TLS**: `tls: { rejectUnauthorized: false }` doesn't work. Federation uses `curl -sk` subprocess workaround via `federationFetch()`.
- **Channel notifications silently dropped by Claude Code**: `mcp.notification()` succeeds but Claude Code may not render the notification (~30-50% of the time). This is a Claude Code platform limitation — `mcp.notification()` is fire-and-forget per JSON-RPC 2.0 spec. **Mitigated in v0.6.0** with three-layer delivery: channel push (instant) → piggyback on next tool call (reliable) → safety-net polling every 30s (fallback). Most messages now arrive within seconds even when channel push fails. See `docs/TROUBLESHOOTING.md`.
- **Channel notifications after /mcp reconnect**: `/mcp` reconnect restores tool access but may not re-establish channel subscriptions. Full session restart required for channel push. Piggyback and safety-net layers still work regardless.
- **WSL2 mDNS**: mDNS auto-discovery does not work on WSL2 NAT mode (multicast blocked by Hyper-V). Use `federation init` + `federation join` instead. Mirrored mode may work but is unreliable.
- **Channel push verification is heuristic**: `channel_push: "working"` means a tool call occurred within 10s of startup — it proves session activity, not notification delivery. Treat as best-effort signal.

## Deferred Optimizations

- **Config file atomicity**: `addRemoteToConfig`/`removeRemoteFromConfig` do read-modify-write without file locking. Concurrent CLI + broker writes could clobber. Acceptable for single-user use.
