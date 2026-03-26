# PRD-003: mDNS Auto-Discovery for LAN Federation

**Status:** Draft
**Author:** Riche / Claude
**Created:** 2026-03-26
**Phase:** B (builds on Phase A manual federation, shipped in v0.3.0)
**Priority:** High — eliminates the largest UX friction in LAN federation

---

## 1. Introduction

### What is mDNS?

Multicast DNS (mDNS) is a zero-configuration networking protocol that resolves hostnames and discovers services on a local network without a central DNS server. It is the foundation of Apple's Bonjour and Linux's Avahi. When a service advertises itself via mDNS, other devices on the same LAN subnet automatically see it within seconds — no IP addresses, no manual configuration, no central registry.

mDNS works by sending DNS queries and responses over multicast UDP (224.0.0.251:5353). Services register themselves with a type string (e.g., `_http._tcp`, `_ssh._tcp`) and publish TXT records containing key-value metadata. Any device on the subnet listening for that service type receives the announcement.

### Why It Matters for claude-peers

Phase A federation (v0.3.0) proved that cross-machine Claude Code collaboration works: TLS transport, PSK authentication, HMAC-signed message relay, and periodic peer sync all function correctly. However, the connection workflow requires users to:

1. Know the remote machine's IP address
2. Ensure the PSK token is copied to both machines
3. Run `bun src/cli.ts federation connect <ip>:<port>` on one or both sides
4. Re-run the connect command if IPs change (DHCP lease renewal, laptop moves between networks)

This is acceptable for a two-person team on a static network, but falls apart at three or more machines, on networks with DHCP churn, or for users who cannot easily determine their IP. mDNS eliminates steps 1, 3, and 4 entirely — machines find each other automatically and reconnect when network conditions change.

### Relationship to Phase A

This PRD extends the existing federation infrastructure. Phase A established:

- **Federation agent**: A second `Bun.serve()` TLS server on port 7900 (in-process with the broker)
- **Remote peer registry**: In-memory `Map<string, RemoteMachine>` with 30s periodic sync
- **Authentication**: PSK token at `~/.claude-peers-token` validated via header + HMAC
- **Transport**: HTTPS with self-signed RSA-2048 certificates
- **CLI commands**: `federation connect`, `disconnect`, `status`, `setup`, `enable`, `disable`
- **Config persistence**: `~/.claude-peers-config.json` with federation section

Phase B adds an mDNS layer that automatically triggers `federation connect` when compatible peers appear, and `federation disconnect` when they vanish. The existing federation transport, auth, and sync mechanisms are reused unchanged.

---

## 2. Goals

| # | Goal | Measurable Outcome |
|---|------|--------------------|
| G1 | **Zero-config discovery** | Two machines on the same LAN with matching PSK tokens auto-connect within 60 seconds of broker startup, with zero user intervention |
| G2 | **Graceful reconnection** | When a machine leaves and re-joins the network (DHCP renewal, sleep/wake), federation re-establishes within 90 seconds |
| G3 | **PSK pre-filtering** | Machines with different PSK tokens never attempt a TLS handshake — filtered at the mDNS TXT record level via PSK hash comparison |
| G4 | **Platform coverage** | Works natively on macOS (Bonjour) and Linux; degrades gracefully on WSL2 with clear user messaging |
| G5 | **No new mandatory dependencies** | mDNS is opt-in; manual federation continues to work without the mDNS package installed |
| G6 | **Coexistence with manual connections** | Manual `federation connect` still works alongside mDNS; manually-connected peers are not evicted by mDNS logic |

---

## 3. User Stories

### US-001: Advertise Federation Presence via mDNS

**As a** user with federation enabled,
**I want** my broker to advertise a `_claude-peers._tcp` mDNS service on the LAN,
**So that** other claude-peers brokers on the same network can discover me without knowing my IP.

#### Acceptance Criteria

