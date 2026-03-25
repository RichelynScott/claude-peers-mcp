# claude-peers-mcp

Peer discovery and messaging for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instances -- on the same machine or across your LAN.

Multiple Claude Code sessions can find each other, exchange messages in real time, and coordinate work without any external services. Federation extends this across machines with TLS encryption and pre-shared key authentication.

**Key features:**

- **Peer discovery** -- find sessions by machine, directory, git repo, or LAN
- **Real-time messaging** -- instant delivery via Claude Code channel push
- **LAN federation** -- cross-machine collaboration with TLS + PSK + HMAC security
- **Structured messages** -- types (text, query, response, handoff, broadcast), metadata, threading
- **Broadcast** -- send to all peers in a given scope
- **Auto-summary** -- git-based context summaries with zero external API calls
- **CLI** -- inspect, message, and manage from your terminal

## What is MCP?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is a standard for connecting AI assistants to external tools and data sources. claude-peers-mcp is an MCP server that gives Claude Code the ability to discover and communicate with other Claude Code sessions.

## Quick Start

### 1. Install

Requires [Bun](https://bun.sh) (v1.1+).

```bash
git clone https://github.com/RichelynScott/claude-peers-mcp.git
cd claude-peers-mcp
bun install
```

### 2. Register the MCP server

Register as a user-scoped MCP so it loads in every Claude Code session:

```bash
claude mcp add --scope user --transport stdio claude-peers \
  -- bun /path/to/claude-peers-mcp/src/server.ts
```

### 3. Enable channel push

Channel push delivers messages instantly into your Claude Code session. Without it, messages must be polled manually via `check_messages`.

```bash
claude --dangerously-load-development-channels server:claude-peers
```

**Recommended:** Add a shell wrapper so the flag is always included:

```bash
# Add to ~/.zshrc or ~/.bashrc
function claude() {
  command claude --dangerously-load-development-channels server:claude-peers "$@"
}
```

### 4. Use it

The broker daemon starts automatically when the first MCP server connects. Open two or more Claude Code sessions and they will discover each other.

```
You: "Who else is working in this repo?"
Claude: [calls list_peers with scope "repo"]
Claude: "There's one other session working on the auth module..."
```

## LAN Federation

Federation lets claude-peers instances on different machines discover and message each other over your local network.

### Setup wizard (recommended)

The guided wizard detects your platform (WSL2, macOS, Linux) and walks you through firewall rules, port forwarding, and token sharing:

```bash
bun src/cli.ts federation setup
```

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

3. Restart: `bun src/cli.ts restart`

4. Connect: `bun src/cli.ts federation connect <remote-ip>:7900`

Once connected, `list_peers(scope="lan")` returns peers from all federated machines, and `send_message` works across machines using the `hostname:peer_id` format.

## MCP Tools

These tools are available to Claude Code when the MCP server is running:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_peers` | `scope`: machine / directory / repo / lan | Discover other Claude Code sessions. Returns ID, name, PID, working directory, git root, summary, and timestamps. |
| `send_message` | `to_id`, `text`, `type?`, `metadata?`, `reply_to?` | Send a message to a peer. Remote peers use `hostname:peer_id` format. Supports threading via `reply_to`. |
| `broadcast_message` | `message`, `scope` | Send a message to all peers in the given scope (machine / directory / repo / lan). |
| `set_name` | `name` | Set a human-readable session name (e.g., from `/rename`). Visible to peers in discovery. |
| `set_summary` | `summary` | Set a work summary visible to peers. Convention: prefix with `[SessionName]`. |
| `check_messages` | *(none)* | Manually poll for new messages. Fallback when channel push is unavailable. |

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

Run from the project directory with `bun src/cli.ts <command>`:

| Command | Description |
|---------|-------------|
| `status` | Broker health, peer count, and detailed peer list |
| `peers` | List all registered peers (compact format) |
| `send <id> <message>` | Send a message to a peer by ID |
| `broadcast <scope> <message>` | Broadcast to all peers in scope |
| `set-name <id> <name>` | Set a peer's session name |
| `restart` | Kill broker + all MCP servers, restart cleanly |
| `kill-broker` | Stop the broker daemon |
| `federation setup` | Guided setup wizard (WSL2 / macOS / Linux) |
| `federation connect <host>:<port>` | Connect to a remote broker |
| `federation disconnect <host>:<port>` | Disconnect from a remote broker |
| `federation status` | Show federation state and connected remotes |

## Configuration

### Config file

`~/.claude-peers-config.json` -- persistent configuration. Created automatically by the federation setup wizard.

```json
{
  "federation": {
    "enabled": true,
    "port": 7900,
    "subnet": "192.168.1.0/24"
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
| **Token rotation** | Send `SIGHUP` to the broker to reload the token file without restart. |
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
    broker.ts              # HTTP broker daemon + SQLite + federation TLS server
    server.ts              # MCP stdio server + channel push notifications
    cli.ts                 # CLI utility
    federation.ts          # TLS cert generation, HMAC signing, subnet filtering
    index.ts               # Package entry point
    shared/
      types.ts             # TypeScript interfaces
      token.ts             # Shared bearer token reader
      summarize.ts         # Deterministic git-based auto-summary
      config.ts            # Config file reader (~/.claude-peers-config.json)
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

100 tests, 302 assertions.

```bash
bun test                           # Run all tests
bun test tests/broker.test.ts      # Broker + federation endpoints
bun test tests/server.test.ts      # MCP server integration
bun test tests/federation.test.ts  # Federation TLS/PSK/HMAC
bun test tests/cli.test.ts         # CLI + auto-summary
```

## Observability

Logs in `cpm-logs/` (gitignored): `messages.log`, `broker.log`, `server.log`, `federation.log`.

```bash
tail -f cpm-logs/*.log        # Watch all logs
bun src/cli.ts status          # Broker state from terminal
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
| Federation CLI | Setup wizard, connect/disconnect/status commands with WSL2/macOS/Linux support |
| Structured messages | Message types (text, query, response, handoff, broadcast), JSON metadata, threading |
| Broadcast messaging | Scoped group messaging to all peers in machine/directory/repo/LAN |
| Bearer token auth | Auto-generated token on all broker endpoints with SIGHUP rotation |
| Session naming | `set_name` tool and CLI command, `from_name` in channel push metadata |
| Auto-summary | Deterministic git-based summaries (no external API dependencies) |
| Config file | `~/.claude-peers-config.json` for persistent settings |
| Rate limiting | 60 req/min per IP on message endpoints |
| Message safeguards | 10KB size limit, 7-day delivered message cleanup |
| Zombie prevention | Parent death detection + TTY-based eviction for stale MCP servers |
| Full test suite | 100 tests, 302 assertions across broker, server, federation, and CLI |
| Observability | Centralized logs in `cpm-logs/`, full message logging, CLI status command |

## License

MIT
