# claude-peers-mcp

Peer discovery and messaging for Claude Code instances.

## Overview

claude-peers-mcp lets multiple Claude Code sessions running on the same machine discover each other and exchange messages in real time. When one session needs information from another -- what files it's editing, what branch it's on, what task it's working on -- it can find and ask directly.

This is a private fork of [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) with additional features: session naming, hardened broker (rate limiting, message size limits, message cleanup), full message observability, and an extended CLI.

## Architecture

```
                 +--------------------------+
                 |  Broker Daemon           |
                 |  127.0.0.1:7899         |
                 |  SQLite (~/.claude-      |
                 |    peers.db)             |
                 +------+-------------+----+
                        |             |
                   MCP Server A   MCP Server B
                   (stdio)        (stdio)
                        |             |
                   Claude A       Claude B
```

There are three components:

| Component | File | Description |
|-----------|------|-------------|
| **Broker** | `src/broker.ts` | Singleton HTTP daemon on `127.0.0.1:7899`. Manages peer registry and message routing in a SQLite database. Auto-launched by the first MCP server that starts. |
| **MCP Server** | `src/server.ts` | One instance per Claude Code session, running as a stdio MCP server. Registers with the broker, exposes tools, polls for messages every second, and pushes them into the session via the `claude/channel` protocol. |
| **CLI** | `src/cli.ts` | Command-line utility for inspecting broker state, listing peers, and sending messages from outside Claude Code. |

Supporting files:

| File | Purpose |
|------|---------|
| `src/shared/types.ts` | TypeScript interfaces for all broker API request/response types |
| `src/shared/summarize.ts` | Auto-summary generation via OpenAI `gpt-5.4-nano` (optional, requires `OPENAI_API_KEY`) |

## Setup

### 1. Clone and install

```bash
git clone https://github.com/RichelynScott/claude-peers-mcp.git ~/MCPs/claude-peers-mcp
cd ~/MCPs/claude-peers-mcp
bun install
```

### 2. Register the MCP server

Add to your user-scoped MCP configuration so it is available in every Claude Code session:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/MCPs/claude-peers-mcp/src/server.ts
```

### 3. Run with channel push

Channel push enables instant message delivery into the Claude Code session. Without it, the tools still work, but messages must be polled manually via `check_messages`.

```bash
claude --dangerously-load-development-channels server:claude-peers
```

**ZSH wrapper (recommended):** If you have a ZSH wrapper function for `claude`, it can auto-include the `--dangerously-load-development-channels server:claude-peers` flag so you do not need to type it every time. Add something like this to `~/.zshrc`:

```bash
function claude() {
  command claude --dangerously-load-development-channels server:claude-peers "$@"
}
```

The broker daemon starts automatically the first time an MCP server connects. No manual broker management is needed.

## MCP Tools

These tools are available to Claude Code when the MCP server is running:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_peers` | `scope`: `"machine"` \| `"directory"` \| `"repo"` | Discover other Claude Code instances. Returns ID, session name, PID, working directory, git root, TTY, summary, and last-seen timestamp. |
| `send_message` | `to_id`: string, `message`: string | Send a message to another instance by peer ID. Delivered instantly via channel push. |
| `set_name` | `name`: string | Set a human-readable session name (typically from `/rename`). Visible to other peers in `list_peers` and included as `from_name` in channel push metadata. |
| `set_summary` | `summary`: string | Set a 1-2 sentence description of current work. Visible to peers in `list_peers`. Convention: prefix with `[SessionName]`. |
| `check_messages` | *(none)* | Manually poll for new messages. Fallback for when channel push is not available. |

## CLI Commands

Run from the project directory with `bun src/cli.ts <command>`:

| Command | Description |
|---------|-------------|
| `status` | Show broker health, peer count, and detailed list of all registered peers with session names |
| `peers` | List all registered peers (compact format) |
| `send <id> <message>` | Send a message to a peer by ID |
| `set-name <id> <name>` | Set a peer's session name from the command line |
| `kill-broker` | Stop the broker daemon |
| `restart` | Kill broker + all MCP server processes, then restart cleanly. Use after path changes or version upgrades. |
| `federation setup` | Guided federation setup wizard (WSL2/macOS/Linux) |
| `federation connect <host>:<port>` | Connect to a remote broker |
| `federation disconnect <host>:<port>` | Disconnect from a remote broker |
| `federation status` | Show federation state and connected remotes |

Examples:

```bash
bun src/cli.ts status
bun src/cli.ts peers
bun src/cli.ts send abc12345 "What branch are you on?"
bun src/cli.ts set-name abc12345 "MyAgent"
bun src/cli.ts kill-broker
bun src/cli.ts restart
```

## Federation Setup

Federation allows claude-peers instances on different machines to discover and message each other over your LAN. The guided setup command handles environment detection, prerequisites, and platform-specific network configuration:

```bash
# Enable federation and run setup
export CLAUDE_PEERS_FEDERATION_ENABLED=true
bun src/cli.ts federation setup
```

The wizard detects your platform (WSL2, macOS, or Linux) and walks you through:
- **WSL2**: Configures Windows port forwarding (`netsh portproxy`) and firewall rules via an elevated PowerShell prompt
- **macOS**: Checks the application firewall and prints the allow command if needed
- **Linux**: Detects LAN IP and prints firewall commands (UFW / firewalld)