- When the federation TLS server starts successfully, register an mDNS service advertisement with:
  - **Service type**: `_claude-peers._tcp`
  - **Port**: The federation port (default 7900, configurable)
  - **Name**: The machine's hostname (from `getMachineHostname()`)
  - **TXT records**:
    - `psk_hash=<first 8 hex chars of SHA-256(PSK token)>` — for pre-filtering without exposing the full token
    - `version=1.0.0` — protocol version for compatibility checks
    - `hostname=<machine hostname>` — human-readable name
    - `broker_port=<broker port>` — informational (not used for federation transport)
- The advertisement is removed (un-published) when the broker shuts down (graceful exit via SIGINT/SIGTERM)
- If mDNS advertisement fails (e.g., library not installed, permission error), log a warning and continue without mDNS — federation still works via manual connect
- The mDNS service name must be unique per machine. If two brokers somehow run on the same host, the second should detect the collision and skip advertising

#### Technical Notes

- The `psk_hash` is a truncated SHA-256 hash (8 hex chars = 32 bits of entropy). This is sufficient for pre-filtering (not security — PSK validation happens at the TLS handshake layer). The purpose is to avoid unnecessary connection attempts between machines with different PSKs.
- Service type `_claude-peers._tcp` follows the DNS-SD naming convention: underscore prefix, descriptive name, underscore protocol.

---

### US-002: Discover Remote Federation Agents via mDNS Listener

**As a** user with federation enabled,
**I want** my broker to listen for `_claude-peers._tcp` mDNS announcements on the LAN,
**So that** I can see available peers without manually scanning IP ranges.

#### Acceptance Criteria

- On federation startup, begin browsing for `_claude-peers._tcp` services via mDNS
- When a new service is discovered:
  - Extract the IP address (prefer IPv4), port, and TXT records from the announcement
  - Log the discovery: `[CPM-federation] mDNS: discovered <hostname> at <ip>:<port>`
  - Compare `psk_hash` from the TXT record against the local PSK hash
  - If hashes match, trigger auto-connect (see US-003)
  - If hashes do not match, log: `[CPM-federation] mDNS: skipping <hostname> (PSK mismatch)` and take no action
- When a service disappears (goodbye packet or TTL expiry):
  - Log the departure: `[CPM-federation] mDNS: <hostname> left the network`
  - Do NOT auto-disconnect — the existing federation sync timer (30s interval, 90s stale timeout) handles cleanup naturally. This avoids flapping on transient multicast packet loss.
- Ignore announcements from the local machine (compare advertised hostname or IP to local values)
- The mDNS browser must handle duplicate announcements gracefully (same host re-advertising after network change) — do not attempt duplicate connections

#### Technical Notes

- mDNS announcements include both IPv4 and IPv6 addresses. Since federation currently only supports IPv4 (hostnames with colons are rejected), filter for A records only.
- Service discovery events may arrive in bursts at startup (backlog of cached announcements). Use a debounce/dedup map keyed by `host:port` with a 5-second cooldown to avoid hammering the handshake endpoint.

---

### US-003: Auto-Connect to Discovered Peers with Matching PSK Hash

**As a** user with federation enabled and mDNS active,
**I want** my broker to automatically establish federation connections when it discovers a compatible peer via mDNS,
**So that** I never have to run `federation connect` manually.

#### Acceptance Criteria

- When US-002 discovers a peer with a matching `psk_hash`:
  1. Check if already connected to that `host:port` in the `remoteMachines` map — if yes, skip
  2. Call the existing `handleFederationConnect({ host, port })` function (reuse Phase A logic entirely)
  3. If connection succeeds, log: `[CPM-federation] mDNS: auto-connected to <hostname> at <ip>:<port> (<N> remote peers)`
  4. If connection fails (PSK mismatch at TLS level, unreachable, timeout), log the failure and add the host to a backoff list
