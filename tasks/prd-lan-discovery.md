# PRD: LAN Cross-Machine Peer Discovery and Messaging

## Introduction

Extend claude-peers-mcp from localhost-only peer networking to LAN-scope peer discovery and messaging. Today, all communication is bound to `127.0.0.1` -- Claude Code sessions can only discover and message peers on the same machine. This feature enables sessions running on different machines on the same local network (e.g., Riche's WSL2 box and Rafi's Mac) to discover each other, exchange messages, and collaborate in real time.

**Architecture: Federated brokers** -- each machine continues running its own local broker on `127.0.0.1:7899`. A new federation agent on each machine handles LAN-facing communication: mDNS announcement, TLS-encrypted connections to remote federation agents, peer list synchronization, and cross-machine message routing. This preserves the existing localhost security boundary while adding a controlled, authenticated LAN layer.

**Dependencies (must be implemented first):**
1. **Broker Authentication** (`prd-broker-auth.md`) -- bearer token auth on all POST endpoints. The token at `~/.claude-peers-token` becomes the pre-shared key (PSK) for LAN federation.
2. **Structured Messages + Broadcast** (`prd-structured-messages.md`) -- message types, metadata, and broadcast. LAN federation relays all message types including broadcasts.

**Risk level: HIGH** -- any network exposure requires security-first design. Deep research on WSL2 networking, mDNS behavior, and TLS in Bun should be conducted before implementation begins.

**Phased implementation:** This feature is too large for a single Ralph run. It is split into three phases (A, B, C), each independently shippable and testable. Phase A is the minimum viable feature; Phases B and C are enhancements.

## Goals

- **G-1**: Claude Code sessions on different machines on the same LAN can discover each other via `list_peers(scope="lan")`.
- **G-2**: Claude Code sessions on different machines can exchange messages via `send_message` with transparent cross-machine routing.
- **G-3**: All LAN traffic is encrypted (TLS 1.3) and authenticated (PSK derived from `~/.claude-peers-token`).
- **G-4**: Federation is opt-in. Existing localhost-only operation is unaffected when federation is disabled (default).
- **G-5**: Broadcast messages propagate to LAN peers when scope is `"lan"` or `"machine"` with federation enabled.
- **G-6**: WSL2-specific networking challenges are documented with workarounds.
- **G-7**: All existing tests pass unchanged. New federation-specific tests cover discovery, routing, auth, and failure modes.

## User Stories

### Phase A: Manual Federation (connect by IP, PSK auth, TLS)

#### US-A01: Enable federation on a machine

**Description:** As a user, I want to enable federation via environment variable so that my broker participates in LAN peer networking.

**Acceptance Criteria:**
- [ ] Setting `CLAUDE_PEERS_FEDERATION_ENABLED=true` causes the federation agent to start alongside the broker
- [ ] When federation is disabled (default: `false`), no LAN-facing port is opened, no federation code executes, and existing behavior is identical to pre-federation
- [ ] Federation agent starts a TLS server on the port specified by `CLAUDE_PEERS_FEDERATION_PORT` (default: `7900`)
- [ ] Federation agent binds to `0.0.0.0` (all interfaces) to accept LAN connections
- [ ] On startup, federation agent logs: `[CPM-federation] Listening on 0.0.0.0:<port> (TLS)`
- [ ] On startup with federation disabled, no federation log lines are emitted

#### US-A02: Auto-generate self-signed TLS certificate

**Description:** As a user starting federation for the first time, I want a TLS certificate to be auto-generated so that encrypted communication works without manual PKI setup.

**Acceptance Criteria:**
- [ ] On first federation startup, if no cert/key files exist at the configured paths, generate a self-signed X.509 certificate and RSA 2048-bit (or Ed25519) private key
- [ ] Default paths: `~/.claude-peers-federation.crt` and `~/.claude-peers-federation.key`
- [ ] Configurable via `CLAUDE_PEERS_FEDERATION_CERT` and `CLAUDE_PEERS_FEDERATION_KEY` env vars
- [ ] Certificate has Subject CN set to the machine's hostname
- [ ] Certificate validity: 365 days
- [ ] Key file written with mode `0600`
- [ ] If cert/key already exist, they are loaded without regeneration
- [ ] Broker logs: `[CPM-federation] TLS cert loaded from <path>` (never logs key material)
- [ ] If Bun's native TLS APIs cannot generate certs, shell out to `openssl` or use a Bun-compatible library (document the approach in implementation)

#### US-A03: Connect to a remote federation agent by IP

**Description:** As a user, I want to manually connect to a peer machine's federation agent by IP address so that our brokers can share peer lists and route messages.

