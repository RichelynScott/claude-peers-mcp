# claude-peers-mcp

Peer discovery and messaging MCP for Claude Code instances. Supports LAN federation for cross-machine collaboration.

## Project Structure

```
src/                    # Source code
  broker.ts             # Singleton HTTP daemon (localhost:7899) + SQLite + federation TLS server
  server.ts             # MCP stdio server (one per Claude Code instance) + channel push + deferred ack
  cli.ts                # CLI utility (federation init/join/doctor/refresh-wsl2)
  federation.ts         # TLS cert gen, HMAC signing, subnet utils, curl-based TLS fetch
  mdns.ts               # mDNS auto-discovery via bonjour-service
  index.ts              # Entry point
  shared/
    types.ts            # All TypeScript interfaces
    token.ts            # Shared token file reader for auth
    summarize.ts        # Deterministic git-based auto-summary (no external APIs)
    config.ts           # Config file reader/writer (~/.claude-peers-config.json)
tests/                  # Test suites (100 tests, 308 assertions)
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

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_peers(scope)` | Discover peers. Scope: machine/directory/repo/lan |
| `send_message(to_id, text, type?, metadata?, reply_to?)` | Send message to peer. Remote peers use `hostname:peer_id` format. Tracks delivery. |
| `broadcast_message(message, scope)` | Send to all peers in scope (machine/directory/repo/lan) |
| `set_name(name)` | Set session name (from /rename) |
| `set_summary(summary)` | Set work summary visible to peers |
| `check_messages()` | Returns unconfirmed pushed messages + new broker messages. Real fallback when channel push isn't working. |
| `message_status(message_id)` | Check delivery status of a previously sent message |
| `channel_health()` | Diagnose messaging health: broker status, pending messages, delivery failures |

## Running

```bash
# ZSH wrapper auto-includes --dangerously-load-development-channels flag.
claude

# CLI:
bun src/cli.ts status              # broker status + all peers
bun src/cli.ts peers               # list peers
bun src/cli.ts send <id> <msg>     # send message
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
bun test                           # All 100 tests, 308 assertions
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
| `src/broker.ts` | HTTP server + SQLite + federation TLS + /message-status |
| `src/server.ts` | MCP server + deferred ack + delivery tracking + channel push |
| `src/cli.ts` | CLI: init, join, token, doctor, refresh-wsl2, connect, status |
| `src/mdns.ts` | mDNS auto-discovery via bonjour-service |
| `src/federation.ts` | TLS cert gen, HMAC, subnet, curl fetch, WSL2 detection |
| `src/shared/types.ts` | All TypeScript interfaces |
| `src/shared/config.ts` | Config file reader/writer with remotes/mdns support |

## Known Issues

- **Bun 1.3.x fetch() + self-signed TLS**: `tls: { rejectUnauthorized: false }` doesn't work. Federation uses `curl -sk` subprocess workaround via `federationFetch()`.
- **Channel notifications silently dropped by Claude Code**: `mcp.notification()` succeeds but Claude Code may not render the notification (~30-50% of the time). Mitigated by deferred ack, `check_messages` fallback, and sender delivery warnings. Root cause unknown — see `docs/TROUBLESHOOTING.md`.
- **Channel notifications after /mcp reconnect**: `/mcp` reconnect restores tool access but may not re-establish channel subscriptions. Full session restart required for channel push.
- **WSL2 mDNS**: mDNS auto-discovery does not work on WSL2 NAT mode (multicast blocked by Hyper-V). Use `federation init` + `federation join` instead. Mirrored mode may work but is unreliable.
- **Channel push verification is heuristic**: `channel_push: "working"` means a tool call occurred within 10s of startup — it proves session activity, not notification delivery. Treat as best-effort signal.

## Deferred Optimizations

- **Per-message /list-peers call**: `pollAndPushMessages` calls `/list-peers` for every received message to look up sender name. Should cache sender info to reduce broker load under active messaging.
- **Config file atomicity**: `addRemoteToConfig`/`removeRemoteFromConfig` do read-modify-write without file locking. Concurrent CLI + broker writes could clobber. Acceptable for single-user use.
- **In-memory state on MCP restart**: `pendingMessages` and `sentMessages` are lost when the MCP server restarts. Could persist to broker SQLite for durability across restarts.