- **Backoff strategy**: On connection failure, wait 30 seconds before retrying that host. After 3 consecutive failures, wait 5 minutes. After 10 failures, stop retrying and log: `[CPM-federation] mDNS: giving up on <hostname> after 10 failures — use 'federation connect' manually`
- Auto-connected peers are indistinguishable from manually-connected peers in `federation status` output. The only difference is a `source: "mdns" | "manual"` field in the `RemoteMachine` type for diagnostic purposes.
- When the mDNS browser detects a service update (same host, new IP due to DHCP), disconnect from the old IP and reconnect to the new one

#### Technical Notes

- The `handleFederationConnect` function in `broker.ts` (line ~726) already handles the full connect flow: TLS handshake, PSK validation, peer list fetch, and `remoteMachines` map insertion. mDNS auto-connect is just an automated caller of this existing function.
- The backoff state should be in-memory only (no persistence needed). A `Map<string, { failures: number; nextRetryAt: number }>` is sufficient.

---

### US-004: Graceful Degradation on WSL2

**As a** user running Claude Code on WSL2,
**I want** clear feedback when mDNS is unavailable,
**So that** I understand why auto-discovery does not work and know to use manual federation instead.

#### Acceptance Criteria

- At federation startup, before initializing mDNS, detect the runtime environment:
  - **WSL2 NAT mode** (default): mDNS is completely non-functional. Multicast packets from the WSL2 VM never reach the Windows host network. Detection: `isWSL2()` returns true AND the default route interface is `eth0` with a 172.x.x.x address.
  - **WSL2 mirrored mode**: mDNS is theoretically possible but has known bugs with multicast in Windows builds prior to 24H2. Detection: `isWSL2()` returns true AND default route uses `loopback0` or the interface IP matches the Windows LAN IP.
  - **Native Linux**: mDNS should work if Avahi or systemd-resolved is running.
  - **macOS**: mDNS works natively via Bonjour (always available).
- On **WSL2 NAT mode**: Skip mDNS initialization entirely. Log: `[CPM-federation] mDNS: WSL2 NAT mode detected — multicast not available. Use 'federation connect <ip>:<port>' for manual connections.`
- On **WSL2 mirrored mode**: Attempt mDNS initialization with a 10-second validation timeout. If no self-announcement is received within 10s, log a warning and disable mDNS: `[CPM-federation] mDNS: WSL2 mirrored mode — multicast appears non-functional. Falling back to manual federation.`
- On **native Linux**: If the mDNS library fails to bind (e.g., port 5353 in use by Avahi), log the error and continue without mDNS
- On **macOS**: Initialize mDNS unconditionally; Bonjour is always available
- In all degradation cases, manual `federation connect` continues to work normally
- `federation status` CLI output includes an `mdns:` field showing the mDNS state: `active`, `disabled (WSL2 NAT)`, `disabled (multicast unavailable)`, `disabled (library not installed)`, or `disabled (user opt-out)`

#### Technical Notes

- The existing `isWSL2()` function in `federation.ts` (line 126) already detects WSL2. Extend it with NAT vs. mirrored mode detection by checking the default route:
  - NAT mode: `ip route show default` returns `dev eth0` with gateway in 172.x.x.x range
  - Mirrored mode: `ip route show default` returns a different interface or the gateway is on the LAN subnet
- WSL2 mirrored networking (`networkingMode=mirrored` in `.wslconfig`) was introduced in Windows 11 23H2. Even with mirrored mode, multicast reliability varies by Windows build. The 10-second self-test provides empirical verification rather than relying on version detection.

---

### US-005: mDNS-Specific Test Suite

**As a** developer maintaining claude-peers,
**I want** comprehensive tests for the mDNS discovery layer,
**So that** regressions are caught before they reach users.

#### Acceptance Criteria

- Create `mdns.test.ts` with the following test categories:

