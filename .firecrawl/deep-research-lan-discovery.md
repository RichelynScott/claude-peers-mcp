# Deep Research Report: LAN Cross-Machine Peer Discovery for claude-peers-mcp
**Generated**: 2026-03-24
**Research Parameters**: Breadth 4, Depth 2
**Sources Consulted**: 14 unique URLs + 2 DeepWiki codebase analyses

## Executive Summary

LAN federation for claude-peers-mcp is **technically feasible** with Bun as the runtime. Bun provides all necessary APIs: TLS server/client (`Bun.serve()`, `Bun.listen()`, `Bun.connect()`, `node:tls`), UDP multicast (`dgram` with full `addMembership`/`setBroadcast` support), and crypto (`node:crypto` with `generateKeyPairSync`, `createSign`, `X509Certificate`). Self-signed TLS certificate generation must use either `openssl` CLI (shelling out) or the `selfsigned` npm package -- Bun has no built-in cert-gen API.

The `bonjour-service` npm package (TypeScript, uses `multicast-dns` under the hood) is the best mDNS library candidate. It relies on `dgram` multicast which Bun fully supports. However, **WSL2 multicast is deeply problematic**: default NAT mode blocks multicast entirely, mirrored mode (`networkingMode=mirrored`) officially supports it but has known bugs where Windows cannot receive multicast packets from WSL2. This means mDNS auto-discovery (Phase B of the PRD) will not work reliably on WSL2.

The recommended implementation strategy is: **Phase A (manual federation) is the safe MVP.** Use `Bun.serve()` with TLS for the federation HTTPS server, shell out to `openssl` for one-time cert generation, and rely on manual `federation connect <ip>:<port>` for cross-machine linking. Phase B (mDNS) should be implemented as a graceful-degradation feature -- works on native Linux/macOS, fails gracefully on WSL2 with a clear warning and manual fallback.

## Detailed Findings

### 1. Bun TLS Server Capabilities

**Verdict: Fully sufficient for federation.**

Bun offers two TLS server APIs:

1. **`Bun.serve()` (HTTP/HTTPS)**: The federation agent can use this for the TLS-encrypted HTTP endpoints (`/federation/handshake`, `/federation/peers`, `/federation/relay`). Configuration:
   ```typescript
   Bun.serve({
     port: 7900,
     tls: {
       key: Bun.file("~/.claude-peers-federation.key"),
       cert: Bun.file("~/.claude-peers-federation.crt"),
     },
     fetch(req) { /* handle federation endpoints */ }
   });
   ```
   - `key` and `cert` accept `string | BunFile | TypedArray | Buffer | array`
   - `ca` overrides trusted CAs (useful for accepting self-signed certs)
   - `rejectUnauthorized` controls cert validation
   - SNI supported via array of `tls` objects with `serverName`
   - `requestCert` enables client certificate requests (not needed for PSK auth)

2. **`Bun.listen()` (raw TCP+TLS)**: Lower-level alternative. Same TLS config, but handler-based (not HTTP). Could be used if the federation protocol were binary, but HTTP is simpler for our JSON-based protocol.

3. **`Bun.connect()` (TLS client)**: For outbound connections to remote federation agents. Set `tls: true` or `tls: { rejectUnauthorized: false }` for self-signed certs.

4. **`node:tls` module**: `tls.connect()` available for compatibility. Less performant than Bun-native APIs but functional.

**Key finding**: `Bun.serve()` with `tls` is the right choice for the federation agent. It's the same API already used for the local broker (minus TLS), so the codebase pattern is consistent. The federation agent should be a **second `Bun.serve()` instance** in the same process, on port 7900.

**Known issue**: Bun issue #11997 reported a regression with self-signed certificates in `Bun.serve()`, but this was fixed. Ensure the Bun version is current.

### 2. Self-Signed Certificate Generation

**Verdict: Shell out to `openssl`. It's the simplest and most reliable approach.**

Three options were evaluated:

| Approach | Pros | Cons | Recommended |
|----------|------|------|:-----------:|
| Shell out to `openssl` | Universal, well-documented, one command | Requires `openssl` installed (present on all Linux/macOS) | **Yes** |
| `selfsigned` npm package | Pure JS, no system deps | Extra dependency, less maintained | No |
| `node:crypto` APIs | Built-in, no system deps | No "create cert" API -- must manually construct ASN.1 DER encoding | No |

