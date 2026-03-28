# Architecture

This document describes the internal architecture of claude-peers-mcp -- the peer discovery and messaging system for Claude Code instances.

## System Overview

claude-peers-mcp enables multiple Claude Code sessions to discover each other, exchange messages in real time, and coordinate work. It operates as an MCP (Model Context Protocol) server that gives each Claude Code session access to peer discovery and messaging tools. A shared broker daemon manages all state and routes messages between sessions.

The system supports both **local** operation (multiple sessions on one machine) and **federated** operation (sessions across machines on a LAN) with TLS encryption and pre-shared key authentication.

## Component Diagram

```mermaid
graph TB
    subgraph "Machine A"
        CC1["Claude Code<br/>Session A"] <-->|stdio| MCP1["MCP Server A<br/>(server.ts)"]
        CC2["Claude Code<br/>Session B"] <-->|stdio| MCP2["MCP Server B<br/>(server.ts)"]
        CC3["Claude Code<br/>Session C"] <-->|stdio| MCP3["MCP Server C<br/>(server.ts)"]

        MCP1 -->|"HTTP POST<br/>localhost:7899"| Broker["Broker Daemon<br/>(broker.ts)<br/>localhost:7899"]
        MCP2 -->|"HTTP POST<br/>localhost:7899"| Broker
        MCP3 -->|"HTTP POST<br/>localhost:7899"| Broker

        Broker --- DB[("SQLite<br/>~/.claude-peers.db")]
        Broker --- Fed["Federation TLS Server<br/>0.0.0.0:7900"]
    end

    subgraph "Machine B"
        BrokerB["Broker Daemon<br/>localhost:7899"] --- FedB["Federation TLS Server<br/>0.0.0.0:7900"]
        BrokerB --- DBB[("SQLite<br/>~/.claude-peers.db")]
        CCB1["Claude Code<br/>Session D"] <-->|stdio| MCPB1["MCP Server D<br/>(server.ts)"]
        MCPB1 -->|"HTTP POST<br/>localhost:7899"| BrokerB
    end

    Fed <-->|"TLS + PSK + HMAC<br/>port 7900"| FedB

    CLI["CLI<br/>(cli.ts)"] -->|"HTTP<br/>localhost:7899"| Broker

    style Broker fill:#2d5016,stroke:#4a8c28,color:#fff
    style BrokerB fill:#2d5016,stroke:#4a8c28,color:#fff
    style DB fill:#1a3a5c,stroke:#2980b9,color:#fff
    style DBB fill:#1a3a5c,stroke:#2980b9,color:#fff
    style Fed fill:#5c1a1a,stroke:#c0392b,color:#fff
    style FedB fill:#5c1a1a,stroke:#c0392b,color:#fff
```

**Key observations:**

- Each Claude Code session gets its own MCP server process (stdio transport).
- All MCP servers on a machine share a single broker daemon (HTTP on localhost:7899).
- The federation TLS server runs in the same process as the broker (second `Bun.serve()` on port 7900).
- The CLI is a one-shot process that communicates with the broker over HTTP -- it does not persist.

## Message Flow -- Three-Layer Delivery

Claude Code's channel notification system silently drops ~30-50% of messages at the platform level. To compensate, claude-peers uses three independent delivery layers:

```mermaid
sequenceDiagram
    participant Sender as Sender MCP Server
    participant Broker as Broker Daemon
    participant Receiver as Receiver MCP Server
    participant CC as Claude Code Session

    Note over Sender,CC: Sender calls send_message tool

    Sender->>Broker: POST /send-message<br/>{from_id, to_id, text}
    Broker->>Broker: Store in SQLite<br/>(delivered=0)
    Broker-->>Sender: {ok: true, message_id: 42}

    Note over Broker,CC: Layer 1: Channel Push (instant, ~50-70% reliable)

    Receiver->>Broker: POST /poll-messages<br/>(every 1s)
    Broker-->>Receiver: {messages: [{id: 42, ...}]}
    Receiver->>Broker: POST /ack-messages<br/>{message_ids: [42]}
    Receiver->>CC: mcp.notification()<br/>(channel push)

    Note over Receiver,CC: If Claude Code renders it: done.<br/>If dropped silently: Layer 2 catches it.

    Note over Receiver,CC: Layer 2: Piggyback (next tool call, ~99% reliable)

    Receiver->>Receiver: Queue message locally<br/>(5s grace period)
    CC->>Receiver: Next tool call (any tool)
    Receiver-->>CC: Tool response with<br/>message banner prepended

    Note over Receiver,CC: Layer 3: Safety-Net Poll (every 30s, ~100% reliable)

    loop Every 30 seconds
        Receiver->>Broker: POST /poll-messages
        Broker-->>Receiver: Any remaining undelivered
        Receiver->>CC: Retry channel push<br/>or queue for piggyback
    end
```