**Unit Tests (mocked mDNS, no network required)**:
1. `psk_hash` generation produces consistent 8-char hex output for the same PSK
2. `psk_hash` differs for different PSK values
3. TXT record parsing extracts psk_hash, version, and hostname correctly
4. Self-announcement filtering correctly ignores local machine's own advertisements
5. Dedup map prevents duplicate connection attempts within the 5-second cooldown
6. Backoff logic: first failure waits 30s, third failure waits 5 minutes, tenth failure gives up
7. IPv6 addresses are filtered out (only IPv4 used)
8. Service disappearance does NOT trigger auto-disconnect
9. WSL2 NAT mode detection correctly identifies 172.x.x.x gateway
10. WSL2 mirrored mode detection correctly identifies loopback0 interface
11. mDNS initialization failure does not throw — logs warning and returns gracefully

**Integration Tests (require mDNS capability on the test host)**:
12. Service advertisement is published and can be browsed by a second instance
13. Service TXT records are readable by browser
14. Service un-publish on shutdown removes the advertisement
15. Auto-connect is triggered when a matching psk_hash service appears
16. Auto-connect is NOT triggered when psk_hash mismatches

- All unit tests must run in CI without network access (fully mocked)
- Integration tests are gated behind a `MDNS_INTEGRATION=1` environment variable (skipped by default)
- Target: 11 unit tests + 5 integration tests = 16 tests minimum

#### Technical Notes

- The mDNS library should be abstracted behind an interface (`MdnsProvider`) so that tests can inject a mock implementation. This also supports future alternative discovery mechanisms (e.g., UDP broadcast fallback for WSL2).
- Test structure follows existing patterns: `broker.test.ts` (40 tests), `cli.test.ts` (17 tests), `server.test.ts` (18 tests).

---

### US-006: Configuration and User Controls

**As a** user who wants control over auto-discovery behavior,
**I want** to enable, disable, and configure mDNS via config file and CLI,
**So that** I can opt out of multicast traffic or adjust settings for my network.

#### Acceptance Criteria

- Add `mdns` section to `~/.claude-peers-config.json`:
  ```json
  {
    "federation": {
      "enabled": true,
      "port": 7900,
      "subnet": "0.0.0.0/0",
      "mdns": {
        "enabled": true,
        "interface": null
      }
    }
  }
  ```
- `federation.mdns.enabled` defaults to `true` when federation is enabled (opt-out, not opt-in)
- `federation.mdns.interface` allows binding mDNS to a specific network interface (null = all interfaces). Useful on multi-homed machines or VPN setups.
- Environment variable override: `CLAUDE_PEERS_MDNS_ENABLED=false` disables mDNS regardless of config file
- CLI commands:
  - `bun src/cli.ts federation mdns enable` — enable mDNS in config
  - `bun src/cli.ts federation mdns disable` — disable mDNS in config
  - `bun src/cli.ts federation mdns status` — show mDNS state, discovered services, and any errors
- `federation status` output updated to include mDNS status (as specified in US-004)

---

### US-007: Discovery Event Logging and Observability

**As a** user debugging federation connectivity issues,
**I want** mDNS events logged to the existing `cpm-logs/` directory,
**So that** I can trace discovery, connection, and failure events.

#### Acceptance Criteria

- All mDNS log lines use the existing `federationLog()` function with prefix `mDNS:` for easy grep filtering
- Events logged:
  - Service published: `mDNS: advertising _claude-peers._tcp on port <port> (psk_hash=<hash>)`
  - Service discovered: `mDNS: discovered <hostname> at <ip>:<port> (psk_hash=<hash>)`
  - PSK mismatch: `mDNS: skipping <hostname> (PSK mismatch: local=<hash> remote=<hash>)`
  - Auto-connect triggered: `mDNS: auto-connecting to <hostname> at <ip>:<port>`
  - Auto-connect success: `mDNS: auto-connected to <hostname> (<N> remote peers)`
  - Auto-connect failure: `mDNS: failed to connect to <hostname>: <error> (attempt <N>/<max>)`
  - Backoff active: `mDNS: backing off <hostname> — next retry in <seconds>s`
  - Gave up: `mDNS: giving up on <hostname> after <N> failures`
  - Service departed: `mDNS: <hostname> left the network`
  - Self-ignored: `mDNS: ignoring self-announcement`
  - Shutdown: `mDNS: un-publishing service`