**The recommended one-liner** for non-interactive cert generation:
```bash
openssl req -newkey rsa:2048 -noenc -keyout ~/.claude-peers-federation.key -x509 -days 365 -out ~/.claude-peers-federation.crt -subj "/CN=$(hostname)"
```

Implementation in Bun:
```typescript
import { $ } from "bun";
const keyPath = `${process.env.HOME}/.claude-peers-federation.key`;
const certPath = `${process.env.HOME}/.claude-peers-federation.crt`;

if (!await Bun.file(keyPath).exists()) {
  await $`openssl req -newkey rsa:2048 -noenc -keyout ${keyPath} -x509 -days 365 -out ${certPath} -subj "/CN=$(hostname)"`;
  await $`chmod 600 ${keyPath}`;
}
```

**Why not `node:crypto`**: While Bun supports `generateKeyPairSync` and `X509Certificate`, Node.js/Bun's crypto module has no API to *create* a certificate. `X509Certificate` is read-only (parse/inspect). You'd need to manually encode ASN.1 DER structures, which is fragile and error-prone. OpenSSL is the industry standard for this and available on every target platform.

### 3. mDNS / Bonjour Libraries and Bun Compatibility

**Verdict: `bonjour-service` should work in Bun, but WSL2 multicast limitations are the real blocker.**

#### bonjour-service (v1.3.0)
- **Language**: TypeScript (rewrite of `bonjour` by Watson)
- **Dependencies**: `multicast-dns` (core), `dns-txt`
- **API**: `publish()` to advertise, `find()` to discover, events: `up`, `down`, `txt-update`
- **TXT records**: Supports arbitrary key-value objects -- perfect for `psk_hash`, `version`, `hostname`
- **Bun compatibility**: Uses `dgram` under the hood. Since Bun fully supports `dgram.createSocket`, `addMembership`, `setBroadcast`, `setMulticastTTL`, and `reuseAddr`, it should work.

#### multicast-dns (underlying library)
- Uses UDP multicast on `224.0.0.251:5353` (standard mDNS)
- Options: `multicast`, `interface`, `port`, `ip`, `ttl`, `loopback`, `reuseAddr`
- Pure JavaScript, no native bindings -- ideal for Bun

#### Bun dgram support (confirmed via DeepWiki)
All relevant APIs are implemented:
- `dgram.createSocket('udp4')` -- creates UDP socket
- `socket.addMembership('224.0.0.251')` -- joins mDNS multicast group
- `socket.setBroadcast(true)` -- enables broadcast
- `socket.setMulticastTTL(255)` -- standard mDNS TTL
- `socket.setMulticastLoopback(true)` -- receive own packets
- `socket.setMulticastInterface('192.168.1.x')` -- bind to specific NIC
- `reuseAddr: true` -- allows multiple sockets on same port (fixed in recent Bun)

**Risk**: While the APIs exist, there may be edge cases. The federation agent should test `bonjour-service` during Phase B development and have a fallback path if multicast fails.

### 4. WSL2 Networking: The Hard Problem

**Verdict: WSL2 multicast is unreliable. Design for manual federation first, treat mDNS as optional enhancement.**

#### WSL2 Networking Modes

| Mode | Multicast | LAN Access | Port Forward Needed | DNS .local |
|------|-----------|------------|:-------------------:|------------|
| **NAT** (default) | No | Via portproxy | Yes | No |
| **Mirrored** | Officially yes* | Direct | No | Depends on dnsTunneling |

*Mirrored mode multicast has known bugs -- see below.

#### NAT Mode (Default)
- WSL2 runs behind a virtual NAT (172.x.x.x subnet)
- **Multicast packets do not cross the NAT boundary** -- mDNS is impossible
- LAN access requires `netsh interface portproxy`:
  ```powershell
  netsh interface portproxy add v4tov4 listenport=7900 listenaddress=0.0.0.0 connectport=7900 connectaddress=$(wsl hostname -I)
  ```
- Windows Firewall must allow the port
- The WSL2 IP changes on restart -- portproxy command must be re-run

