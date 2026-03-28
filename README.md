# claude-peers-mcp

Peer discovery and messaging for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instances -- on the same machine or across your LAN to other machines on secured LAN.

Multiple Claude Code sessions can find each other, exchange messages in real time, and coordinate work without any external services. Federation extends this across machines with TLS encryption and pre-shared key authentication.

**Key features:**

- **Peer discovery** -- find sessions by machine, directory, git repo, or LAN
- **Real-time messaging** -- instant delivery via Claude Code channel push
- **LAN federation** -- cross-machine collaboration with TLS + PSK + HMAC security
- **Structured messages** -- types (text, query, response, handoff, broadcast), metadata, threading
- **Broadcast** -- send to all peers in a given scope
- **Auto-summary** -- git-based context summaries with zero external API calls
- **Three-layer delivery** -- channel push → piggyback on tool call → safety-net polling ensures messages arrive
- **CLI** -- inspect, message, and manage from your terminal

## What is MCP?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is a standard for connecting AI assistants to external tools and data sources. claude-peers-mcp is an MCP server that gives Claude Code the ability to discover and communicate with other Claude Code sessions.

## Quick Start

### 1. Install

Requires [Bun](https://bun.sh) (v1.1+).

**Option A — npm/bun package:**
```bash
bun add -g claude-peers
```

**Option B — from source:**
```bash
git clone https://github.com/RichelynScott/claude-peers-mcp.git
cd claude-peers-mcp
bun install
```

After installing via npm, the CLI is available as `bunx claude-peers`.

### Updating

**npm/bun package:**
```bash
bun update -g claude-peers
```

**From source:**
```bash
git pull origin main && bun install
```

After updating, restart the broker so it loads the new code:
```bash
# npm install:
bunx claude-peers kill-broker

# source install:
bun src/cli.ts kill-broker
```
Sessions auto-reconnect to the new broker within ~5 seconds.

### 2. Register the MCP server

Register as a user-scoped MCP so it loads in every Claude Code session:

```bash
# Run this from the claude-peers-mcp directory after cloning
claude mcp add --scope user --transport stdio claude-peers \
  -- bun $PWD/src/server.ts
```

### 3. Enable channel push (real-time message delivery)

Channel push delivers messages **instantly** into your Claude Code session as live interrupts. Without it, messages sit in the broker database and are **not visible** to your session — even `check_messages` will show nothing because the MCP server polls and acks them before Claude sees them.

**Add this shell wrapper** to your `~/.zshrc` (or `~/.bashrc`):

```bash
claude() {
    command claude --dangerously-load-development-channels server:claude-peers "$@"
}
```

Then **open a new terminal** (the wrapper only loads in new shells). From now on, just type `claude` normally — the wrapper automatically adds the channel push flag. All your usual arguments still work:

```bash
claude                                          # normal launch (with channel push)
claude --resume                                 # resume session (with channel push)
claude --dangerously-skip-permissions           # autonomous mode (with channel push)
claude --dangerously-skip-permissions --resume  # resume autonomous mode (with channel push)
```

> **Note:** When you launch with this wrapper, Claude Code will show a confirmation prompt asking you to approve loading the `server:claude-peers` development channel. Accept it each time you start, this is the new process to start Claude Code.

> **Important:** The `--dangerously-load-development-channels` flag is required for Claude Code to display incoming messages from peers. Without it, the MCP server can send/receive at the protocol level but messages never surface in your conversation.

### 4. Use it

The broker daemon starts automatically when the first MCP server connects. Open two or more Claude Code sessions and they will discover each other.

```
You: "Who else is working in this repo?"
Claude: [calls list_peers with scope "repo"]
Claude: "There's one other session working on the auth module..."
```

**Tip:** Rename your sessions for easier identification (I do this as soon as possible for every session):
```
/rename AUTH_WORKER
/rename AUTH_MGR
```
This calls `set_name` automatically, so other peers see "AUTH_WORKER" instead of an opaque 8-character ID. The summary is immediately regenerated with the session name and TTY for disambiguation (e.g., `[AUTH_WORKER:pts/44] recently touched auth.ts in my-project`). Name your sessions based on what they're working on — it makes multi-session collaboration much easier.

## Message Reliability

Claude Code's channel notification system silently drops ~30-50% of messages at the platform level. claude-peers mitigates this with **three-layer delivery** — each layer independently compensates for the previous one's failure mode:

| Layer | Mechanism | Latency | Reliability |
|-------|-----------|---------|-------------|
| **1. Channel push** | `mcp.notification()` pushes directly into session | Instant | ~50-70% (Claude Code limitation) |
| **2. Piggyback** | Missed messages prepended to next tool call response | Next tool call (seconds) | ~99% |
| **3. Safety-net poll** | Polls broker every 30s for anything that slipped through | Up to 30s | ~100% |

In practice, most messages arrive instantly via Layer 1. When they don't, Layer 2 catches them within seconds. Layer 3 is the final safety net for edge cases.

**Auto-reconnect**: If the broker restarts, MCP servers automatically re-register after ~5 seconds of failed polls — no manual `/mcp` reconnect needed.

## LAN Federation

Federation lets claude-peers instances on different machines discover and message each other over your local network.

### One-command setup (recommended)

```bash
# npm install:
bunx claude-peers federation init

# source install:
bun src/cli.ts federation init
```

On the second machine, use the join URL:

```bash
# npm install:
bunx claude-peers federation join cpt://192.168.1.100:7900/dGhpcyBpcyBhIHRlc3Q

# source install:
bun src/cli.ts federation join cpt://192.168.1.100:7900/dGhpcyBpcyBhIHRlc3Q
```

That's it. Federation auto-reconnects on broker restart. Use `federation doctor` to verify:

```bash
# npm install:
bunx claude-peers federation doctor

# source install:
bun src/cli.ts federation doctor
```

### mDNS auto-discovery

When federation is enabled, brokers advertise a `_claude-peers._tcp` service on the LAN via mDNS/Bonjour. Machines with matching PSK tokens auto-connect within 60 seconds -- no manual `federation connect` needed. mDNS is opt-out (disable with `federation.mdns.enabled: false` in config).

**Note:** mDNS does not work on WSL2 NAT mode (multicast is blocked by Hyper-V). Use `federation init` + `federation join` instead.

### Manual setup

1. Enable federation in `~/.claude-peers-config.json`:

```json
{
  "federation": {
    "enabled": true,
    "port": 7900,
    "subnet": "192.168.1.0/24"
  }
}
```

2. Copy `~/.claude-peers-token` to each machine (both must share the same token).

3. Restart: `bunx claude-peers restart` (or `bun src/cli.ts restart` from source)

4. Connect: `bunx claude-peers federation connect <remote-ip>:7900` (or `bun src/cli.ts federation connect <remote-ip>:7900`)

Once connected, `list_peers(scope="lan")` returns peers from all federated machines, and `send_message` works across machines using the `hostname:peer_id` format. Connections persist to the config file and auto-reconnect on broker restart.

## MCP Tools

These tools are available to Claude Code when the MCP server is running:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_peers` | `scope`: machine / directory / repo / lan | Discover other Claude Code sessions. Returns ID, name, PID, working directory, git root, summary, and timestamps. |
| `send_message` | `to_id`, `text`, `type?`, `metadata?`, `reply_to?` | Send a message to a peer. Remote peers use `hostname:peer_id` format. Supports threading via `reply_to`. |
| `broadcast_message` | `message`, `scope` | Send a message to all peers in the given scope (machine / directory / repo / lan). |
| `set_name` | `name` | Set a human-readable session name (e.g., from `/rename`). Visible to peers in discovery. |
| `set_summary` | `summary` | Set a work summary visible to peers. Convention: prefix with `[SessionName]`. |
| `check_messages` | *(none)* | Poll broker for undelivered messages. Use as fallback when channel push notifications aren't appearing. |
| `message_status` | `message_id` | Check delivery status of a previously sent message by its ID. |
| `channel_health` | *(none)* | Diagnose messaging health: broker status, pending messages, and dedup state. |

### Message types

Messages carry a `type` field for semantic routing:

| Type | Purpose |
|------|---------|
| `text` | General message (default) |
| `query` | Asking a question -- expects a response |
| `response` | Reply to a previous message |
| `handoff` | Task delegation to another session |
| `broadcast` | Group announcement |

## CLI Commands

Run with `bunx claude-peers <command>` (npm install) or `bun src/cli.ts <command>` (source install):

| Command | Description |
|---------|-------------|
| `status` | Broker health, peer count, and detailed peer list |
| `peers` | List all registered peers (compact format) |
| `send <id> <message>` | Send a message to a peer by ID |
| `broadcast <scope> <message>` | Broadcast to all peers in scope |
| `set-name <id> <name>` | Set a peer's session name |
| `auto-summary <id>` | Generate and set a deterministic git-based summary |
| `rotate-token` | Rotate the bearer auth token |
| `reload-broker` | Hot-reload broker config via SIGHUP (no restart needed) |
| `restart` | Kill broker + all MCP servers, restart cleanly |
| `kill-broker` | Stop the broker daemon |
| `federation init` | One-command setup (config, certs, firewall, join URL) |
| `federation join <cpt-url>` | Join a federation using a `cpt://` URL |
| `federation token` | Generate a `cpt://` URL for other machines to join |
| `federation doctor` | Diagnose federation health (checks all prerequisites) |
| `federation connect <host>:<port>` | Connect to a remote broker (persists to config) |
| `federation disconnect <host>:<port>` | Disconnect (removes from config) |
| `federation status` | Show federation state and connected remotes |
| `federation refresh-wsl2` | Update WSL2 port forwarding if IP changed |
| `federation enable [port] [subnet]` | Enable federation in config file |
| `federation disable` | Disable federation in config file |

## Configuration

### Config file

`~/.claude-peers-config.json` -- persistent configuration. Created automatically by `federation init`.

```json
{
  "federation": {
    "enabled": true,
    "port": 7900,
    "subnet": "192.168.1.0/24",
    "remotes": [
      { "host": "192.168.1.42", "port": 7900, "label": "rafi-macbook" }
    ],
    "mdns": {
      "enabled": true
    }
  },
  "server": {
    "startup_timeout_ms": 15000
  }
}
```

### Environment variables

Environment variables override config file values.

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PEERS_PORT` | `7899` | Broker HTTP port |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database path |
| `CLAUDE_PEERS_TOKEN` | `~/.claude-peers-token` | Auth token file path |
| `CLAUDE_PEERS_FEDERATION_ENABLED` | `false` | Enable LAN federation |
| `CLAUDE_PEERS_FEDERATION_PORT` | `7900` | Federation TLS port |
| `CLAUDE_PEERS_FEDERATION_SUBNET` | auto-detected | Allowed CIDR range for federation connections |
| `CLAUDE_PEERS_FEDERATION_CERT` | `~/.claude-peers-federation.crt` | TLS certificate path |
| `CLAUDE_PEERS_FEDERATION_KEY` | `~/.claude-peers-federation.key` | TLS private key path |
| `CLAUDE_PEERS_STARTUP_TIMEOUT_MS` | `15000` | MCP server startup timeout (ms, min 3000) |
| `CLAUDE_PEERS_MDNS_ENABLED` | `true` | Enable/disable mDNS auto-discovery |

## Architecture

```
                  +--------------------------+
                  |     Broker Daemon        |
                  |   localhost:7899 (HTTP)  |
                  |   localhost:7900 (TLS)   |  <-- Federation
                  |   SQLite state store     |
                  +------+-----------+------+
                         |           |
                    MCP Server A  MCP Server B     (stdio, one per session)
                         |           |
                    Claude A     Claude B
```

Three components, two processes:

| Component | Process | Description |
|-----------|---------|-------------|
| **Broker** (`src/broker.ts`) | Singleton daemon | HTTP API on port 7899 for peer registry and message routing. Federation TLS server on port 7900 (same process). SQLite for state. Auto-launched by the first MCP server. |
| **MCP Server** (`src/server.ts`) | One per session | Stdio MCP server registered with Claude Code. Spawns the broker if needed. Handles tool calls, polls for messages, pushes them into the session via channel notifications. |
| **CLI** (`src/cli.ts`) | On-demand | Terminal utility for inspecting state, sending messages, and managing federation. Communicates with the broker over HTTP. |

All local communication (server-to-broker, CLI-to-broker) uses bearer token auth. Federation (broker-to-broker) uses TLS with PSK headers and HMAC-signed payloads.

## Security

| Layer | Mechanism |
|-------|-----------|
| **Local auth** | Bearer token (`~/.claude-peers-token`, auto-generated). All broker POST endpoints require it. |
| **Hot reload** | Send `SIGHUP` (or `bunx claude-peers reload-broker`) to reload token + config without restart. |
| **Federation transport** | TLS with self-signed certificates (RSA-2048 for macOS LibreSSL compatibility). |
| **Federation auth** | Pre-shared key (PSK) in `X-Claude-Peers-PSK` header. Both machines must share `~/.claude-peers-token`. |
| **Message integrity** | HMAC-SHA256 signing on all federation relay requests. |
| **Subnet filtering** | Configurable CIDR allowlist for federation connections. Rejects connections from outside the range. |
| **Rate limiting** | 60 requests/min per IP on message endpoints. `/health`, `/register`, and `/heartbeat` are exempt. |
| **Message limits** | 10KB max payload per message. |
| **Stale cleanup** | Dead peers (PID check) removed every 30s. Delivered messages purged after 7 days. |
| **Localhost binding** | Broker HTTP API binds to `127.0.0.1` only -- not reachable from the network. |

## Project Structure

```
claude-peers-mcp/
  src/
    broker.ts              # Broker state, timers, server lifecycle, SIGHUP hot-reload
    broker-handlers.ts     # Request handlers in factory closures (hot-reloadable)
    server.ts              # MCP stdio server + three-layer delivery + auto-reconnect
    cli.ts                 # CLI utility (federation init/join/doctor/refresh-wsl2)
    federation.ts          # TLS cert generation, HMAC signing, subnet filtering
    mdns.ts                # mDNS auto-discovery via bonjour-service
    index.ts               # Package entry point
    shared/
      types.ts             # TypeScript interfaces + BrokerContext/BrokerStatements
      token.ts             # Shared bearer token reader
      summarize.ts         # Deterministic git-based auto-summary
      config.ts            # Config file reader/writer (~/.claude-peers-config.json)
  tests/
    broker.test.ts         # Broker + federation endpoint tests (43 tests)
    server.test.ts         # MCP server integration tests (18 tests)
    federation.test.ts     # Federation TLS/PSK/HMAC/subnet tests (22 tests)
    cli.test.ts            # CLI + auto-summary tests (17 tests)
  docs/
    TROUBLESHOOTING.md     # Diagnostic guide
  cpm-logs/                # Runtime logs (gitignored)
  package.json
  CHANGELOG.md
```

## Testing

104 tests, 318 assertions.

```bash
bun test                           # Run all tests
bun test tests/broker.test.ts      # Broker + federation endpoints (43)
bun test tests/server.test.ts      # MCP server integration (18)
bun test tests/federation.test.ts  # Federation TLS/PSK/HMAC (22)
bun test tests/cli.test.ts         # CLI + auto-summary (17)
```

## Observability

Logs in `cpm-logs/` (gitignored): `messages.log`, `broker.log`, `server.log`, `federation.log`.

```bash
tail -f cpm-logs/*.log             # Watch all logs
bunx claude-peers status           # Broker state from terminal (npm)
bun src/cli.ts status              # Broker state from terminal (source)
```

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for diagnostic steps and common issues.

## Requirements

- [Bun](https://bun.sh) 1.x+ runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 2.1+
- Claude.ai login (channel push requires it -- API key auth does not support channels)

## Fork Differences from Upstream

This is a fork of [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) with significant additions:

| Feature | Description |
|---------|-------------|
| LAN federation | Cross-machine peer discovery and messaging with TLS, PSK, and HMAC security |
| mDNS auto-discovery | Zero-config peer discovery on LAN via `_claude-peers._tcp` Bonjour service |
| Federation CLI | `init`, `join`, `doctor`, `token`, `refresh-wsl2`, connect/disconnect with persistence |
| Deterministic peer IDs | SHA-256 TTY-based IDs stable across `/mcp` reconnects |
| Three-layer delivery | Channel push → piggyback on tool call → safety-net polling. Mitigates Claude Code's ~30-50% notification drop rate |
| Auto-reconnect | MCP servers re-register automatically after broker restart (~5s detection) |
| Simplified delivery | Push once, ack immediately, dedup via Set, `check_messages` as manual fallback |
| Session identification | Persistent session names, auto-summaries with `[SessionName:TTY]` prefix, registration age in `list_peers`, immediate summary on rename |
| Startup reliability | 3-attempt retry with backoff, configurable timeout, broker request priority |
| Structured messages | Message types (text, query, response, handoff, broadcast), JSON metadata, threading |
| Broadcast messaging | Scoped group messaging to all peers in machine/directory/repo/LAN |
| Bearer token auth | Auto-generated token on all broker endpoints with SIGHUP rotation |
| Auto-summary | Deterministic git-based summaries (no external API dependencies) |
| Config file | `~/.claude-peers-config.json` with federation, remotes, mDNS, server settings |
| Diagnostics | `channel_health` MCP tool, `message_status` tool for delivery verification |
| Rate limiting | 60 req/min per IP on message endpoints |
| Message safeguards | 10KB size limit, 7-day delivered message cleanup |
| Zombie prevention | Parent death detection + TTY-based eviction for stale MCP servers |
| Full test suite | 104 tests, 318 assertions across broker, server, federation, and CLI |
| Observability | Centralized logs in `cpm-logs/`, CLI status command |

## License

MIT