- All logs go to both stderr and `cpm-logs/federation.log` (same as existing federation logs)

---

## 4. Technical Design

### 4.1 Package Selection

Two npm packages are viable for mDNS in Bun:

| Package | npm Weekly Downloads | Bun Compatibility | API Style | Last Updated |
|---------|---------------------|-------------------|-----------|--------------|
| `bonjour-service` | ~300K | Good (pure JS, no native addons) | High-level: `publish()`, `find()` | Active (2025) |
| `multicast-dns` | ~2M | Good (pure JS dgram sockets) | Low-level: raw DNS packets | Active (2025) |

**Recommendation: `bonjour-service`**

Rationale:
1. **Higher-level API** — `publish()` and `find()` map directly to our use case (advertise + browse). `multicast-dns` requires manually constructing DNS response packets, TXT record encoding, and handling PTR/SRV/A record types.
2. **TXT record support** — Built-in TXT record key-value parsing. `multicast-dns` returns raw buffers that need manual decoding.
3. **Service lifecycle management** — Handles goodbye packets, TTL refresh, and service name collision resolution automatically.
4. **Pure JavaScript** — No native addons, so it works with Bun without node-gyp compilation issues.
5. **Bun dgram compatibility** — Both packages use Node.js `dgram` module for UDP sockets. Bun's `dgram` implementation is stable (not marked experimental since Bun 1.1).

**Fallback consideration**: If `bonjour-service` proves problematic in testing, `multicast-dns` is a solid alternative with a larger install base, at the cost of more boilerplate code.

**Installation**: `bun add bonjour-service` (production dependency, ~50KB gzipped)

### 4.2 Architecture

```
                     Existing (Phase A)              New (Phase B)
                  +-----------------------+      +-------------------+
                  |   broker.ts           |      |   mdns.ts         |
                  |                       |      |                   |
                  |   Federation TLS      |<-----| MdnsManager       |
                  |   Server (port 7900)  |      |   .advertise()    |
                  |                       |      |   .browse()       |
                  |   remoteMachines Map  |<-----+   .stop()         |
                  |                       |      |                   |
                  |   handleFedConnect()  |<-----| onServiceUp()     |
                  |                       |      | onServiceDown()   |
                  |   syncRemotePeers()   |      |                   |
                  +-----------------------+      +-------------------+
                                                        |
                                                        v
                                                 +-------------------+
                                                 | bonjour-service   |
                                                 | (npm package)     |
                                                 +-------------------+
                                                        |
                                                        v
                                                 +-------------------+
                                                 | UDP multicast     |
                                                 | 224.0.0.251:5353  |
                                                 +-------------------+
```

### 4.3 New File: `src/mdns.ts`

A new module encapsulating all mDNS logic, exporting a single `MdnsManager` class:

```typescript
interface MdnsProvider {
  advertise(config: MdnsAdvertiseConfig): void;
  browse(type: string, onUp: ServiceCallback, onDown: ServiceCallback): void;
  stop(): void;
}

interface MdnsAdvertiseConfig {
  name: string;           // machine hostname
  type: string;           // "_claude-peers._tcp"
  port: number;           // federation port
  txt: Record<string, string>;  // psk_hash, version, hostname
}

interface MdnsManagerConfig {
  federationPort: number;
  pskToken: string;
  localHostname: string;
  onPeerDiscovered: (host: string, port: number, hostname: string) => Promise<void>;
  onPeerDeparted: (hostname: string) => void;
  provider?: MdnsProvider;  // injectable for testing
}

class MdnsManager {
  constructor(config: MdnsManagerConfig);
  async start(): Promise<boolean>;   // returns false if mDNS unavailable
  stop(): void;
  getStatus(): MdnsStatus;
}
```

### 4.4 PSK Hash Pre-Filtering

