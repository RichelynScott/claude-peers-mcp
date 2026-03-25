# claude-peers-mcp

Peer discovery and messaging MCP for Claude Code instances. Supports LAN federation for cross-machine collaboration.

## Project Structure

```
src/                    # Source code
  broker.ts             # Singleton HTTP daemon (localhost:7899) + SQLite + federation TLS server
  server.ts             # MCP stdio server (one per Claude Code instance) + channel push
  cli.ts                # CLI utility for inspecting/managing broker state
  federation.ts         # TLS cert gen, HMAC signing, subnet utils, curl-based TLS fetch
  index.ts              # Entry point
  shared/
    types.ts            # All TypeScript interfaces
    token.ts            # Shared token file reader for auth
    summarize.ts        # Deterministic git-based auto-summary (no external APIs)
tests/                  # Test suites (100 tests, 302 assertions)
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
| `send_message(to_id, text, type?, metadata?, reply_to?)` | Send message to peer. Remote peers use `hostname:peer_id` format |
| `broadcast_message(message, scope)` | Send to all peers in scope (machine/directory/repo/lan) |
| `set_name(name)` | Set session name (from /rename) |
| `set_summary(summary)` | Set work summary visible to peers |
| `check_messages()` | Diagnostic tool — without channel push, messages are auto-consumed by the MCP server before Claude sees them |

## Running

```bash
# ZSH wrapper auto-includes --dangerously-load-development-channels flag.
claude

# CLI:
bun src/cli.ts status              # broker status + all peers
bun src/cli.ts peers               # list peers
bun src/cli.ts send <id> <msg>     # send message
bun src/cli.ts kill-broker         # stop broker daemon
bun src/cli.ts federation status   # federation state
bun src/cli.ts federation connect <host>:<port>  # connect to remote
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
bun test                    # All 100 tests
bun test tests/broker.test.ts    # Broker only
bun test tests/federation.test.ts # Federation only
```

## Key Files

| File | Purpose |
|------|---------|
| `CHANGELOG.md` | Version history |
| `FYI.md` | Decision journal |
| `CLAUDE.md` | This file — project instructions |
| `src/broker.ts` | HTTP server + SQLite + federation TLS |
| `src/server.ts` | MCP server + channel push |
| `src/federation.ts` | TLS cert gen, HMAC, subnet, curl fetch |
| `src/shared/types.ts` | All TypeScript interfaces |

## Known Issues

- **Bun 1.3.x fetch() + self-signed TLS**: `tls: { rejectUnauthorized: false }` doesn't work. Federation uses `curl -sk` subprocess workaround via `federationFetch()`.
- **Channel notifications after /mcp reconnect**: `/mcp` reconnect restores tool access but may not re-establish channel subscriptions. Full session restart required for channel push.
- **Zombie MCP servers**: Fixed in v0.3.0 with parent death detection + TTY-based eviction.
