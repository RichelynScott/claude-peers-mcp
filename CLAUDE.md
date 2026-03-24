# claude-peers-mcp

Private fork of [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp). Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite (`~/.claude-peers.db`). Auto-launched by the MCP server.
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker, exposes tools, pushes channel notifications.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Auto-summary generation via OpenAI gpt-5.4-nano (requires OPENAI_API_KEY, falls back gracefully).
- `cli.ts` — CLI utility for inspecting broker state.

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_peers(scope)` | Discover peers. Scope: machine/directory/repo |
| `send_message(to_id, text, type?, metadata?, reply_to?)` | Send message to peer by ID. Optional type (text/query/response/handoff/broadcast), metadata (JSON object), reply_to (message ID for threading) |
| `broadcast_message(message, scope)` | Send message to all peers in scope (machine/directory/repo) |
| `set_name(name)` | Set session name (from /rename) |
| `set_summary(summary)` | Set work summary visible to peers |
| `check_messages()` | Manual message poll (fallback — channel push is primary) |

## Running

```bash
# ZSH wrapper auto-includes --dangerously-load-development-channels flag.
# Just run claude normally — channel push is automatic.
claude

# CLI:
bun cli.ts status          # broker status + all peers
bun cli.ts peers           # list peers
bun cli.ts send <id> <msg> # send message
bun cli.ts kill-broker     # stop broker daemon
```

## Observability

All CPM logs are in `cpm-logs/` (gitignored, log prefixes: `[CPM-broker]`, `[CPM-server]`):

- **`cpm-logs/messages.log`**: All sent and received messages with timestamps, sender names, message IDs
- **`cpm-logs/broker.log`**: Broker lifecycle — startup, peer cleanup, message cleanup, rate limiting
- **`cpm-logs/server.log`**: MCP server — registration, polling, connection events, errors
- **stderr**: Also echoed to stderr (visible in Claude Code MCP logs)
- **CLI**: `bun cli.ts status` shows registered peers with [SESSION_NAME] tags
- **Monitor all**: `tail -f cpm-logs/*.log`

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bunx <package>` instead of `npx <package>`
- Bun automatically loads .env, so don't use dotenv.

### APIs

- `Bun.serve()` for HTTP. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- Prefer `Bun.file` over `node:fs` readFile/writeFile.
- `WebSocket` is built-in. Don't use `ws`.

### Testing

Use `bun test` to run tests. Test files: `*.test.ts`.

## Fork Divergence from Upstream

| Feature | Status | Commit |
|---------|--------|--------|
| session_name field in peers table | Done | `6b8ec50` |
| set_name MCP tool | Done | `6b8ec50` |
| Schema migration (ALTER TABLE) for existing DBs | Done | `6b8ec50` |
| from_name in channel push meta | Done | `6b8ec50` |
| [SESSION_NAME] tag in CLI output | Done | `6b8ec50` |
| Full message logging (stderr + file) | Done | `c995316` |
| Message cleanup (delivered + 7 days) | Done | `c54dd1a` |
| Message size limit (10KB max) | Done | `c54dd1a` |
| Rate limiting (60 req/min per IP) | Done | `c54dd1a` |
| CLI set-name command | Done | `c54dd1a` |
| Broker test suite (20 tests) | Done | `cca5691`, `de82a12` |
| README rewrite for fork | Done | `cca5691` |
| Rate limit map cleanup (60s interval) | Done | `e7515e0` |
| O(1) log file append | Done | `e7515e0` |
| Two-phase delivery (poll + ack) | Done | `de82a12` |
| PID liveness check on send | Done | `de82a12` |
| Message ID returned on send | Done | `de82a12` |
| ZSH wrapper for auto-channel-push | Done (in ~/.zshrc) | N/A |
| Bearer token auth on all POST endpoints | Done | `8d52439` |
| Structured messages (type/metadata/reply_to) | Done | `133d09e` |
| Broadcast endpoint (/broadcast) | Done | `133d09e` |
| broadcast_message MCP tool | Done | `133d09e` |
| CLI broadcast command | Done | `133d09e` |

**Sync policy**: Monthly `git fetch upstream`, cherry-pick selectively. Upstream has 8 open PRs to watch.

## Key Files

| File | Purpose |
|------|---------|
| `FYI.md` | Decision journal and backlog |
| `CLAUDE.md` | This file — project instructions |
| `broker.test.ts` | Broker test suite (40 tests) |
| `shared/types.ts` | All TypeScript interfaces |
| `broker.ts` | HTTP server + SQLite |
| `server.ts` | MCP server + channel push |
| `cli.ts` | CLI utility |