The PSK token (stored at `~/.claude-peers-token`) is a sensitive credential. It must never be broadcast over multicast. Instead, a truncated hash is published in the TXT record:

```typescript
import { createHash } from "node:crypto";

function pskHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}
```

**Security analysis**: 8 hex characters = 32 bits. An attacker observing the mDNS announcement gets 32 bits of the SHA-256 hash. This is not enough to reverse the PSK (which is typically 32+ random bytes), but it does allow them to verify a candidate PSK. This is acceptable because:
1. The PSK hash is only a pre-filter to avoid unnecessary TLS handshakes
2. Actual authentication happens at the TLS layer with the full PSK token
3. The mDNS announcement is LAN-scoped — an attacker must already be on the local network
4. If zero information leakage is required, set `federation.mdns.enabled: false` and use manual connect

### 4.5 Startup Sequence

When `FEDERATION_ENABLED` is true and `federation.mdns.enabled` is not false:

```
1. Federation TLS server starts (existing Phase A code, broker.ts line ~1040)
2. Detect runtime environment (WSL2 NAT / WSL2 mirrored / native Linux / macOS)
3. If WSL2 NAT mode → skip mDNS, log warning, return
4. Try to import bonjour-service → if not installed, log warning, return
5. Create MdnsManager with config from federation state
6. Call mdnsManager.start()
   a. Publish _claude-peers._tcp service with TXT records
   b. Start browsing for _claude-peers._tcp services
   c. On WSL2 mirrored: run 10s self-test, disable if no self-announcement received
7. Discovery events flow through onPeerDiscovered → handleFederationConnect()
```

### 4.6 Config File Changes

Extend `PeersConfig` in `src/shared/config.ts`:

```typescript
export interface PeersConfig {
  federation?: {
    enabled?: boolean;
    port?: number;
    subnet?: string;
    mdns?: {
      enabled?: boolean;        // default: true when federation is enabled
      interface?: string | null; // bind to specific network interface
    };
  };
}
```

### 4.7 Type Changes

Extend `RemoteMachine` in `src/shared/types.ts`:

```typescript
export interface RemoteMachine {
  host: string;
  port: number;
  hostname: string;
  peers: RemotePeer[];
  connected_at: string;
  last_sync: string;
  source: "manual" | "mdns";   // NEW: how this connection was established
}

export interface FederationStatusResponse {
  enabled: boolean;
  port: number;
  subnet: string;
  mdns: MdnsStatus;             // NEW: mDNS state
  remotes: Array<{
    host: string;
    port: number;
    hostname: string;
    peer_count: number;
    connected_at: string;
    last_sync: string;
    source: "manual" | "mdns";  // NEW
  }>;
  total_remote_peers: number;
}

export interface MdnsStatus {
  state: "active" | "disabled";
  reason?: string;               // why disabled, if applicable
  discovered_services: number;   // how many _claude-peers._tcp services seen
  auto_connections: number;      // how many connections established via mDNS
}
```

### 4.8 Shutdown and Cleanup

On broker shutdown (SIGINT/SIGTERM):
1. Call `mdnsManager.stop()` — un-publishes the mDNS service and closes the mDNS browser
2. The `bonjour-service` library sends a goodbye packet (TTL=0) so other machines immediately learn the service is gone
3. Existing federation cleanup continues (no changes needed — stale timeout handles remote machine eviction)

### 4.9 WSL2 Deep Dive

WSL2 networking has two modes, each with distinct multicast behavior:

| Mode | Default Route | Multicast | mDNS Feasibility |
|------|--------------|-----------|-------------------|
| **NAT** (default) | `eth0`, gateway 172.x.x.x | Blocked by Hyper-V virtual switch | None — multicast packets never leave the VM |
| **Mirrored** | `loopback0` or shared interface | Partially supported since 23H2 | Unreliable — works in some Windows builds, fails silently in others |

**NAT mode** (the default for all WSL2 installations) uses a Hyper-V virtual switch that does not forward multicast traffic between the VM and the host. This is a fundamental Windows networking limitation, not a configuration issue. There is no workaround short of switching to mirrored mode.