#### Mirrored Mode
- Set in `%USERPROFILE%\.wslconfig`:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
- WSL2 shares Windows network interfaces -- same IP, no NAT
- **Microsoft officially lists "Multicast support"** as a benefit
- LAN connections work directly without portproxy
- **BUT**: Known bugs (GitHub WSL issues #14357, Reddit reports):
  - Windows host may not receive multicast FROM WSL2, even though packets are visible on Wireshark
  - Hyper-V firewall must be configured: `Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow`
  - May conflict with VPNs
  - `hostAddressLoopback=true` may be needed under `[experimental]`

#### DNS Tunneling Interaction
- `dnsTunneling=true` (default in Windows 11 22H2+) breaks `.local` name resolution
- Must set `dnsTunneling=false` for mDNS name resolution to work
- Turning off DNS tunneling may cause issues with VPNs

#### Practical Implications for claude-peers-mcp

1. **Phase A (manual federation)**: Works in BOTH NAT and mirrored mode:
   - NAT: User sets up portproxy, connects via Windows host IP
   - Mirrored: User connects directly, WSL2 has same IP as Windows host
   - Either way: `bun cli.ts federation connect <ip>:7900` works

2. **Phase B (mDNS auto-discovery)**: Only works on:
   - Native Linux (not WSL2)
   - macOS (Bonjour is native, works perfectly)
   - WSL2 mirrored mode (unreliable, may not work for the Windows side)

3. **Phase C (WSL2 docs/workarounds)**: Critical for the user's setup (Riche is on WSL2, Rafi is on Mac)

### 5. Architecture Recommendations

Based on research findings, here are refinements to the existing PRD:

#### 5.1 Federation Agent as Bun.serve()
Use `Bun.serve()` with TLS, not `Bun.listen()`. This keeps the federation protocol HTTP-based (JSON over HTTPS), consistent with the local broker's existing HTTP API. The federation agent is a second HTTP server in the same process:

```typescript
// In broker.ts, after local server starts:
if (process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "true") {
  const federationServer = Bun.serve({
    port: federationPort,
    hostname: "0.0.0.0", // Listen on all interfaces
    tls: {
      key: Bun.file(keyPath),
      cert: Bun.file(certPath),
    },
    fetch: handleFederationRequest,
  });
}
```

#### 5.2 TLS Client Connections
When connecting to a remote federation agent:
```typescript
const response = await fetch(`https://${host}:${port}/federation/handshake`, {
  method: "POST",
  headers: { "X-Claude-Peers-PSK": psk },
  body: JSON.stringify({ hostname: os.hostname() }),
  tls: { rejectUnauthorized: false }, // Self-signed certs
});
```

Note: `fetch()` in Bun supports the non-standard `tls` option for per-request TLS config.

#### 5.3 HMAC-SHA256 Signing
Use Bun's `node:crypto` (confirmed working):
```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

function signMessage(body: string, psk: string): string {
  return createHmac("sha256", psk).update(body).digest("hex");
}