**Acceptance Criteria:**
- [ ] New CLI command: `bun cli.ts federation connect <host>:<port>`
- [ ] The local federation agent initiates a TLS connection to the remote host:port
- [ ] On TLS handshake, the local agent sends its PSK (the token from `~/.claude-peers-token`) in a `X-Claude-Peers-PSK` header on an HTTP POST to the remote `/federation/handshake` endpoint
- [ ] The remote agent validates the PSK against its own `~/.claude-peers-token` using `crypto.timingSafeEqual()`. If mismatch, connection is rejected with `{ error: "PSK mismatch" }` and TLS connection is closed
- [ ] If PSK matches, both sides store each other as a "federated peer" (in-memory, not persisted to SQLite)
- [ ] CLI prints: `Connected to <host>:<port> (<remote_hostname>). <N> remote peers available.`
- [ ] If connection fails (network error, PSK mismatch, TLS error), CLI prints a clear error message
- [ ] Connection timeout: 5 seconds

#### US-A04: Disconnect from a remote federation agent

**Description:** As a user, I want to disconnect from a specific remote federation agent so that I can control which machines are in my peer network.

**Acceptance Criteria:**
- [ ] New CLI command: `bun cli.ts federation disconnect <host>:<port>`
- [ ] Removes the remote from the federated peers list
- [ ] Closes the TLS connection to that remote
- [ ] Remote peers from that machine are removed from `list_peers(scope="lan")` results
- [ ] CLI prints: `Disconnected from <host>:<port>.`

#### US-A05: Federation status command

**Description:** As a user, I want to see the current federation status so that I know which machines are connected and how many remote peers are available.

**Acceptance Criteria:**
- [ ] New CLI command: `bun cli.ts federation status`
- [ ] Displays: federation enabled/disabled, listening port, connected remotes (host, port, hostname, remote peer count, connection uptime), total remote peers
- [ ] If federation is disabled, prints: `Federation is disabled. Set CLAUDE_PEERS_FEDERATION_ENABLED=true to enable.`
- [ ] If federation is enabled but no remotes are connected, prints: `Federation enabled on port <port>. No remote machines connected.`

#### US-A06: Periodic peer list sync with remote brokers

**Description:** As a connected federation agent, I want to periodically sync peer lists with remote brokers so that new sessions on remote machines are discovered automatically.

