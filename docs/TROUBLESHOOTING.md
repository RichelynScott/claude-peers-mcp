# Troubleshooting — claude-peers-mcp

## Quick Diagnostics

```bash
# Is the broker running?
bun src/cli.ts status

# Who's connected?
bun src/cli.ts peers

# Watch message traffic in real time
tail -f cpm-logs/messages.log

# Watch broker events (startup, cleanup, errors)
tail -f cpm-logs/broker.log

# Watch MCP server events (registration, polling, errors)
tail -f cpm-logs/server.log

# Watch everything at once
tail -f cpm-logs/*.log
```

## Log Files

All application logs are in `cpm-logs/` (gitignored, local only):

| File | Contents |
|------|----------|
| `cpm-logs/messages.log` | All sent and received messages with timestamps and sender names |
| `cpm-logs/broker.log` | Broker lifecycle: startup, peer cleanup, message cleanup, errors |
| `cpm-logs/server.log` | MCP server: registration, polling, connection events, errors |

Note: Claude Code hook logs (chat.json, pre_tool_use.json, etc.) are in `logs/` — these are unrelated to CPM.

---

## Common Issues

### Messages Not Being Delivered

**Symptoms**: Messages show as sent but recipient session never receives them. `send_message` returns success but no channel notification appears.

**Most likely cause**: Stale MCP server processes from a previous session or path change.

**Quick fix**:
```bash
bun src/cli.ts restart
```
Then run `/mcp` in each Claude Code session to reconnect.

**How to diagnose**:
```bash
# Check how many MCP server processes are running
ps aux | grep "bun.*server.ts" | grep -v grep

# You should see exactly one per active Claude session
# If you see extras (especially from different paths), that's the problem
```

**Root cause**: When the MCP config path changes or a session restarts, the old MCP server process may survive and continue polling/consuming messages. The new session registers a fresh MCP server, but the zombie consumes messages first.

**Prevention**: As of v0.3.0, server.ts automatically detects and kills stale MCP server processes on startup. If you still hit this issue, use `bun src/cli.ts restart`.

### "Message sent" but recipient never received it (version mismatch)

**Cause**: The broker or recipient's MCP server is running old code. The two-phase delivery system (`/poll-messages` + `/ack-messages`) requires both broker AND MCP server to be on the same version.

**Fix**:
1. Kill the broker: `bun src/cli.ts kill-broker` (or `bun src/cli.ts restart` for a full reset)
2. Reconnect MCP in EVERY active session: run `/mcp` in each Claude Code instance
3. The broker auto-restarts when the first session reconnects

**How it works now**: Messages are only marked delivered AFTER the recipient's MCP server successfully pushes the channel notification. If the notification fails, the message stays undelivered and retries on the next 1-second poll cycle.

### "Peer X is not running (PID Y dead)"

**Cause**: The target peer's Claude Code process exited. The broker checks PID liveness before accepting messages.

**Fix**: The target session needs to be restarted. If you believe the session IS running, the peer may have re-registered with a new ID after a broker restart. Run `bun cli.ts peers` to find the current ID.

### Broker won't start / EADDRINUSE

**Cause**: Another broker instance is already running on port 7899.

**Fix**:
```bash
# Find and kill the process holding the port
lsof -ti :7899 | xargs kill -9
# Wait a second, then let it auto-restart via MCP, or start manually:
bun src/broker.ts
```

### MCP tools not available / "Not registered with broker yet"

**Cause**: The MCP server hasn't registered with the broker yet (broker may be down), or the MCP connection was lost.

**Fix**: Run `/mcp` in your Claude Code session to reconnect. If the broker is down, the MCP server will auto-launch it on reconnect.

### Rate limited (429)

**Cause**: More than 60 requests per minute from the same IP. Since this is localhost-only, all sessions share one rate limit bucket.

**Fix**: Wait 60 seconds for the window to reset. If you're hitting this during tests, the rate limit test in `broker.test.ts` intentionally exhausts the window — run it last or on an alternate port.

### Tests fail after code changes