**Mirrored mode** (`networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`) shares the host's network interfaces directly with WSL2. Multicast should work in theory, but Microsoft's implementation has known issues:
- Windows 11 23H2: Multicast works for some users, fails for others
- Windows 11 24H2: Improved reliability, but still not guaranteed
- The `multicastDnsProxy` WSLconfig option (experimental) attempts to forward mDNS specifically, but is unreliable

Given this landscape, the self-test approach (US-004) is the only reliable way to determine if mDNS works: publish a service, try to discover it locally, and decide based on the result.

---

## 5. Non-Goals

| # | Non-Goal | Rationale |
|---|----------|-----------|
| NG-1 | **Internet/WAN discovery** | mDNS is LAN-only by design (link-local multicast). Internet discovery would require a relay server or DHT, which is a fundamentally different architecture. |
| NG-2 | **Relay or TURN servers** | Peers must be able to reach each other directly over TLS. NAT traversal via relay is out of scope. |
| NG-3 | **IPv6 support** | Current federation rejects hostnames with colons (IPv6). mDNS will filter for IPv4 (A records) only. IPv6 federation is a separate future effort. |
| NG-4 | **Automatic PSK distribution** | The PSK token must still be manually copied between machines (e.g., via `scp`). mDNS does not solve key exchange. A future phase could explore QR codes, NFC, or Bluetooth for PSK pairing. |
| NG-5 | **Service mesh or routing** | mDNS discovers direct peers only. Multi-hop routing (A discovers B, B discovers C, A messages C through B) is not in scope. |
| NG-6 | **UDP broadcast fallback for WSL2** | While a custom UDP broadcast protocol could work on WSL2 mirrored mode where mDNS fails, the complexity is not justified for Phase B. This could be a Phase C enhancement. |
| NG-7 | **GUI or desktop notifications for discovered peers** | Discovery events are logged only. User-facing notifications (e.g., "Rafi's machine joined the network") could be added later but are not part of this PRD. |

---

## 6. Security Considerations

| Concern | Mitigation |
|---------|------------|
| PSK token exposed via multicast | Only a truncated SHA-256 hash (8 hex chars) is broadcast. Full PSK is never on the wire in plaintext. |
| Rogue mDNS advertisements | PSK hash pre-filtering rejects unknown machines before any TLS connection is attempted. Even if an attacker advertises with the correct hash, the full PSK handshake at the TLS layer will reject them. |
| mDNS amplification attacks | Bun's dgram implementation does not respond to arbitrary mDNS queries — only the `bonjour-service` responder replies to PTR/SRV queries for our registered service type. |
| Information disclosure via TXT records | TXT records reveal: hostname, federation port, truncated PSK hash, protocol version. These are all observable to anyone on the LAN already (via network scanning). No new information is leaked that an ARP scan + port scan would not reveal. |
| Denial of service via mDNS flood | The dedup map and backoff logic (US-003) limit connection attempts. A flood of fake announcements would be filtered by PSK hash mismatch. Rate limiting on the federation TLS server (already implemented) handles the rest. |

---

## 7. Implementation Plan

| Phase | Stories | Estimated Effort | Description |
|-------|---------|------------------|-------------|
| B.1 | US-001, US-007 | 1-2 hours | Install `bonjour-service`, create `src/mdns.ts` with `MdnsManager`, implement advertisement and logging |
| B.2 | US-002 | 1-2 hours | Implement service browsing, PSK hash filtering, dedup map, self-announcement filtering |
| B.3 | US-003 | 1-2 hours | Wire auto-connect to `handleFederationConnect()`, implement backoff logic, add `source` field to `RemoteMachine` |
| B.4 | US-004 | 1-2 hours | WSL2 detection, mirrored mode self-test, graceful degradation paths, status reporting |
| B.5 | US-005 | 2-3 hours | Create `mdns.test.ts` with 11 unit tests + 5 integration tests, mock `MdnsProvider` |
| B.6 | US-006 | 1 hour | Config file extension, CLI commands (`federation mdns enable/disable/status`), env var override |