**Acceptance Criteria:**
- [ ] Every 30 seconds (configurable), the federation agent fetches the peer list from each connected remote via `POST /federation/peers`
- [ ] Remote peers are stored in an in-memory map keyed by `<remote_host>:<remote_port>:<peer_id>`
- [ ] Remote peers include a `machine` field containing the remote hostname (or IP if hostname unavailable)
- [ ] Stale remote peers (from a remote that hasn't synced in 90 seconds) are automatically removed
- [ ] Local peers remain managed by the local broker (SQLite). Remote peers are never written to the local SQLite database
- [ ] Peer list sync requests are authenticated with the PSK (same as handshake)

#### US-A07: List peers with LAN scope

**Description:** As a Claude Code session, I want to list peers across the LAN so that I can discover sessions on other machines.

**Acceptance Criteria:**
- [ ] `list_peers` MCP tool gains a new scope value: `"lan"`
- [ ] When `scope="lan"`, the tool returns both local peers (from local broker) and remote peers (from federation agent's in-memory cache)
- [ ] Remote peers are clearly distinguished from local peers in the output: `[REMOTE:<hostname>]` prefix on the first line of each remote peer's entry
- [ ] Remote peers include: ID (prefixed with remote hostname to avoid collisions, e.g., `rafi-mac:a1b2c3d4`), CWD, git_root, session_name, summary, last_seen, machine hostname
- [ ] Remote peers do NOT include PID or TTY (not meaningful across machines)
- [ ] When federation is disabled, `scope="lan"` returns an error: `"Federation is not enabled. Set CLAUDE_PEERS_FEDERATION_ENABLED=true to use LAN scope."`
- [ ] The `ListPeersRequest` type gains `"lan"` as a valid scope value

#### US-A08: Send message to a remote peer

**Description:** As a Claude Code session, I want to send a message to a peer on another machine so that I can collaborate across machines.

**Acceptance Criteria:**
- [ ] `send_message` transparently detects remote peer IDs (those with a hostname prefix like `rafi-mac:a1b2c3d4`)
- [ ] For remote peers, the MCP server routes the message through the federation agent instead of the local broker
- [ ] Federation agent forwards the message to the correct remote federation agent via `POST /federation/relay` (TLS, PSK-authenticated)
- [ ] The remote federation agent delivers the message to its local broker via `POST /send-message` (localhost, bearer token)
- [ ] The remote peer receives the message via the normal polling/channel push mechanism (no changes to recipient-side delivery)
- [ ] Cross-machine messages include `from_machine` in the channel notification meta (so the recipient knows which machine the sender is on)
- [ ] If the remote federation agent is unreachable, `send_message` returns a clear error: `"Remote machine <hostname> is unreachable"`
- [ ] Message size limit (10KB) is enforced locally before relaying

#### US-A09: Subnet restriction

**Description:** As a security-conscious user, I want federation to only accept connections from my local subnet so that machines outside my trusted network cannot connect.

**Acceptance Criteria:**
- [ ] `CLAUDE_PEERS_FEDERATION_SUBNET` env var specifies allowed CIDR (e.g., `192.168.1.0/24`)
- [ ] Default: auto-detect the local machine's /24 subnet from the primary network interface
- [ ] Incoming TLS connections from IPs outside the allowed subnet are immediately rejected before handshake
- [ ] Federation agent logs rejected connections: `[CPM-federation] Rejected connection from <ip> (outside subnet <cidr>)`
- [ ] Outgoing connections (via `federation connect`) also verify the target IP is within the allowed subnet
- [ ] Subnet check uses standard CIDR bitmasking, supports both /24 and arbitrary prefix lengths

#### US-A10: Message signing with HMAC-SHA256

**Description:** As a security-conscious user, I want all federation messages to be signed so that tampering is detected even if TLS is somehow compromised.

**Acceptance Criteria:**
- [ ] Every message relayed via `/federation/relay` includes an `X-Message-Signature` header containing an HMAC-SHA256 of the message body, keyed with the PSK
- [ ] The receiving federation agent validates the HMAC before accepting the message. Invalid signatures return `{ error: "Invalid message signature" }` with HTTP 403
- [ ] HMAC computation: `HMAC-SHA256(key=PSK, data=canonical_JSON_body)` where canonical JSON is `JSON.stringify()` with keys sorted
- [ ] Signature validation uses `crypto.timingSafeEqual()` for constant-time comparison
- [ ] Messages without signatures are rejected with `{ error: "Missing message signature" }`

#### US-A11: Federation agent tests

**Description:** As a developer, I want comprehensive tests for the federation agent so that LAN networking regressions are caught early.

**Acceptance Criteria:**
- [ ] New test file: `federation.test.ts`
- [ ] Test: federation agent starts TLS server on configured port
- [ ] Test: `/federation/handshake` with correct PSK returns success
- [ ] Test: `/federation/handshake` with wrong PSK returns error
- [ ] Test: `/federation/peers` returns local peer list (authenticated)
- [ ] Test: `/federation/peers` without PSK auth returns error
- [ ] Test: `/federation/relay` delivers message to local broker
- [ ] Test: `/federation/relay` with invalid HMAC signature is rejected
- [ ] Test: `/federation/relay` without signature is rejected
- [ ] Test: connection from outside allowed subnet is rejected
- [ ] Test: peer list sync populates remote peer cache
- [ ] Test: stale remote peers are cleaned up after 90 seconds
- [ ] Test: remote peer IDs are prefixed with machine hostname
- [ ] All tests use temporary TLS certs, temp DB, temp token file (same pattern as `broker.test.ts`)
- [ ] Tests spin up two federation agents to test bidirectional communication
- [ ] Total: 12+ tests

#### US-A12: Federation broker endpoints

**Description:** As a developer building the federation layer, I want the local broker to expose federation-specific endpoints so that the federation agent can query local state and deliver remote messages.

**Acceptance Criteria:**
- [ ] New broker endpoint: `POST /federation/peers` -- returns all local peers (same data as `/list-peers` with `scope="machine"`) for federation sync. Requires PSK auth via `X-Claude-Peers-PSK` header (separate from bearer token -- federation uses PSK, local clients use bearer token)
- [ ] New broker endpoint: `POST /federation/relay` -- accepts `{ from_id, from_machine, to_id, text, type?, metadata?, reply_to? }`, validates the `to_id` exists locally, inserts message into the local messages table. Requires PSK auth. The `from_id` is stored as-is (includes hostname prefix)
- [ ] Federation endpoints are NOT rate-limited (federation agent is trusted, rate limiting happens at the federation layer)
- [ ] Federation endpoints require bearer token auth (same as all other POST endpoints per prd-broker-auth.md) AND PSK validation
- [ ] Federation endpoints return 404 if federation is not enabled on this broker

### Phase B: mDNS Auto-Discovery

#### US-B01: Announce presence via mDNS

**Description:** As a user with federation enabled, I want my machine to automatically announce itself on the LAN via mDNS so that other machines can discover it without manual IP configuration.

**Acceptance Criteria:**
- [ ] Federation agent advertises a Bonjour/mDNS service of type `_claude-peers._tcp` on the federation port
- [ ] TXT record includes: `version=<broker_version>`, `hostname=<machine_hostname>`, `psk_hash=<first_8_chars_of_SHA256(PSK)>` (for quick pre-filtering, not security -- full PSK validation happens at handshake)
- [ ] mDNS advertisement starts when federation is enabled, stops when federation stops
- [ ] Uses `bonjour-service` npm package (or `multicast-dns` if bonjour-service is incompatible with Bun)
- [ ] If mDNS library fails to load or advertise (e.g., WSL2 without reflector), federation agent logs a warning and continues without mDNS: `[CPM-federation] mDNS advertisement failed: <error>. Manual connection via 'cli.ts federation connect' is still available.`

#### US-B02: Discover remote federation agents via mDNS

**Description:** As a user with federation enabled, I want my machine to automatically discover other machines on the LAN running claude-peers federation so that I don't need to manually enter IP addresses.

**Acceptance Criteria:**
- [ ] Federation agent listens for `_claude-peers._tcp` mDNS service announcements on the LAN
- [ ] When a new service is discovered, the agent checks the `psk_hash` TXT field against its own PSK hash. If the first 8 chars of SHA256 don't match, the service is ignored (different team/token)
- [ ] If `psk_hash` matches, the agent automatically initiates a TLS connection and PSK handshake (same flow as `federation connect`)
- [ ] Successfully connected remotes are added to the federated peers list
- [ ] If a previously discovered service disappears (mDNS goodbye), the agent disconnects and removes its remote peers
- [ ] Discovery is debounced: ignore duplicate announcements within 5 seconds
- [ ] Federation agent logs discoveries: `[CPM-federation] Discovered <hostname> at <ip>:<port> via mDNS`
- [ ] mDNS discovery runs alongside manual connections -- manually connected remotes are not affected by mDNS events

#### US-B03: mDNS discovery tests

**Description:** As a developer, I want tests for mDNS discovery behavior so that auto-discovery regressions are caught.

**Acceptance Criteria:**
- [ ] Test: mDNS service is advertised when federation starts
- [ ] Test: mDNS service is de-advertised when federation stops
- [ ] Test: discovered service with matching psk_hash triggers auto-connect
- [ ] Test: discovered service with non-matching psk_hash is ignored
- [ ] Test: mDNS failure is non-fatal (federation continues without mDNS)
- [ ] Total: 5+ mDNS-specific tests

### Phase C: WSL2-Specific Workarounds

#### US-C01: Document WSL2 networking limitations

**Description:** As a WSL2 user, I want clear documentation of networking limitations and workarounds so that I can set up federation correctly.

**Acceptance Criteria:**
- [ ] New section in README.md: "WSL2 Federation Setup"
- [ ] Documents: WSL2 runs behind a NAT; the LAN-visible IP is the Windows host's IP, not WSL2's internal IP (`172.x.x.x`)
- [ ] Documents: mDNS from WSL2 may not reach the LAN (Windows firewall, NAT, missing mDNS reflector)
- [ ] Documents: port forwarding is needed from Windows host to WSL2 for incoming federation connections
- [ ] Provides a PowerShell command to set up port forwarding: `netsh interface portproxy add v4tov4 listenport=7900 listenaddress=0.0.0.0 connectport=7900 connectaddress=<WSL2_IP>`
- [ ] Provides a PowerShell command to allow the port through Windows Firewall
- [ ] Documents the fallback: if mDNS doesn't work, use `bun cli.ts federation connect <windows_host_ip>:7900` from the remote machine

#### US-C02: Detect WSL2 environment and provide guidance

**Description:** As a WSL2 user starting federation, I want the federation agent to detect WSL2 and provide setup guidance so that I don't have to search for workarounds.

**Acceptance Criteria:**
- [ ] On federation startup, detect WSL2 by checking for `/proc/sys/fs/binfmt_misc/WSLInterop` or `WSL_DISTRO_NAME` env var
- [ ] If WSL2 detected, log: `[CPM-federation] WSL2 detected. LAN peers must connect to your Windows host IP, not the WSL2 internal IP.`
- [ ] Detect the Windows host IP by reading `/etc/resolv.conf` nameserver (standard WSL2 pattern) or running `ip route show default`
- [ ] Log: `[CPM-federation] Windows host IP appears to be <ip>. Remote machines should connect to <ip>:<port>.`
- [ ] Log: `[CPM-federation] If connections fail, set up Windows port forwarding: netsh interface portproxy add v4tov4 listenport=<port> listenaddress=0.0.0.0 connectport=<port> connectaddress=<wsl2_ip>`
- [ ] CLI `federation status` includes WSL2 guidance if WSL2 is detected

#### US-C03: macOS firewall documentation

**Description:** As a macOS user, I want documentation on allowing federation through the macOS firewall.

**Acceptance Criteria:**
- [ ] README section documents: macOS may prompt to allow incoming connections when federation starts
- [ ] Provides manual firewall command: `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /path/to/bun --unblockapp /path/to/bun`
- [ ] Notes that Bonjour/mDNS works natively on macOS -- no additional setup needed for auto-discovery

## Functional Requirements

- **FR-1**: `federation.ts` is a new file (~300-500 lines) containing: TLS server, PSK authentication, peer list sync, message relay, mDNS advertisement/discovery (Phase B), subnet filtering, HMAC signing/verification.
- **FR-2**: The federation agent is started by the broker process when `CLAUDE_PEERS_FEDERATION_ENABLED=true`. It runs in the same process (not a separate daemon) to simplify lifecycle management.
- **FR-3**: The federation agent maintains an in-memory `Map<string, RemoteMachine>` where each `RemoteMachine` contains: host, port, hostname, TLS socket/connection, last_sync timestamp, and a list of remote peers.
- **FR-4**: Remote peer IDs are namespaced as `<hostname>:<original_id>` to prevent ID collisions across machines. The colon is not a valid character in the 8-char alphanumeric local IDs, making this unambiguous.
- **FR-5**: The MCP server (`server.ts`) detects remote peer IDs by checking for the colon separator. Messages to remote peers are routed to the federation agent via a new local endpoint (`POST /federation/send-to-remote`) rather than calling the remote directly -- the MCP server never makes outbound LAN connections.
- **FR-6**: Federation configuration is read from environment variables only (no config file). This keeps it simple and consistent with the existing CLAUDE_PEERS_PORT / CLAUDE_PEERS_DB pattern.
- **FR-7**: PSK for federation is the same token as `~/.claude-peers-token`. Both machines in a federation MUST share the same token. Token distribution is manual and out-of-band (user copies the token file to the remote machine).
- **FR-8**: TLS certificates are per-machine and self-signed. Certificate validation is NOT enforced (self-signed certs are expected). Security relies on PSK authentication and HMAC signing, not certificate trust chains.
- **FR-9**: Liveness checking for remote peers uses `last_seen` timestamp freshness (from periodic sync) rather than PID checks (which don't work cross-machine). A remote peer not seen in the last 90 seconds is considered stale and removed.
- **FR-10**: Rate limiting on federation endpoints uses a separate bucket from the local `/send-message` limit. Federation relay is trusted (already PSK-authenticated) and gets a higher limit: 300 req/min per remote host.
- **FR-11**: The `broadcast_message` tool (from prd-structured-messages.md) is extended to support `scope="lan"`. When used, the local broadcast is sent normally AND the federation agent relays the broadcast to each connected remote machine's `/federation/relay` endpoint with `to_id: "*"` (broadcast sentinel). The remote federation agent then calls the remote broker's `/broadcast` endpoint.
- **FR-12**: All federation endpoints on the broker (`/federation/peers`, `/federation/relay`) are only registered when `CLAUDE_PEERS_FEDERATION_ENABLED=true`. When federation is disabled, these paths return 404.
- **FR-13**: Cross-machine message delivery is best-effort with retry. If a relay to a remote fails, the error is returned to the sender immediately (no queuing). The sender can retry manually.

## Non-Goals (Out of Scope)

- **NG-1**: Internet/WAN connectivity. Federation is strictly LAN-only. No NAT traversal, STUN/TURN, or relay servers.
- **NG-2**: Per-peer authentication or authorization. All peers on a federated network share one PSK. No per-user or per-session access control.
- **NG-3**: Persistent federation state. Connected remotes are in-memory only. After broker restart, federation connections must be re-established (manually or via mDNS re-discovery).
- **NG-4**: Message queuing for offline remote machines. If a remote is unreachable, the message fails immediately. No store-and-forward.
- **NG-5**: Automatic token distribution. Users must manually copy `~/.claude-peers-token` to remote machines. Secure token exchange protocols (e.g., SRP, QR code) are future work.
- **NG-6**: GUI or TUI for federation management. CLI only.
- **NG-7**: IPv6 support. LAN federation assumes IPv4 subnets. IPv6 link-local support is future work.
- **NG-8**: Windows native support (non-WSL2). Only WSL2 and macOS/Linux are supported.
- **NG-9**: Changes to the auto-summary system (`shared/summarize.ts`).
- **NG-10**: `server.test.ts` (MCP server tests). Remains a separate backlog item.
- **NG-11**: mDNS reflector implementation for WSL2. This is a Windows-side concern documented in US-C01/C02, not implemented by this project.
- **NG-12**: Certificate Authority (CA) or mutual TLS (mTLS). Self-signed certs with PSK auth are sufficient for LAN use.

## Technical Considerations

### File Paths (all in `/home/riche/MCPs/claude-peers-mcp/`)

| File | Phase | Changes |
|------|-------|---------|
| `federation.ts` | A | **New file.** TLS server, PSK auth, peer sync, message relay, subnet filtering, HMAC signing. ~300-500 lines. |
| `broker.ts` | A | Add `/federation/peers` and `/federation/relay` endpoints (guarded by `CLAUDE_PEERS_FEDERATION_ENABLED`). Start federation agent when enabled. ~50-80 new lines. |
| `shared/types.ts` | A | Add `FederationConfig`, `RemotePeer`, `FederationHandshakeRequest`, `FederationRelayRequest`, `FederationPeersResponse` types. Extend `ListPeersRequest.scope` with `"lan"`. ~40 new lines. |
| `server.ts` | A | Detect remote peer IDs in `send_message` handler and route through federation. Add `"lan"` scope to `list_peers`. Update MCP instructions. ~30-50 new lines. |
| `cli.ts` | A | Add `federation` subcommand with `status`, `connect`, `disconnect`. Update help text. ~60-80 new lines. |
| `federation.test.ts` | A | **New file.** 12+ federation tests. Two federation agents, bidirectional communication. ~300-400 lines. |
| `federation.ts` | B | Add mDNS advertisement via `bonjour-service` or `multicast-dns`. Add mDNS discovery listener with psk_hash pre-filtering. ~80-120 new lines. |
| `README.md` | C | WSL2 federation setup section, macOS firewall docs. |

### Environment Variables (all new, federation-specific)

| Env Var | Default | Phase | Description |
|---------|---------|-------|-------------|
| `CLAUDE_PEERS_FEDERATION_ENABLED` | `false` | A | Master switch for federation. Must be `"true"` to enable. |
| `CLAUDE_PEERS_FEDERATION_PORT` | `7900` | A | TLS port for federation agent (LAN-facing). |
| `CLAUDE_PEERS_FEDERATION_SUBNET` | auto-detect /24 | A | CIDR subnet to accept connections from. |
| `CLAUDE_PEERS_FEDERATION_CERT` | `~/.claude-peers-federation.crt` | A | Path to TLS certificate (auto-generated if missing). |
| `CLAUDE_PEERS_FEDERATION_KEY` | `~/.claude-peers-federation.key` | A | Path to TLS private key (auto-generated if missing). |

### New Types in `shared/types.ts`

```typescript
export interface FederationConfig {
  enabled: boolean;
  port: number;
  subnet: string; // CIDR notation, e.g., "192.168.1.0/24"
  certPath: string;
  keyPath: string;
}

export interface RemotePeer {
  id: string;           // hostname:original_id
  machine: string;      // hostname or IP
  cwd: string;
  git_root: string | null;
  session_name: string;
  summary: string;
  last_seen: string;    // ISO timestamp
}

export interface FederationHandshakeRequest {
  psk: string;          // The pre-shared key (token)
  hostname: string;     // Sender's hostname
  version: string;      // Broker version
}

export interface FederationRelayRequest {
  from_id: string;      // hostname:peer_id (namespaced)
  from_machine: string; // hostname of sending machine
  to_id: string;        // local peer_id (or "*" for broadcast)
  text: string;
  type?: string;        // MessageType from prd-structured-messages
  metadata?: Record<string, unknown>;
  reply_to?: number;
  signature: string;    // HMAC-SHA256 of body
}

export interface FederationPeersResponse {
  hostname: string;
  peers: Peer[];        // Local peers (using existing Peer type)
}
```

### TLS in Bun

Bun's `Bun.serve()` supports TLS natively:

```typescript
Bun.serve({
  port: federationPort,
  hostname: "0.0.0.0",
  tls: {
    cert: Bun.file(certPath),
    key: Bun.file(keyPath),
  },
  fetch(req) { /* ... */ }
});
```

For self-signed cert generation, Bun does not have a built-in API. Options:
1. Shell out to `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=$(hostname)"`
2. Use the `@peculiar/x509` npm package (pure JS, Bun-compatible)
3. Use `node:crypto` `generateKeyPairSync` + manual X.509 encoding

Recommendation: shell out to `openssl` (simplest, universally available on Linux/macOS/WSL2). Fall back to `@peculiar/x509` if `openssl` is not found.

### WSL2 Networking Details

- WSL2's virtual network adapter gets an IP like `172.17.x.x` which is NOT reachable from the LAN
- The Windows host IP (LAN-visible) can be found from WSL2 via: `cat /etc/resolv.conf | grep nameserver | awk '{print $2}'`
- WSL2's own IP: `hostname -I | awk '{print $1}'`
- Port forwarding from Windows to WSL2: `netsh interface portproxy add v4tov4 listenport=7900 listenaddress=0.0.0.0 connectport=7900 connectaddress=<WSL2_IP>`
- Windows Firewall rule: `New-NetFirewallRule -DisplayName "Claude Peers Federation" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7900`
- mDNS: WSL2 cannot advertise mDNS services visible on the LAN without a Windows-side reflector. This is a known WSL2 limitation. The workaround is manual IP configuration.

### Federation Agent Lifecycle

The federation agent is NOT a separate process. It runs inside the broker process:

```
broker.ts startup:
  1. Token generation/loading
  2. Database setup + migrations
  3. Stale peer cleanup
  4. Start HTTP server (localhost:7899)
  5. IF CLAUDE_PEERS_FEDERATION_ENABLED=true:
     a. Load/generate TLS cert+key
     b. Start federation TLS server (0.0.0.0:7900)
     c. Start peer sync interval (30s)
     d. [Phase B] Start mDNS advertisement and discovery
  6. Start token re-read interval (60s)
```

### Cross-Machine Message Routing Flow

```
Session A1 (Machine A) sends to peer rafi-mac:b2c3d4e5 (Machine B):

1. MCP server A1 calls send_message(to_id="rafi-mac:b2c3d4e5", message="hello")
2. server.ts detects colon in to_id -> remote peer
3. server.ts calls local broker POST /federation/send-to-remote
   { to_id: "rafi-mac:b2c3d4e5", from_id: "riche-wsl:a1b2c3d4", text: "hello" }
4. Local broker routes to federation agent
5. Federation agent:
   a. Looks up which remote machine owns "rafi-mac:*"
   b. Computes HMAC-SHA256 signature of request body
   c. POST /federation/relay to Machine B's federation agent (TLS + PSK header + signature)
6. Machine B federation agent:
   a. Validates PSK
   b. Validates HMAC signature
   c. Extracts local peer_id "b2c3d4e5" from namespaced ID
   d. POST /send-message to local broker (localhost, bearer token)
   e. { from_id: "riche-wsl:a1b2c3d4", to_id: "b2c3d4e5", text: "hello" }
7. Machine B broker inserts message
8. Machine B MCP server B1 polls, gets message, pushes channel notification
9. Session B1 sees the message with from_machine="riche-wsl"
```

### HMAC Signature Computation

```typescript
import { createHmac } from "crypto";

function signMessage(body: object, psk: string): string {
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  return createHmac("sha256", psk).update(canonical).digest("hex");
}

function verifySignature(body: object, signature: string, psk: string): boolean {
  const expected = signMessage(body, psk);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

### Test Infrastructure for `federation.test.ts`

Tests need two independent federation agents to test bidirectional communication:

```
beforeAll:
  1. Generate test PSK -> /tmp/claude-peers-test-token
  2. Generate two TLS cert/key pairs (or one shared pair)
  3. Start Broker A on port 17899 with federation on port 17900
  4. Start Broker B on port 17901 with federation on port 17902
  5. Both use same PSK but separate SQLite DBs
  6. Register test peers on each broker

afterAll:
  1. Kill both broker processes
  2. Clean up temp files (DBs, tokens, certs)
```

## Success Metrics

| Metric | Target | Phase |
|--------|--------|-------|
| Federation agent starts and accepts TLS connections | Verified in test | A |
| PSK handshake succeeds with matching tokens | Verified in test | A |
| PSK handshake fails with mismatched tokens | Verified in test | A |
| Peer list sync populates remote peer cache | Verified in test | A |
| `list_peers(scope="lan")` returns both local and remote peers | Verified in test | A |
| Cross-machine message delivery via federation relay | Verified in test | A |
| HMAC signature validated on relay | Verified in test | A |
| Subnet restriction blocks out-of-range IPs | Verified in test | A |
| Existing 19+ tests pass unchanged | All green | A |
| New federation tests pass | 12+ tests green | A |
| mDNS service advertised on LAN | Manual verification | B |
| mDNS auto-discovery connects peers | Manual verification | B |
| mDNS tests pass | 5+ tests green | B |
| WSL2 port forwarding documented and verified | Manual verification | C |
| macOS firewall documented and verified | Manual verification | C |
| Two-machine end-to-end test (Riche WSL2 + Rafi Mac) | Manual verification | A-C |

## Phased Implementation Plan

### Phase A: Manual Federation (Target: 1-2 Ralph runs)

**Scope:** US-A01 through US-A12. Connect machines by IP, PSK auth, TLS encryption, peer sync, message routing, subnet restriction, HMAC signing, federation tests.

**Ralph guidance:**
- Start with `federation.ts` (new file, core TLS server + PSK auth + peer sync)
- Then modify `broker.ts` (add federation endpoints)
- Then modify `shared/types.ts` (new types)
- Then modify `server.ts` (LAN scope + remote peer routing)
- Then modify `cli.ts` (federation subcommand)
- Finally write `federation.test.ts`
- Run `bun test` to verify all existing + new tests pass

**Deep research needed before implementation:**
- Bun's TLS server API: verify `Bun.serve()` TLS options, client certificate handling, connection metadata (remote IP)
- Self-signed cert generation: test `openssl` shellout approach in Bun
- Subnet detection: test `os.networkInterfaces()` in Bun for auto-detect
- HMAC in Bun: verify `node:crypto` createHmac availability

### Phase B: mDNS Auto-Discovery (Target: 1 Ralph run)

**Scope:** US-B01 through US-B03. mDNS announcement and discovery.

**Ralph guidance:**
- Install mDNS library: `bun install bonjour-service` (or `multicast-dns`)
- Test library compatibility with Bun before integrating
- Add mDNS to `federation.ts`
- Write mDNS tests in `federation.test.ts`
- Run `bun test`

**Deep research needed:**
- `bonjour-service` vs `multicast-dns` Bun compatibility
- mDNS behavior on macOS vs Linux
- Whether mDNS tests can run in CI without a real network

### Phase C: WSL2 Workarounds + Documentation (Target: 1 Ralph run)

**Scope:** US-C01 through US-C03. Documentation and WSL2 detection.

**Ralph guidance:**
- Mostly documentation changes to README.md
- Small code additions to `federation.ts` for WSL2 detection
- Manual testing required on actual WSL2 + Mac setup

## Definition of Done

All three phases are "done" when:

1. [ ] All existing tests (19+ broker tests, auth tests, structured message tests) pass without modification
2. [ ] 12+ federation tests pass in `federation.test.ts` (Phase A)
3. [ ] 5+ mDNS tests pass in `federation.test.ts` (Phase B)
4. [ ] `list_peers(scope="lan")` returns remote peers from a connected machine (manual verification)
5. [ ] `send_message` to a remote peer delivers the message successfully (manual verification)
6. [ ] `broadcast_message(scope="lan")` reaches peers on remote machines (manual verification)
7. [ ] Federation with wrong PSK is rejected (manual verification)
8. [ ] Connection from outside configured subnet is rejected (manual verification)
9. [ ] WSL2 federation setup documentation is complete and verified (Phase C)
10. [ ] macOS firewall documentation is complete (Phase C)
11. [ ] `bun cli.ts federation status` shows connected remotes and remote peer count
12. [ ] FYI.md updated with federation implementation decisions
13. [ ] CLAUDE.md updated with federation architecture notes
14. [ ] No secrets (tokens, keys) logged in broker.log or server.log

Phase A alone constitutes a usable MVP. Phases B and C are enhancements that can be deferred if Phase A meets the user's immediate needs.

## Open Questions

1. **mDNS library choice**: `bonjour-service` vs `multicast-dns` vs `dns-sd` CLI shelling. Need to test Bun compatibility before committing. `bonjour-service` is higher-level (simpler API) but may have Node.js-specific dependencies. `multicast-dns` is lower-level but more portable. Recommendation: test both in a spike before Phase B implementation.

2. **WSL2 mDNS reflector**: Is there a lightweight Windows-side mDNS reflector that can make WSL2 services visible on the LAN? Options include `mdns-repeater` and Windows built-in mDNS support. This needs investigation but is out of scope for implementation (documented workaround only).

3. **Shared PSK vs separate federation key**: The PRD uses `~/.claude-peers-token` as both the bearer token (localhost) and the PSK (LAN). Should they be separate? A single shared secret simplifies setup (copy one file to remote machine) but means compromising the token grants both local and LAN access. Recommendation: single token for simplicity. Separate keys are future work if the threat model changes.

4. **Federation agent in-process vs separate process**: The PRD specifies in-process (federation runs inside broker). This simplifies lifecycle but means a federation bug can crash the broker. Alternative: separate `bun federation.ts` daemon. Recommendation: start in-process for simplicity, extract to separate process if stability issues emerge.

5. **Remote peer ID format**: The PRD uses `hostname:peer_id` (e.g., `rafi-mac:a1b2c3d4`). If hostnames contain colons (unlikely but possible in some network configs), this is ambiguous. Alternative: use `hostname/peer_id` or `hostname#peer_id`. Recommendation: use colon -- hostnames with colons are exotic edge cases not worth optimizing for.

6. **Bun TLS client connections**: The federation agent needs to make outgoing TLS connections to remote federation agents. Verify that `fetch()` in Bun supports custom TLS options (self-signed cert acceptance, client PSK headers) when connecting to `https://` endpoints. If not, use `Bun.connect()` with TLS options. Needs verification in a spike.

7. **Broadcast relay fan-out**: When `scope="lan"` broadcast is sent, the local federation agent relays to N remote machines, each of which creates M messages locally. For a 3-machine federation with 5 peers each, one broadcast creates ~12 messages (4 local + 4+4 remote). Is this acceptable? Recommendation: yes, for typical LAN setups (2-5 machines). Add a warning log if broadcast fan-out exceeds 50 messages.

8. **Subnet auto-detection reliability**: `os.networkInterfaces()` may return multiple interfaces (VPN, Docker, WSL2 virtual). Which one is the "primary" LAN interface? Recommendation: use the interface associated with the default route (`ip route show default` on Linux, `route get default` on macOS). Fall back to manual `CLAUDE_PEERS_FEDERATION_SUBNET` if auto-detect gives wrong results.