Both machines must share the same authentication token. The setup command prints `scp` instructions for copying `~/.claude-peers-token` to the remote machine.

Once setup is complete on both machines, connect them:

```bash
bun src/cli.ts federation connect <remote-ip>:7900
```

Other federation CLI commands:

| Command | Description |
|---------|-------------|
| `federation status` | Show federation state, connected remotes, and remote peer counts |
| `federation connect <host>:<port>` | Connect to a remote broker |
| `federation disconnect <host>:<port>` | Disconnect from a remote broker |
| `federation setup` | Guided setup wizard (WSL2/macOS/Linux) |

For troubleshooting, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Observability

### stderr logging

The MCP server logs full message content to stderr with no truncation. This is visible in Claude Code's MCP log output. Both sent and received messages are logged with timestamps and sender identification.

### Persistent log file

All sent and received messages are appended to `~/.claude-peers-messages.log`. Monitor in real time:

```bash
tail -f ~/.claude-peers-messages.log
```

Each entry includes a timestamp, direction (SENT/received), peer ID, and full message text.

### CLI status

`bun cli.ts status` shows all registered peers with `[SESSION_NAME]` tags, PIDs, working directories, summaries, and last-seen timestamps.

## Broker API

All endpoints accept POST with JSON body and return JSON. The broker listens on `127.0.0.1:7899` (configurable via `CLAUDE_PEERS_PORT`).

| Method | Path | Request Body | Response |
|--------|------|-------------|----------|
| GET | `/health` | *(none)* | `{ status: "ok", peers: number }` |
| POST | `/register` | `{ pid, cwd, git_root, tty, session_name?, summary }` | `{ id: string }` |
| POST | `/heartbeat` | `{ id }` | `{ ok: true }` |
| POST | `/set-summary` | `{ id, summary }` | `{ ok: true }` |
| POST | `/set-name` | `{ id, session_name }` | `{ ok: true }` |
| POST | `/list-peers` | `{ scope, cwd, git_root, exclude_id? }` | `Peer[]` |
| POST | `/send-message` | `{ from_id, to_id, text }` | `{ ok: true }` or `{ ok: false, error: string }` |
| POST | `/poll-messages` | `{ id }` | `{ messages: Message[] }` |
| POST | `/unregister` | `{ id }` | `{ ok: true }` |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_PEERS_PORT` | `7899` | Broker HTTP port |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database file path |
| `OPENAI_API_KEY` | *(none)* | Enables auto-summary generation via `gpt-5.4-nano` on session startup |

## Security

- **Localhost only**: The broker binds to `127.0.0.1` and is not reachable from the network.
- **Rate limiting**: 60 requests per minute per IP. Returns HTTP 429 when exceeded. The `/health` endpoint is exempt.
- **Message size limit**: 10KB maximum per message. Oversized messages are rejected with an error.
- **Message cleanup**: Delivered messages older than 7 days are automatically purged. Cleanup runs on broker startup and every 60 seconds thereafter.
- **Stale peer cleanup**: Peers whose PIDs no longer exist are removed on broker startup and every 30 seconds.

## Fork Divergence from Upstream

Changes made beyond [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp):

| Feature | Description |
|---------|-------------|
| `session_name` field | First-class field in the peer registry. Stored in SQLite, returned in `list_peers`, included as `from_name` in channel push metadata. |
| `set_name` MCP tool | Allows Claude Code to set its session name (from `/rename`). |
| `set_name` CLI command | `bun cli.ts set-name <id> <name>` for setting peer names from the terminal. |
| `/set-name` broker endpoint | HTTP endpoint for updating a peer's session name. |
| Schema migration | `ALTER TABLE peers ADD COLUMN session_name` runs automatically on existing databases. |
| Rate limiting | 60 req/min per IP on all broker endpoints (except `/health`). |
| Message size limits | 10KB max per message, enforced at the broker. |
| Message cleanup | Delivered messages purged after 7 days. |
| Full message logging | Sent and received messages logged to stderr (no truncation) and `~/.claude-peers-messages.log`. |
| ZSH wrapper support | Documentation and pattern for auto-including `--dangerously-load-development-channels`. |

**Sync policy**: Periodic `git fetch upstream` with selective cherry-picks. See `FYI.md` for the backlog.

## Development

### Run the broker directly

```bash
bun src/broker.ts
```

The broker logs to stderr. It creates (or opens) the SQLite database at the configured path.

### Run the MCP server directly

```bash
bun src/server.ts
```

This auto-launches the broker if it is not already running, then connects via stdio.

### Run tests

```bash
bun test
```

### Type check

```bash
bunx tsc --noEmit
```

### Project structure

```
claude-peers-mcp/
  src/
    broker.ts          # HTTP broker daemon + SQLite
    server.ts          # MCP stdio server (one per Claude Code session)
    cli.ts             # CLI utility
    federation.ts      # LAN federation transport (TLS, HMAC, cert gen)
    index.ts           # Package entry point
    shared/
      types.ts         # TypeScript interfaces
      summarize.ts     # Auto-summary via git context
      token.ts         # Shared bearer token reader
  docs/
    TROUBLESHOOTING.md # Diagnostics and common issues
  package.json
  CLAUDE.md            # Project instructions for Claude Code
  FYI.md               # Decision journal and backlog
```

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code v2.1.80+
- claude.ai login (channels require it -- API key auth does not support channels)

## License

This project is a private fork. Upstream ([louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp)) does not specify a license.
