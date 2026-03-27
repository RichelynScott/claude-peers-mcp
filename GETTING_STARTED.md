# Getting Started with claude-peers-mcp

A step-by-step guide to get peer messaging working between your Claude Code sessions. Takes about 5 minutes.

## Prerequisites

- [Bun](https://bun.sh) v1.1+ installed (`curl -fsSL https://bun.sh/install | bash`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 2.1+ installed
- A Claude.ai login (API-key-only auth does not support channel push)

## Step 1: Install

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

Expected output (from source):
```
bun install v1.x.x
Resolving dependencies... done
Installed 2 packages
```

## Step 2: Register the MCP server

This tells Claude Code to load claude-peers in every session:

```bash
claude mcp add --scope user --transport stdio claude-peers \
  -- bun $PWD/src/server.ts
```

Expected output:
```
Added stdio MCP server claude-peers for user with command: bun /path/to/claude-peers-mcp/src/server.ts
```

**Verify it registered:**
```bash
cat ~/.claude.json | grep claude-peers
```

You should see a `"claude-peers"` entry in the `mcpServers` section.

## Step 3: Enable channel push (real-time messages)

Without this step, messages are stored but invisible to your session. Add this wrapper to your shell config:

**For Zsh (~/.zshrc):**
```bash
echo 'claude() { command claude --dangerously-load-development-channels server:claude-peers "$@"; }' >> ~/.zshrc
source ~/.zshrc
```

**For Bash (~/.bashrc):**
```bash
echo 'claude() { command claude --dangerously-load-development-channels server:claude-peers "$@"; }' >> ~/.bashrc
source ~/.bashrc
```

## Step 4: Open two Claude Code sessions

Open **two separate terminals** and start Claude Code in each:

**Terminal 1:**
```bash
claude
```

When prompted about loading development channels, select "I am using this for local development".

**Terminal 2:**
```bash
claude
```

Same prompt — accept it.

Both sessions are now connected to the peer network. The broker daemon starts automatically when the first session connects.

## Step 5: Name your sessions

In **Terminal 1**, type:
```
/rename WORKER_A
```

In **Terminal 2**, type:
```
/rename WORKER_B
```

This makes sessions identifiable to each other. You'll see names like `WORKER_A` instead of opaque 8-character IDs.

## Step 6: Discover peers

In either session, ask Claude:
```
Who else is connected? Use list_peers with scope "machine"
```

Expected output:
```
Found 1 peer(s) (scope: machine):

**WORKER_B** (a1b2c3d4)
  PID: 12345  |  CWD: /home/user/project  Active: 2m
  TTY: pts/1
  Summary: [WORKER_B:pts/1] Working in project
  Last seen: 2026-03-27T...
```

## Step 7: Send a message

In Terminal 1 (WORKER_A), ask Claude:
```
Send a message to WORKER_B saying "Hello from WORKER_A!"
```

Claude will call `send_message` with the peer ID. In Terminal 2, the message appears as a live interrupt:

```
<channel source="claude-peers" from_name="WORKER_A" ...>
Hello from WORKER_A!
</channel>
```

Claude in Terminal 2 will automatically acknowledge it.

## Step 8: Verify it works both ways

In Terminal 2 (WORKER_B), reply:
```
Reply to WORKER_A saying "Got your message, everything works!"
```

If the message appears in Terminal 1 — congratulations, peer messaging is working!

## How message delivery works

Messages have three chances to reach your session:

1. **Channel push** (instant) — works most of the time
2. **Piggyback on tool call** (next interaction) — catches messages that channel push missed
3. **Safety-net poll** (every 30s) — final fallback for edge cases

If a message doesn't appear immediately, it will surface on your next tool call. You can also manually check:
```
Check for any messages I might have missed
```
Claude will call `check_messages` to retrieve them.

## Troubleshooting

**"No other Claude Code instances found"**
- Make sure both sessions are running and registered
- Try: `bun src/cli.ts status` from the repo directory to see broker state

**Messages not appearing**
- Channel push is ~50-70% reliable (Claude Code platform limitation)
- Messages are never lost — they'll appear on your next tool call via piggyback delivery
- Manual check: ask Claude to call `check_messages`

**"/mcp reconnect fails"**
- Try a full session restart: `/exit` then reopen with `claude`
- Claude Code caches MCP config in memory — `/mcp` uses the cached path

**Broker won't start**
- Check if port 7899 is in use: `lsof -i :7899`
- Kill stale broker: `bun src/cli.ts kill-broker`

## Next steps

- **LAN Federation**: Connect sessions across machines. See [README.md](README.md#lan-federation)
- **Structured messages**: Use message types (query, response, handoff) for semantic routing
- **CLI tools**: `bun src/cli.ts status` for broker health, `bun src/cli.ts peers` for peer list
- **Troubleshooting guide**: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