**Layer details:**

| Layer | Mechanism | Latency | Reliability | Failure Mode |
|-------|-----------|---------|-------------|--------------|
| **1. Channel push** | `mcp.notification()` pushes directly into session | Instant | ~50-70% | Claude Code silently drops the notification |
| **2. Piggyback** | Queued messages prepended to next tool call response | Next tool call (seconds) | ~99% | Session has no tool calls (idle) |
| **3. Safety-net poll** | Polls broker every 30s, retries channel push | Up to 30s | ~100% | Broker is down |

## Process Model

broker.ts and server.ts are **separate processes** with distinct lifecycles:

```mermaid
graph LR
    subgraph "Process: MCP Server (one per session)"
        S["server.ts"]
        S -->|"spawns if not running"| B
    end

    subgraph "Process: Broker Daemon (singleton)"
        B["broker.ts"]
        BH["broker-handlers.ts<br/>(hot-reloadable)"]
        B -->|"imports"| BH
        B --- SQLite[("SQLite DB")]
        B --- FedTLS["Federation TLS<br/>(port 7900)"]
    end

    S -->|"HTTP fetch<br/>localhost:7899"| B

    style B fill:#2d5016,stroke:#4a8c28,color:#fff
    style S fill:#1a3a5c,stroke:#2980b9,color:#fff
```

### Broker (broker.ts) -- Singleton Daemon

- **Lifecycle:** Spawned by the first MCP server via `Bun.spawn()`. Persists across `/mcp` reconnects. Survives individual session exits.
- **Binding:** `127.0.0.1:7899` (HTTP, localhost only). `0.0.0.0:7900` (TLS, federation, LAN-facing).
- **State:** SQLite database (`~/.claude-peers.db`), in-memory maps for federation remotes and rate limits.
- **Cleanup:** Stale peers (dead PIDs) cleaned every 30s. Delivered messages purged after 7 days. Orphaned messages bounced back to senders.
- **Restart:** `bun src/cli.ts kill-broker` or `bunx claude-peers kill-broker`. Auto-restarts on next MCP server connect.

### MCP Server (server.ts) -- One Per Session

- **Lifecycle:** Started by Claude Code as a stdio MCP server. Dies when the Claude Code session exits. Restarted on `/mcp` reconnect.
- **Transport:** stdio (stdin/stdout for MCP protocol, stderr for logging).
- **Broker communication:** HTTP POST to `localhost:7899` with bearer token auth.
- **Polling:** Every 1s for new messages, every 15s for heartbeat.
- **Auto-reconnect:** After 5 consecutive poll failures (~5 seconds), re-registers with the broker automatically. Session name and summary are restored.

### CLI (cli.ts) -- On-Demand

- **Lifecycle:** Runs as a one-shot command, exits when done.
- **Communication:** HTTP to `localhost:7899` with bearer token auth.
- **No restart needed:** CLI always runs fresh code -- changes to cli.ts take effect immediately.

## Federation Topology

```mermaid
graph TB
    subgraph "Machine A (e.g., riche-wsl2)"
        BA["Broker A<br/>:7899"] --- FA["Federation TLS<br/>:7900"]
        PA1["Peer a1"] --> BA
        PA2["Peer a2"] --> BA
    end

    subgraph "Machine B (e.g., rafi-macbook)"
        BB["Broker B<br/>:7899"] --- FB["Federation TLS<br/>:7900"]
        PB1["Peer b1"] --> BB
        PB2["Peer b2"] --> BB
    end

    FA <-->|"PSK + HMAC + TLS<br/>Peer sync every 30s<br/>Message relay on demand"| FB

    style FA fill:#5c1a1a,stroke:#c0392b,color:#fff
    style FB fill:#5c1a1a,stroke:#c0392b,color:#fff
    style BA fill:#2d5016,stroke:#4a8c28,color:#fff
    style BB fill:#2d5016,stroke:#4a8c28,color:#fff
```