**Cause**: The test suite starts its own broker on port 17899 with a temp DB. If a previous test run left a zombie broker, the new one can't bind the port.

**Fix**:
```bash
# Kill any leftover test broker
lsof -ti :17899 | xargs kill -9 2>/dev/null
# Clean temp DB
rm -f /tmp/claude-peers-test.db
# Re-run
bun test broker.test.ts
```

### Messages piling up / never delivered

**Cause**: The recipient's MCP server is polling but failing to ack. Check for errors in the MCP server stderr.

**Diagnosis**:
```bash
# Check undelivered message count directly in SQLite
sqlite3 ~/.claude-peers.db "SELECT COUNT(*) FROM messages WHERE delivered = 0"

# Check who has pending messages
sqlite3 ~/.claude-peers.db "SELECT to_id, COUNT(*) as pending FROM messages WHERE delivered = 0 GROUP BY to_id"
```

### Stale peers in list after broker restart

**Cause**: When the broker restarts, it cleans up peers whose PIDs are dead (`cleanStalePeers`). But if a PID was recycled by the OS (a new process got the same PID), the stale peer won't be cleaned.

**Fix**: This is rare on modern systems. If it happens, manually unregister:
```bash
curl -s -X POST http://127.0.0.1:7899/unregister \
  -H 'Content-Type: application/json' \
  -d '{"id": "STALE_PEER_ID"}'
```

---

## After Code Changes — Restart Checklist

Whenever you modify `src/broker.ts`, `src/server.ts`, or `src/shared/types.ts`:

1. **Build check**: `bun build src/broker.ts --outfile /tmp/check.js` (and same for server.ts, cli.ts)
2. **Run tests**: `bun test broker.test.ts`
3. **Kill broker**: `bun src/cli.ts kill-broker` (or `bun src/cli.ts restart` for a full reset)
4. **Reconnect MCP** in every active session: `/mcp` in each Claude Code instance
5. The broker auto-launches with new code when the first session's MCP server connects

Changes to `src/cli.ts` only do NOT require broker or MCP restart — the CLI runs fresh each invocation.

---

## Architecture Quick Reference

```
Claude Code Session A          Claude Code Session B
    |                              |
    v                              v
[MCP Server A]                [MCP Server B]
(server.ts, stdio)            (server.ts, stdio)
    |                              |
    |--- poll every 1s ----------->|
    |                              |--- poll every 1s --->
    v                              v
         [Broker] (broker.ts)
         HTTP on 127.0.0.1:7899
         SQLite: ~/.claude-peers.db
```

- **Broker**: Singleton. One per machine. Auto-launched by MCP server if not running.
- **MCP Server**: One per Claude Code session. Stdio transport. Registers on startup, polls every 1s.
- **Messages**: Stored in SQLite. Two-phase delivery: poll (fetch) then ack (confirm receipt).
- **Channel Push**: MCP server pushes messages via `notifications/claude/channel` for immediate delivery.

## Key Files

| File | What it does | When to restart after changes |
|------|-------------|-------------------------------|
| `src/broker.ts` | HTTP server + SQLite | Kill broker (`bun src/cli.ts kill-broker`) or `bun src/cli.ts restart` |
| `src/server.ts` | MCP server + channel push | Reconnect MCP (`/mcp` in session) |
| `src/shared/types.ts` | TypeScript interfaces | Both broker + MCP |
| `src/cli.ts` | CLI utility | No restart needed |
| `broker.test.ts` | Test suite | No restart needed |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_PEERS_PORT` | `7899` | Broker HTTP port |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database path |
| `OPENAI_API_KEY` | (none) | Auto-summary via gpt-5.4-nano (optional) |

## SQLite Direct Access

```bash
# Interactive shell
sqlite3 ~/.claude-peers.db

# Useful queries
.tables                                          -- peers, messages
SELECT * FROM peers;                             -- all registered peers
SELECT * FROM messages WHERE delivered = 0;      -- pending messages
SELECT * FROM messages ORDER BY sent_at DESC LIMIT 10;  -- recent messages
```