**Total estimated effort**: 7-12 hours

**Suggested implementation order**: B.1 -> B.2 -> B.3 -> B.5 (unit tests) -> B.4 -> B.6 -> B.5 (integration tests)

---

## 8. Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| **Auto-discovery latency** | < 60 seconds from broker start to first auto-connect | Timestamp delta between federation startup log and first `mDNS: auto-connected` log |
| **Reconnection latency** | < 90 seconds after network disruption | Kill and restart one broker; measure time until the other broker re-discovers and reconnects |
| **PSK filtering accuracy** | 100% of mismatched PSKs filtered before TLS handshake | Test with two machines using different PSK tokens; verify zero handshake attempts in federation.log |
| **WSL2 graceful degradation** | Zero crashes, clear log messages, manual connect still works | Run on WSL2 NAT mode; verify mDNS disabled log line and manual `federation connect` succeeds |
| **Test coverage** | 16+ tests, all passing | `bun test mdns.test.ts` |
| **Zero regression** | All existing 100 tests still pass | `bun test` (full suite) |
| **No mandatory dependency** | Broker starts without `bonjour-service` installed | Uninstall the package, restart broker, verify federation works via manual connect |

---

## 9. Open Questions

| # | Question | Proposed Answer | Status |
|---|----------|-----------------|--------|
| Q1 | Should mDNS be opt-in or opt-out when federation is enabled? | **Opt-out** (enabled by default). The whole point is zero-config — requiring users to enable mDNS defeats the purpose. Users who want to disable it can set `federation.mdns.enabled: false`. | Proposed |
| Q2 | Should we support `multicast-dns` as a fallback if `bonjour-service` has issues? | **No, for Phase B.** Pick one and ship. If `bonjour-service` proves problematic, we can swap to `multicast-dns` before release. The `MdnsProvider` interface makes this a drop-in replacement. | Proposed |
| Q3 | How long should the WSL2 mirrored mode self-test wait? | **10 seconds.** Short enough to not delay startup significantly, long enough for a multicast round-trip on a busy network. | Proposed |
| Q4 | Should mDNS auto-discovery work across VPN interfaces (e.g., Tailscale)? | **Not explicitly supported, not blocked.** If the VPN interface forwards multicast, it will work. Tailscale does not forward multicast by default. Users on Tailscale should use manual `federation connect` with Tailscale IPs. | Proposed |
| Q5 | Should the federation setup wizard (`federation setup`) be updated to mention mDNS? | **Yes.** Add a step that explains mDNS auto-discovery is active (or why it is not on WSL2), and note that manual connect is still available as a fallback. | Proposed |

---

## 10. Appendix: mDNS Protocol Reference

### Service Registration (DNS-SD)

A `_claude-peers._tcp` service registration creates three DNS records:

1. **PTR record**: `_claude-peers._tcp.local. → richescott-desktop._claude-peers._tcp.local.`
   - Maps service type to specific instance
2. **SRV record**: `richescott-desktop._claude-peers._tcp.local. → 0 0 7900 richescott-desktop.local.`
   - Maps instance to hostname and port
3. **TXT record**: `richescott-desktop._claude-peers._tcp.local. → "psk_hash=a1b2c3d4" "version=1.0.0" "hostname=richescott-desktop"`
   - Key-value metadata for the service

### Multicast Addresses

| Protocol | Address | Port | Scope |
|----------|---------|------|-------|
| mDNS (IPv4) | 224.0.0.251 | 5353 | Link-local |
| mDNS (IPv6) | ff02::fb | 5353 | Link-local |

### Relevant RFCs

- **RFC 6762**: Multicast DNS
- **RFC 6763**: DNS-Based Service Discovery (DNS-SD)
- **RFC 2782**: SRV Records (used by DNS-SD)