**Federation protocol:**

1. **Handshake:** Machine A sends `POST /federation/handshake` with PSK token and hostname. Machine B verifies PSK and responds with its hostname.
2. **Peer sync:** Every 30 seconds, each broker fetches the other's peer list via `POST /federation/peers`. Stale remotes (>90s since last sync) are evicted.
3. **Message relay:** When a local peer sends to a remote peer (identified by `hostname:peer_id` format), the broker relays via `POST /federation/relay` with HMAC-SHA256 signature.
4. **Auto-reconnect:** On broker restart, saved remotes from `~/.claude-peers-config.json` are reconnected with exponential backoff (0s, 5s, 15s, 45s, then 60s intervals, up to 20 attempts).

**Cross-machine message path:**

```mermaid
sequenceDiagram
    participant PA as Peer a1<br/>(Machine A)
    participant BA as Broker A
    participant FA as Federation A<br/>(:7900 TLS)
    participant FB as Federation B<br/>(:7900 TLS)
    participant BB as Broker B
    participant PB as Peer b1<br/>(Machine B)

    PA->>BA: send_message(to: "rafi-macbook:b1id", text: "hello")
    BA->>BA: Detect remote peer (colon in ID)
    BA->>FA: Route to federation handler
    FA->>FB: POST /federation/relay<br/>TLS + PSK header + HMAC signature
    FB->>FB: Verify PSK, verify HMAC
    FB->>BB: Insert message into local SQLite
    BB-->>PB: Delivered via three-layer system
```

## Hot-Reload Architecture

The broker supports SIGHUP-based hot-reload for handler code changes without dropping connections or losing state.

```mermaid
graph TB
    subgraph "broker.ts (state owner)"
        CTX["BrokerContext<br/>- db: SQLite<br/>- stmts: 13 prepared statements<br/>- token: {current: string}<br/>- remoteMachines: Map<br/>- rateLimits: Map<br/>- counters, config refs"]
    end

    subgraph "broker-handlers.ts (hot-reloadable)"
        CBF["createBrokerFetch(ctx)"]
        CFF["createFederationFetch(ctx)"]
    end

    CTX -->|"pass by reference"| CBF
    CTX -->|"pass by reference"| CFF
    CBF -->|"returns"| FH["fetch handler function"]
    CFF -->|"returns"| FFH["federation fetch handler"]

    SIGHUP["SIGHUP signal"] -->|"1. re-import broker-handlers.ts<br/>2. call createBrokerFetch(ctx)<br/>3. server.reload({fetch: newHandler})"| CBF

    style CTX fill:#1a3a5c,stroke:#2980b9,color:#fff
    style SIGHUP fill:#5c1a1a,stroke:#c0392b,color:#fff
```

**How it works:**

1. `broker.ts` owns all state in a `BrokerContext` object (database, prepared statements, Maps, config refs).
2. `broker-handlers.ts` exports factory functions (`createBrokerFetch`, `createFederationFetch`) that accept `BrokerContext` and return `fetch` handler functions.
3. On SIGHUP, broker.ts re-imports `broker-handlers.ts` with cache-busting (`?v=${Date.now()}`), calls the factory with the same `BrokerContext`, and swaps the handler via `Bun.serve().reload()`.
4. State survives because `BrokerContext` is passed by reference -- the new handlers operate on the same objects.
5. If the import fails, the previous handlers remain active (rollback on error).

**Trigger SIGHUP:**

```bash
kill -HUP $(lsof -ti :7899)
# Or:
bun src/cli.ts reload-broker
```

## Database Schema

The broker uses SQLite (`~/.claude-peers.db`) with WAL mode and two tables:

