# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.4.2] - 2026-03-26

### Added
- **SIGHUP hot-reload for broker config**: Broker re-reads auth token and persistent config file on SIGHUP without dropping connections or requiring `/mcp` reconnect. Uses `Bun.serve().reload()` to swap fetch handler in-place. (`e9af8f6`)
- **`reload-broker` CLI command**: Finds broker PID via lsof, sends SIGHUP, reports success with peer count. (`e9af8f6`)

### Fixed
- **Federation relay validation (security)**: Federation `/relay` endpoint now validates metadata is a plain object (not array), enforces 10KB combined size limit (text + metadata), and uses the shared `VALID_MESSAGE_TYPES` set — same rules as `/send-message`. Previously a malicious federated peer could relay oversized or malformed messages. (`9375f11`)
- **Zombie test broker cleanup**: All 4 test files now force-kill any process holding their test port in `beforeAll`, preventing cascading failures from interrupted test runs. (`b1b9bee`)

## [0.4.1] - 2026-03-26

### Changed
- **Simplified delivery model**: Stripped deferred ack system (-279 lines). Messages now push once, ack immediately, dedup via Set, with `check_messages` as fallback. Removed: pending buffers, delivery warnings, sender tracking, bug reports, piggyback inbox, retry push — all caused cascading problems (duplicates, spam, constant pinging).
- **Deterministic peer IDs**: Peer IDs are now SHA-256 hashes of TTY, stable across `/mcp` reconnects. Messages sent to an old ID still arrive after reconnect.
- **Per-poll peer fetch**: Sender info fetched once per poll cycle with `scope: "lan"` instead of per-message with `scope: "machine"`. Reduces broker load and includes federated senders.
- **Session identification improvements**: Session names persist locally in MCP server and re-sent on register. Auto-summaries include `[SessionName]` prefix when set. `list_peers` output shows session name as prominent header (`**Name** (id)`). (`37adc79`)

### Fixed
- **Duplicate message delivery**: Added permanent `pushedMessageIds` Set with bounded cap (1000). Messages are never pushed twice regardless of ack state or buffer expiry.
- **Delivery warning spam**: Removed entirely. Warnings fired every second instead of once, and the underlying push unreliability is a Claude Code limitation, not fixable server-side.
- **Ack scoping**: `/ack-messages` now scopes by `to_id` — peers can only ack their own messages.
- **Dead peer message bounce**: Broker bounces undelivered messages back to senders when target peer dies, with orphan cleanup on startup.
- **Dead code cleanup**: Removed all leftover references to removed systems (writeBugReport, SentMessage, FAILURE_LOG_PATH, etc.)
- **Stale tool descriptions**: Updated `check_messages` and `channel_health` descriptions to match simplified implementation.

## [0.4.0] - 2026-03-26

### Added
- **Deferred ack for channel push reliability** — messages are no longer acked to the broker immediately after `mcp.notification()`. They enter a pending buffer and are only confirmed when evidence of receipt arrives: `check_messages` call, `reply_to` match, or 30s optimistic timeout. Eliminates ~30-50% silent message loss. (`0aef487`)
- **`check_messages` as a real fallback** — now returns pending (pushed but unconfirmed) messages plus new broker messages, deduplicated. Previously returned empty because messages were already acked. (`0aef487`)
- **Startup retry logic** — `/register` call wrapped in 3-attempt retry with exponential backoff (0ms, 1s, 3s) and 5s per-attempt timeout. Fixes "Failed to connect" errors with 6+ sessions. (`68dc1ac`)
- **Configurable startup timeout** — `CLAUDE_PEERS_STARTUP_TIMEOUT_MS` env var and `server.startup_timeout_ms` config (default 15s, min 3s clamp). (`68dc1ac`)
- **Startup timing instrumentation** — each startup phase timed and logged: `broker=Xms, token=Yms, register=Zms, total=Nms`. (`68dc1ac`)
- **Graceful startup error messages** — on final failure, probes `/health` for peer count, reports broker reachability, suggests actionable fix. (`68dc1ac`)
- **Enhanced `/health` endpoint** — returns `uptime_ms`, `requests_last_minute`, and `pending_messages` in addition to existing fields. (`68dc1ac`)
- **Broker request priority** — `/heartbeat` and `/poll-messages` yield to event loop before body parsing, letting queued `/register` requests run first. (`68dc1ac`)
- **`federation init`** — one-command setup: config file, certs, token, platform-specific firewall (WSL2/macOS/Linux), broker restart, outputs join URL. Replaces `federation setup` (which remains as alias). (`5c5b49e`)
- **`federation join <cpt-url>`** — single command to join a federation using a `cpt://host:port/token` URL. Writes token, updates config, generates cert, restarts broker, connects. (`5c5b49e`)
- **`federation token`** — generates a `cpt://` connection URL for sharing with other machines. (`5c5b49e`)
- **`federation doctor`** — comprehensive health check: config, token, certs, broker, TLS, LAN IP, connected remotes, config/actual mismatch warnings. (`5c5b49e`)
- **Auto-reconnect on broker restart** — broker reads `federation.remotes` from config file on startup and reconnects with exponential backoff (0s, 5s, 15s, 45s, then 60s). (`5c5b49e`)
- **Connect/disconnect persistence** — `federation connect` saves to config file, `federation disconnect` removes. Survives broker restarts. (`5c5b49e`)
- **`federation refresh-wsl2`** — updates stale port forwarding rules when WSL2 IP changes after reboot. (`54f3a6d`)
- **WSL2 mirrored networking detection** — reads `.wslconfig` for `networkingMode=mirrored`, skips port forwarding when detected. (`54f3a6d`)
- **mDNS auto-discovery** — new `src/mdns.ts` module with `MdnsManager`. Advertises `_claude-peers._tcp` service on LAN via `bonjour-service`. Auto-connects when matching PSK hash peers discovered. Backoff logic, dedup, WSL2 graceful degradation. (`1fddddf`)
- **Sender delivery confirmation** — broker `/message-status` endpoint, `message_status` MCP tool, automatic 30s delivery check with channel push warning to sender. (`1657928`)
- **Auto bug reports** — on send failure or unconfirmed delivery, writes diagnostics to `BUG_REPORTS/` and `cpm-logs/delivery-failures.log`. (`1657928`)
- **`channel_health` MCP tool** — diagnostic report: broker status, pending inbound/outbound, delivery warnings, recent failures, bug report count. (`1657928`)

