# Security Policy — claude-peers-mcp

## Threat Model

claude-peers-mcp is a **localhost-first** peer discovery and messaging system for Claude Code instances. It is designed for **single-user, single-machine** or **trusted LAN** environments.

### In Scope
- **Localhost broker** (`localhost:7899`): All Claude Code sessions on one machine communicate through a shared HTTP broker backed by SQLite. Access is authenticated via bearer token.
- **LAN federation** (optional, port `7900`): Cross-machine messaging over TLS with PSK authentication. Intended for trusted LANs (home office, VPN).
- **mDNS discovery** (optional): Automatic peer discovery via Bonjour/mDNS on the local network. PSK hash pre-filtering prevents connections to unknown peers.

### Out of Scope
- **Internet-facing deployment**: This tool is NOT designed for public networks. Do not expose ports 7899 or 7900 to the internet.
- **Multi-tenant environments**: The broker serves all local sessions under one auth token. There is no per-user isolation.
- **Hostile local users**: The auth token is stored at `~/.claude-peers-token` (mode 0600). Users with root access or access to your home directory can read it.

---

## Authentication Mechanisms

### Local (server.ts ↔ broker.ts)

| Mechanism | Details |
|-----------|---------|
| **Bearer token** | All POST endpoints require `Authorization: Bearer <token>` header |
| **Token source** | `~/.claude-peers-token` (auto-generated, 64 hex chars, mode 0600) |
| **Token comparison** | `crypto.timingSafeEqual()` — constant-time to prevent timing side-channels |
| **Token rotation** | `bun src/cli.ts rotate-token` or manual replacement + SIGHUP to broker |
| **Exempt endpoints** | `/health` (GET, read-only, no sensitive data) |

### Federation (cross-machine)

| Mechanism | Details |
|-----------|---------|
| **TLS** | Self-signed RSA-2048 certificates, generated per machine |
| **PSK** | Pre-shared key (same token as local auth) sent via `X-Claude-Peers-PSK` header |
| **HMAC-SHA256** | All relay messages are signed with HMAC-SHA256 using the PSK |
| **Subnet filtering** | Configurable CIDR filter on inbound federation connections |
| **Cert permissions** | Private key stored at `~/.claude-peers-federation.key` (mode 0600) |

### mDNS Discovery

| Mechanism | Details |
|-----------|---------|
| **PSK hash** | Only first 8 chars of SHA-256(PSK) are advertised — not the full token |
| **Hash comparison** | `crypto.timingSafeEqual()` for constant-time pre-filtering |
| **Auto-connect** | Only connects to peers with matching PSK hash |

---

## Input Validation

| Boundary | Validation |
|----------|------------|
| **Message type** | Must be in `{text, query, response, handoff, broadcast}` |
| **Message size** | Combined text + metadata capped at 10KB |
| **Metadata** | Must be a plain object (not array, not null) |
| **reply_to** | Referenced message must exist in database |
| **Peer ID** | Validated via SQL lookup before message delivery |
| **PID liveness** | Dead peers detected via `process.kill(pid, 0)` before send |
| **SQL** | All queries use prepared statements (parameterized) — no SQL injection risk |
| **Federation relay** | Same validation as local sends (type, metadata shape, 10KB size limit) |

---

## Rate Limiting

- **Scope**: `/send-message` and `/broadcast` endpoints only
- **Limit**: 60 requests per minute per IP
- **Cleanup**: Expired entries cleared every 60s (prevents memory leak)
- **Exempt**: `/register`, `/heartbeat`, `/poll-messages`, `/health`

---

## Known Security Considerations

### MEDIUM: Rate limit uses X-Forwarded-For header
The localhost broker uses `x-forwarded-for` for IP detection (broker-handlers.ts:520). On localhost, all clients are `127.0.0.1`, sharing one rate limit bucket. This header is also spoofable, though exploitation requires local access (already authenticated).

### MEDIUM: PSK visible in process list during federation
Federation HTTPS calls use `curl -sk` with the PSK as a command-line argument (federation.ts:212). On shared machines, other users can see this via `/proc/<pid>/cmdline`. Mitigation: federation is designed for single-user machines.

### LOW: Old PSK token in git history
An early commit included a hardcoded PSK token (`c5aa534...`). It was removed and the token was rotated. The value remains in git history but is no longer valid. If you forked before the rotation, regenerate your token: `bun src/cli.ts rotate-token`.

### INFO: Federation status endpoint is unauthenticated (GET)
`/federation/status` responds to GET without auth. It exposes: enabled state, port, subnet, connected remotes (hostname, peer count). No message content or tokens are exposed.

### INFO: Duplicate federation/status route
The POST switch-case at broker-handlers.ts:592 duplicates the GET handler at line 536. The POST version is dead code (harmless).

---

## Token Rotation Procedure

```bash
# 1. Generate a new token
bun src/cli.ts rotate-token

# 2. Hot-reload the broker (picks up new token)
kill -HUP $(lsof -ti :7899)

# 3. Reconnect all MCP sessions (/mcp in each Claude Code terminal)

# 4. If using federation, update the token on all machines
# Copy new ~/.claude-peers-token to each federated machine, then SIGHUP their brokers
```

---

## Reporting Vulnerabilities

This is an open-source tool for local development use. If you find a security issue:

1. **For this fork**: Open an issue at [RichelynScott/claude-peers-mcp](https://github.com/RichelynScott/claude-peers-mcp/issues) with the `security` label
2. **For the upstream**: Report to [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp)

Please include: affected file, line number, reproduction steps, and potential impact.

---

## Security Checklist (verified v0.6.0)

- [x] Bearer token auth on all POST endpoints
- [x] `timingSafeEqual` for token comparison (broker + mDNS)
- [x] Parameterized SQL queries (no injection)
- [x] Input validation on all message fields (type, metadata, size, reply_to)
- [x] Rate limiting on send/broadcast (60/min)
- [x] Rate limit map cleanup (no memory leak)
- [x] TLS for federation transport
- [x] PSK auth for federation endpoints
- [x] HMAC-SHA256 message signing for relays
- [x] Subnet filtering on federation connections
- [x] Token file permissions (0600)
- [x] Config file permissions (0600)
- [x] Private key permissions (0600)
- [x] Ack scoping (peers can only ack their own messages)
- [x] PID liveness check before message delivery
- [x] Dead peer message bounce (no silent message loss)
- [x] No secrets in current source files