### peers

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | SHA-256 hash of TTY (8 chars), stable across `/mcp` reconnects |
| `pid` | INTEGER NOT NULL | OS process ID, used for liveness checks |
| `cwd` | TEXT NOT NULL | Working directory of the Claude Code session |
| `git_root` | TEXT | Git repository root (null if not in a repo) |
| `tty` | TEXT | Terminal device (e.g., `pts/44`) |
| `session_name` | TEXT DEFAULT '' | Human-readable name from `/rename` (e.g., `AUTH_WORKER`) |
| `summary` | TEXT DEFAULT '' | Work summary visible to peers |
| `version` | TEXT DEFAULT '' | CPM version string (e.g., `0.7.0`) |
| `channel_push` | TEXT DEFAULT 'unknown' | Channel push status: `unknown`, `unverified`, `working` |
| `registered_at` | TEXT NOT NULL | ISO 8601 timestamp of first registration |
| `last_seen` | TEXT NOT NULL | ISO 8601 timestamp of last heartbeat |

### messages

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Unique message ID |
| `from_id` | TEXT NOT NULL | Sender peer ID (or `system` for bounce messages) |
| `to_id` | TEXT NOT NULL | Recipient peer ID |
| `text` | TEXT NOT NULL | Message content (max 10KB with metadata combined) |
| `type` | TEXT DEFAULT 'text' | Message type: `text`, `query`, `response`, `handoff`, `broadcast` |
| `metadata` | TEXT DEFAULT NULL | JSON string of structured metadata |
| `reply_to` | INTEGER DEFAULT NULL | ID of parent message (for threading) |
| `sent_at` | TEXT NOT NULL | ISO 8601 timestamp |
| `delivered` | INTEGER DEFAULT 0 | `0` = pending, `1` = acknowledged by recipient |

**Maintenance:**

- Dead peers (PID check fails) are cleaned every 30 seconds.
- Delivered messages older than 7 days are purged every 60 seconds.
- Orphaned messages (recipient peer no longer exists) are bounced back to senders.

## Authentication

claude-peers uses different authentication mechanisms for local and federated communication:

### Local Authentication (Bearer Token)

- **Scope:** All POST endpoints on `localhost:7899` (MCP server-to-broker, CLI-to-broker).
- **Token:** Auto-generated 64-character hex string stored at `~/.claude-peers-token` with `0o600` permissions.
- **Header:** `Authorization: Bearer <token>`.
- **Rotation:** Send SIGHUP to broker (`bun src/cli.ts reload-broker`). Token is re-read from disk every 60 seconds automatically.
- **Retry:** On 401, MCP servers re-read the token file and retry once (handles rotation during active sessions).

### Unauthenticated Endpoints

- `GET /health` -- Health check, returns peer count and uptime. No auth required.
- `GET /federation/status` -- Federation connection status. No auth required.

### Federation Authentication (PSK + HMAC)

- **PSK (Pre-Shared Key):** Both machines must share the same `~/.claude-peers-token` file. Sent in `X-Claude-Peers-PSK` header on all federation requests.
- **HMAC-SHA256:** Message relay requests (`/federation/relay`) include an HMAC signature computed over the canonicalized request body (top-level keys sorted alphabetically). The recipient verifies the signature before accepting the message.
- **TLS:** All federation communication uses self-signed TLS certificates (RSA-2048 for macOS LibreSSL compatibility). The `curl -sk` workaround is used because Bun 1.3.x `fetch()` does not support `tls: { rejectUnauthorized: false }`.
- **Subnet Filtering:** Configurable CIDR allowlist (`CLAUDE_PEERS_FEDERATION_SUBNET`). Connections from outside the subnet are rejected at the federation TLS server level before PSK validation.
- **Timing-Safe Comparison:** Both bearer token and PSK comparisons use `crypto.timingSafeEqual` to prevent timing side-channel attacks.

```mermaid
graph LR
    subgraph "Local (localhost:7899)"
        L1["GET /health"] -->|"No auth"| Broker
        L2["POST /register<br/>POST /send-message<br/>POST /list-peers<br/>..."] -->|"Bearer token"| Broker
    end

    subgraph "Federation (0.0.0.0:7900 TLS)"
        F1["GET /health"] -->|"Subnet check only"| Fed["Federation Handler"]
        F2["POST /handshake<br/>POST /peers"] -->|"Subnet + PSK"| Fed
        F3["POST /relay"] -->|"Subnet + PSK + HMAC"| Fed
    end

    style Broker fill:#2d5016,stroke:#4a8c28,color:#fff
    style Fed fill:#5c1a1a,stroke:#c0392b,color:#fff
```
