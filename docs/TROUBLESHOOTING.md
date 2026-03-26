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

**Quick diagnosis** (v0.4.0+):
```bash
# Use the channel_health MCP tool from any session
# Or check delivery status of a specific message:
# Use the message_status MCP tool with the message ID

# Check from SQLite directly:
sqlite3 ~/.claude-peers.db "SELECT id, delivered, sent_at FROM messages WHERE id = <MSG_ID>"
# delivered=0 means undelivered, delivered=1 means acked
```

**Possible causes** (in order of likelihood):

1. **Claude Code silently dropping channel notifications** (KNOWN ISSUE — see below)
2. **Stale MCP server processes** consuming messages
3. **Channel push not enabled** (missing `--dangerously-load-development-channels` flag)
4. **`/mcp` reconnect broke channel subscriptions** (requires full session restart)

**Quick fix**:
```bash
bun src/cli.ts restart
```
Then **fully restart** each Claude Code session (`/exit` + reopen, not just `/mcp`).

### KNOWN ISSUE: Claude Code Silently Drops Channel Notifications

**Status**: Under investigation. This is the #1 reliability issue in claude-peers.

**What happens**: `mcp.notification()` succeeds (bytes written to stdout), the MCP SDK Promise resolves, but Claude Code never renders the notification. The message is gone — the recipient never sees it. This happens ~30-50% of the time for same-machine messages.

**What we know**:
- The MCP SDK's `notification()` method is fire-and-forget (JSON-RPC 2.0 spec). It resolves when bytes are written to the stdio pipe, NOT when Claude Code processes them.
- There is no delivery confirmation signal from Claude Code back to the MCP server.
- The `--dangerously-load-development-channels server:claude-peers` flag IS active on affected sessions.
- The receiving MCP server logs `MESSAGE RECEIVED` with full content — it polled and pushed the message.
- The recipient was idle (not mid-response) when the message arrived.
- Both same-machine and cross-machine (federation) messages are affected.
- Sometimes it works perfectly, sometimes it doesn't — no clear pattern identified.

**Possible causes** (unconfirmed):
- Claude Code's internal notification dispatcher may have a queue/buffer that drops messages under certain conditions
- Channel subscription state may be lost after certain internal events (not just `/mcp`)
- Model-dependent behavior — different Claude models (Sonnet, Opus, Haiku) may handle channel notifications differently
- Schema validation inside Claude Code may silently reject certain notification payloads

**Mitigations in v0.4.0**:
- **Deferred ack**: Messages are not acked to the broker until confirmed received. They stay in a pending buffer for 120s, giving `check_messages` a chance to recover them.
- **`check_messages` fallback**: Returns pending (pushed but unconfirmed) + new broker messages. Use this when channel notifications aren't appearing.
- **Sender delivery warnings**: If a message is still undelivered after 30s, the sender gets a channel notification warning. Auto-generates a bug report in `BUG_REPORTS/`.
- **`channel_health` tool**: Diagnoses messaging state including pending counts and delivery failures.

**What does NOT work**:
- `check_messages` in v0.3.0 returned empty because messages were already acked (fixed in v0.4.0)
- Relying on `mcp.notification()` success as proof of delivery (it only proves bytes hit stdout)

**If you're experiencing this**, call `check_messages` periodically as a fallback — it will surface messages that channel push missed.

### Stale MCP Server Processes

**Cause**: When the MCP config path changes or a session restarts, the old MCP server process may survive and continue polling/consuming messages.

**How to diagnose**:
```bash
# Check how many MCP server processes are running
ps aux | grep "bun.*server.ts" | grep -v grep

# You should see exactly one per active Claude session
# If you see extras (especially from different paths), that's the problem
```

**Prevention**: As of v0.3.0, server.ts automatically detects and kills stale MCP server processes on startup. If you still hit this issue, use `bun src/cli.ts restart`.

### MCP Server Fails to Connect After Path Change or Update

**Symptoms**: `/mcp` → "Failed to reconnect to claude-peers". The MCP server worked before but stopped after a code update, repo restructure, or config change.

**Root cause**: Claude Code caches the MCP server config (command + args) in memory. `/mcp` reconnect uses the **cached** config, not the current file on disk. If you changed the server path in `.mcp.json` or `~/.claude.json`, `/mcp` reconnect will still try the OLD path.

**Fix**: You must **fully restart the Claude Code session** — `/exit` then reopen. `/mcp` alone is not enough.