### Fixed
- **`FEDERATION_ENABLED=false` env var override** — previously only checked for `true`/`1`, now respects `false`/`0` to explicitly disable federation even when config file says enabled. (`1122b72`)
- **Delivery warning surfacing** — warnings now push a self-notification via channel to interrupt the sender immediately, not just log to stderr. (`4f5546d`)
- **Better Windows LAN IP detection** — uses default route method (`Get-NetIPConfiguration` with gateway) instead of pattern matching that misses `172.16-31.*` and hits VPN adapters. (`54f3a6d`)
- **WSL2 subnet warning** — broker logs warning when user sets `CLAUDE_PEERS_FEDERATION_SUBNET` to non-`0.0.0.0/0` on WSL2 (unreliable due to NAT IP rewriting). (`54f3a6d`)

### Code Quality (7-model consensus review)
- 12 issues identified and fixed via multi-model consensus review (GPT-5.4, Grok-4.20, Gemini-3.1-Pro, DeepSeek-v3.2, Minimax-m2.7, Kimi-k2.5, GLM-5):
  - `sentMessages` Map bounded at MAX_SENT=200 (`server.ts`)
  - PSK hash comparison uses `timingSafeEqual` to prevent timing side-channel (`mdns.ts`)
  - `Peer.channel_push` made optional to prevent "undefined" display on remote peers (`types.ts`)
  - Config file permissions tightened to 0o600 (`config.ts`)
  - Bug report filename collision fixed for messageId=0 send failures (`server.ts`)
  - Warned `sentMessages` entries rechecked for late delivery (`server.ts`)
  - `as any` cast removed in message_status handler (`server.ts`)
  - Verification timer cleared on shutdown (`server.ts`)
  - `autoReconnectRemote` capped at 20 attempts and doubled backoff fixed (`broker.ts`)
  - Federation relay validates message type against allowed set (`broker.ts`)
  - Buffer overflow force-ack replaced with skip-and-re-poll to preserve deferred ack contract (`server.ts`)
  - MdnsManager `dedupMap`/`backoffMap` cleaned every 5 minutes (`mdns.ts`)

### Dependencies
- Added `bonjour-service@1.3.0` for mDNS auto-discovery (pure JS, no native addons)

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
- Persistent config file (`~/.claude-peers-config.json`) for federation settings
- Guided federation setup wizard (`bun src/cli.ts federation setup`)
- 21 federation-specific tests bringing total to 100 tests, 302 assertions

### Fixed
- TLS cert generation now defaults to RSA-2048 for macOS LibreSSL compatibility (Ed25519 caused handshake failures)
- WSL2 subnet auto-detection defaults to allow-all (172.x.x.x NAT range is not the LAN)
- Auto-detection and cleanup of stale MCP server processes on startup
- New CLI `restart` command kills broker + all MCP servers for clean reconnect
- Channel notification payload format — null values silently dropped by Claude Code, now omitted cleanly (`eb4c72b`)
- IP spoofing vulnerability — use `server.requestIP()` instead of `X-Forwarded-For` header
- HMAC canonicalization — nested objects now preserved during signing
- Bun `fetch()` TLS workaround — use `curl` for self-signed certificate connections
- Token rotation support (`bun src/cli.ts rotate-token`)

### Security
- Removed exposed PSK token from repository, rotated credentials

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