function verifySignature(body: string, signature: string, psk: string): boolean {
  const expected = signMessage(body, psk);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

#### 5.4 Subnet Restriction
Use Node.js `net` module (Bun compatible) for CIDR checking:
```typescript
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

function ipInSubnet(ip: string, cidr: string): boolean {
  const [subnet, bits] = cidr.split("/");
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0;
  const ipNum = ipToInt(ip);
  const subnetNum = ipToInt(subnet);
  return (ipNum & mask) === (subnetNum & mask);
}
```

#### 5.5 WSL2 Detection
```typescript
function isWSL2(): boolean {
  try {
    return Bun.file("/proc/sys/fs/binfmt_misc/WSLInterop").size > 0
      || !!process.env.WSL_DISTRO_NAME;
  } catch { return false; }
}
```

### 6. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| WSL2 multicast doesn't work | HIGH | Phase A (manual) is the MVP. mDNS is Phase B enhancement. |
| `bonjour-service` has Bun-specific bugs | MEDIUM | Test during Phase B. Fallback: use `multicast-dns` directly. |
| `openssl` not available on target system | LOW | All Linux distros and macOS have it. Windows WSL2 has it. |
| Self-signed cert regression in Bun | LOW | Fixed in Bun issue #11997. Pin minimum Bun version. |
| `fetch()` with `tls` option not standard | MEDIUM | Bun-specific. If porting to Node.js later, use `node:https` agent. |
| PSK token distribution is manual | MEDIUM | Acceptable for Phase A. Could add QR code or SRP in future. |
| WSL2 IP changes on restart (NAT mode) | MEDIUM | Document in Phase C. Mirrored mode avoids this. |

## Key Data Points

| Metric | Value |
|--------|-------|
| Bun TLS APIs | `Bun.serve()`, `Bun.listen()`, `Bun.connect()`, `node:tls` |
| Bun cert generation | None built-in. Use `openssl` CLI. |
| `bonjour-service` version | 1.3.0 (TypeScript, MIT license) |
| `multicast-dns` transport | UDP multicast, 224.0.0.251:5353 |
| WSL2 NAT multicast | Not supported |
| WSL2 mirrored multicast | Officially supported, bugs reported |
| WSL2 mirrored mode requirement | Windows 11 22H2+ |
| OpenSSL cert one-liner | `openssl req -newkey rsa:2048 -noenc -keyout key.pem -x509 -days 365 -out cert.pem -subj "/CN=hostname"` |
| Bun dgram APIs | Full support (createSocket, addMembership, setBroadcast, etc.) |
| Bun node:crypto | generateKeyPairSync, X509Certificate, createHmac, timingSafeEqual |

## Emerging Trends & Contrarian Views

1. **WSL2 Mirrored Mode is maturing rapidly**: Microsoft added multicast support in 2024, and while buggy, it's actively being fixed. By the time Phase B is implemented, mirrored mode multicast may work reliably. Worth re-testing periodically.

2. **Tailscale as alternative transport**: Several WSL2 networking posts mention Tailscale as a workaround for cross-machine connectivity. Tailscale's MagicDNS works in WSL2 and provides encrypted peer-to-peer tunnels. This could be a future Phase D: "Tailscale-based federation" that bypasses LAN networking entirely. However, it requires a Tailscale account and is not LAN-only.

3. **`selfsigned` npm package**: While I recommend `openssl`, the `selfsigned` package (7M weekly npm downloads) generates self-signed certs in pure JavaScript. If `openssl` availability becomes an issue, this is the fallback. It uses `node-forge` internally, which may have Bun compatibility issues.

4. **Bun.listen() for persistent connections**: The PRD describes periodic 30s peer list sync. An alternative architecture would use persistent TLS connections between federation agents (via `Bun.listen()`/`Bun.connect()`) and push peer updates in real-time. This reduces latency but adds complexity. For Phase A, periodic HTTP polling is simpler and sufficient.

5. **Consider Ed25519 over RSA**: Ed25519 keys are smaller (32 bytes vs 256 bytes for RSA-2048) and faster to generate/verify. OpenSSL supports Ed25519: `openssl genpkey -algorithm Ed25519 -out key.pem`. Bun's TLS stack (uSockets/BoringSSL) supports it. Worth considering for performance.

## Sources

- https://bun.com/docs/guides/http/tls
- https://bun.com/docs/api/tcp
- https://github.com/oven-sh/bun/issues/11997
- https://github.com/onlxltd/bonjour-service
- https://www.npmjs.com/package/bonjour-service
- https://github.com/mafintosh/multicast-dns
- https://github.com/microsoft/WSL/issues/12354
- https://github.com/microsoft/WSL/discussions/14357
- https://www.reddit.com/r/wsl2/comments/1npl7ux/wsl2_multicast/
- https://www.reddit.com/r/bashonubuntuonwindows/comments/1e9rjid/mdns_not_working_in_wsl2_works_ok_in_windows_host/
- https://nelsonslog.wordpress.com/2024/07/23/wsl2-dns-tunneling-and-local-names/
- https://learn.microsoft.com/en-us/windows/wsl/networking
- https://www.baeldung.com/openssl-self-signed-cert
- https://www.ietf.org/archive/id/draft-halen-fed-tls-auth-16.html
- DeepWiki: oven-sh/bun (TLS server API analysis)
- DeepWiki: oven-sh/bun (dgram/multicast/node:crypto analysis)