**Also check**: There may be MULTIPLE `.mcp.json` files defining claude-peers:
```bash
# Find all config files referencing claude-peers
find ~ -name ".mcp.json" -exec grep -l "claude-peers" {} \; 2>/dev/null

# Common locations:
# ~/.claude.json          — global config (all sessions)
# ~/.claude/.mcp.json     — project config for sessions in ~/.claude/
# <project>/.mcp.json     — project config for that repo
```

If a project-level `.mcp.json` defines claude-peers, it **overrides** the global config. Make sure ALL config files have the correct path. Also check for `"disabled": true` which silently prevents the server from starting.

### "Message sent" but recipient never received it (version mismatch)

**Cause**: The broker or recipient's MCP server is running old code. The two-phase delivery system (`/poll-messages` + `/ack-messages`) requires both broker AND MCP server to be on the same version.

**Fix**:
1. Kill the broker: `bun src/cli.ts kill-broker` (or `bun src/cli.ts restart` for a full reset)
2. Reconnect MCP in EVERY active session: run `/mcp` in each Claude Code instance
3. The broker auto-restarts when the first session reconnects

**How it works now**: Messages are only marked delivered AFTER the recipient's MCP server successfully pushes the channel notification. If the notification fails, the message stays undelivered and retries on the next 1-second poll cycle.

### "Peer X is not running (PID Y dead)"

**Cause**: The target peer's Claude Code process exited. The broker checks PID liveness before accepting messages.

**Fix**: The target session needs to be restarted. If you believe the session IS running, the peer may have re-registered with a new ID after a broker restart. Run `bun src/cli.ts peers` to find the current ID.

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
  -H "Authorization: Bearer $(cat ~/.claude-peers-token)" \
  -H 'Content-Type: application/json' \
  -d '{"id": "STALE_PEER_ID"}'
```

### Federation Setup

**One-command setup** (v0.4.0+):
```bash
bun src/cli.ts federation init       # Configures everything, outputs a join URL
```

**On the second machine**, use the join URL:
```bash
bun src/cli.ts federation join cpt://192.168.1.100:7900/<token>
```

**Verify setup**:
```bash
bun src/cli.ts federation doctor     # Checks every prerequisite, reports pass/fail
```

**WSL2 port forwarding refresh** (after reboot):
```bash
bun src/cli.ts federation refresh-wsl2
```

Connections persist to `~/.claude-peers-config.json` and auto-reconnect on broker restart.

### Federation Connect Fails: "Connection rejected: outside allowed subnet"

**Symptoms**: `bun src/cli.ts federation connect <ip>:7900` returns connection rejected or handshake failed.

**Most likely cause on WSL2**: The auto-detected subnet is the WSL2 internal NAT range (172.x.x.x), not your actual LAN subnet.

**Fix**: Manually set the subnet to match your LAN:
```bash
export CLAUDE_PEERS_FEDERATION_SUBNET=192.168.0.0/16  # Adjust for your LAN
```
Add this to your `~/.zshrc` and restart the broker.

**Fix for macOS/native Linux**: Auto-detection should work correctly. If not, set the env var manually.

### Federation TLS Handshake Failure (macOS → WSL2/Linux)

**Symptoms**: `curl: (35) SSL connect error` or `Handshake failed (0): unknown` when connecting from macOS to another machine.

**Cause**: The remote machine generated an Ed25519 TLS certificate, which macOS LibreSSL doesn't support for TLS negotiation.

**Fix**: Regenerate the cert on the remote machine:
```bash
rm ~/.claude-peers-federation.crt ~/.claude-peers-federation.key
# Restart the broker — it auto-generates a new RSA-2048 cert
bun src/cli.ts kill-broker
```

As of v0.3.0, new installations default to RSA-2048 for compatibility.

### Federation Connect Fails: "Handshake failed" or Connection Refused

**Symptoms**: `bun src/cli.ts federation connect <ip>:7900` fails with handshake error or connection refused.

**Check on the REMOTE machine**:
1. Is the broker running? `bun src/cli.ts status`
2. Is federation enabled? Check `tail cpm-logs/federation.log` for `Listening on 0.0.0.0:7900 (TLS)`
3. If not: `CLAUDE_PEERS_FEDERATION_ENABLED=true bun src/broker.ts`
4. macOS: Accept the firewall prompt for port 7900, or run:
   `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which bun) --unblockapp $(which bun)`

**Check from YOUR machine**:
1. Can you reach the remote? `ping <ip>`
2. Can you reach the port? `curl -sk https://<ip>:7900/health` (should return JSON or TLS error, not connection refused)
3. Is your subnet configured correctly? Check `cpm-logs/federation.log` for the subnet line

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
