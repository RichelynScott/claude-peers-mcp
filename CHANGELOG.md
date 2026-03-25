# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.3.0] - 2026-03-25

### Added
- LAN Federation Phase A — manual cross-machine peer discovery via `connect <ip>` (`c057ec7`)
- Federation CLI commands: `connect`, `disconnect`, `status` for managing LAN peers
- Cross-machine peer discovery with `list_peers(scope="lan")`
- Cross-machine messaging via `send_message` to remote peers (hostname:peer_id format)
- LAN broadcast with `broadcast_message(scope="lan")`
- TLS encrypted federation transport with self-signed certificates
- PSK (pre-shared key) authentication for federation endpoints
- HMAC-SHA256 message signing for federation requests
- Zombie MCP server prevention — parent death detection and TTY-based eviction (`844bc33`)
- 21 federation-specific tests bringing total to 100 tests, 302 assertions

### Fixed
- WSL2 subnet auto-detection defaults to allow-all (172.x.x.x NAT range is not the LAN)
- Auto-detection and cleanup of stale MCP server processes on startup
- New CLI `restart` command kills broker + all MCP servers for clean reconnect
- Channel notification payload format — null values silently dropped by Claude Code, now omitted cleanly (`eb4c72b`)
- IP spoofing vulnerability — use `server.requestIP()` instead of `X-Forwarded-For` header
- HMAC canonicalization — nested objects now preserved during signing
- Bun `fetch()` TLS workaround — use `curl` for self-signed certificate connections

### Removed
- OpenAI dependency for auto-summary — replaced with deterministic git-based summary generation (`b629fee`)

## [0.2.0] - 2026-03-24

### Added
- Bearer token authentication on all broker POST endpoints with auto-generated token at `~/.claude-peers-token` (`8d52439`)
- Token rotation support via SIGHUP signal
- Structured message protocol — message types: text, query, response, handoff, broadcast (`133d09e`)
- JSON metadata field on messages for structured payloads
- `reply_to` field for message threading
- Broadcast endpoint (`/broadcast`) and `broadcast_message` MCP tool for scoped group messaging (`133d09e`)
- Auto-summary CLI command with deterministic git context (`57ee55a`)
- MCP server integration test suite — 18 tests via MCP Client over stdio (`67baf9f`)
- Two-phase message delivery with poll + ack for at-least-once guarantee (`de82a12`)
- PID liveness check on send — dead peers get immediate error instead of silent queueing (`de82a12`)
- Message ID returned on successful send for tracking (`de82a12`)
- Message cleanup — delivered messages purged after 7 days on 60s interval (`c54dd1a`)
- Rate limiting — 60 requests/min per IP on `/send-message` (`c54dd1a`)
- Message size limit — 10KB max payload (`c54dd1a`)
- CLI `set-name` command (`c54dd1a`)
- Broker test suite — 40 tests, 205 assertions (`cca5691`)
- CLI + auto-summary test suite — 17 tests (`57ee55a`)
- Centralized `cpm-logs/` directory for all observability (`aafb332`, `bc045a1`)
- Session name preserved on re-register (`df482b5`)
- Message preview in channel notifications (`df482b5`)
- TROUBLESHOOTING.md for new session onboarding (`6ba8316`)

### Fixed
- Rate limit map memory leak — expired entries now cleaned on 60s interval (`e7515e0`)
- O(1) log file append — replaced read-then-write with Bun.write append mode (`e7515e0`)
- Rate limiting scope — exempt `/register`, `/heartbeat`, and internal endpoints (`669b4fe`, `46a740d`)
- TDZ bug in broker — `cleanDeliveredMessages` called before prepared statement declared (`cca5691`)
- `/health` endpoint now responds to any HTTP method (`e7515e0`)

### Changed
- README fully rewritten for fork with 13 sections (`cca5691`)
- CLAUDE.md updated with fork divergence table, key files, and Bun conventions

## [0.1.0] - 2026-03-24

### Added
- Fork from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp)
- `session_name` as first-class field in peer registry with schema migration (`6b8ec50`)
- `set_name` MCP tool for setting human-friendly session names (`6b8ec50`)
- `from_name` metadata in channel push notifications (`6b8ec50`)
- `[SESSION_NAME]` tag display in CLI output (`6b8ec50`)
- Full message logging to stderr and `cpm-logs/messages.log` (`c995316`)
- Project documentation: CLAUDE.md, FYI.md, PROJECT_INDEX.json (`c995316`)
