# PRD: Auto-Summary SessionStart Hook

## Introduction

Create a Claude Code SessionStart hook that automatically sets a deterministic peer summary when a new Claude Code session begins. The hook calls `bun cli.ts auto-summary <peer-id>` (from prd-auto-summary-cli.md) to generate and set the summary on the claude-peers broker. This ensures every session immediately has a meaningful summary visible to other peers, without requiring the user or the AI to manually call `set_summary`.

**Execution context**: This hook lives in `~/.claude/hooks/` and is configured in `~/.claude/settings.json`. It is NOT part of the claude-peers-mcp repository. Implementation should be done from a session in `~/.claude/` or manually.

**Dependency**: Requires the auto-summary CLI command (prd-auto-summary-cli.md) to be implemented first.

## Goals

- Automatically set a deterministic peer summary on every Claude Code session start
- Zero user intervention required — hook fires transparently on SessionStart
- Graceful failure — if broker isn't running or peer isn't registered yet, hook exits silently without blocking session startup
- Hook execution completes in under 2 seconds to avoid delaying session start

## User Stories

### US-001: Hook fires on session start

**Description:** As a Claude Code user, I want my peer summary to be set automatically when I start a session so that other peers can immediately see what directory and branch I'm working in.

**Acceptance Criteria:**
- [ ] Hook script exists at `~/.claude/hooks/cpm-auto-summary.sh` (or `.py`)
- [ ] Hook is registered in `~/.claude/settings.json` under the `SessionStart` event
- [ ] On session start, the hook calls `bun ~/MCPs/claude-peers-mcp/cli.ts auto-summary <peer-id>`
- [ ] The peer summary is visible to other peers via `list_peers` within 3 seconds of session start

### US-002: Hook discovers its own peer ID

**Description:** As a hook script, I need to determine my session's peer ID so I can pass it to the `auto-summary` CLI command.

**Acceptance Criteria:**
- [ ] Hook uses one of these strategies to get peer ID:
  - Strategy A: Parse the MCP server's stderr logs for the "Registered as peer <id>" line
  - Strategy B: Query `/list-peers` filtering by PID (`$$` or parent PID) to find self
  - Strategy C: The MCP server writes its peer ID to a temp file (e.g., `/tmp/claude-peers-<pid>.id`) on registration, hook reads it
- [ ] If peer ID cannot be determined (broker not running, registration not complete), hook exits with code 0 (non-blocking)
- [ ] Strategy chosen must work reliably within the SessionStart timing window

### US-003: Hook fails silently on errors

**Description:** As a Claude Code user, I don't want a broken hook to block my session from starting.

**Acceptance Criteria:**
- [ ] If `cli.ts auto-summary` exits with non-zero code, hook exits 0 (success) — never blocks session
- [ ] If broker is not running, hook exits 0
- [ ] If bun is not installed, hook exits 0
- [ ] Hook has a 3-second timeout — if `auto-summary` hangs, hook kills it and exits 0
- [ ] Errors are logged to `~/.claude/logs/cpm-auto-summary.log` for debugging

### US-004: Hook configuration in settings.json

**Description:** As a Claude Code configuration, the hook must be properly registered to fire on SessionStart.

**Acceptance Criteria:**
- [ ] `~/.claude/settings.json` includes the hook in the `hooks` section:
  ```json
  {
    "hooks": {
      "SessionStart": [
        {
          "command": "bash ~/.claude/hooks/cpm-auto-summary.sh",
          "timeout": 3000
        }
      ]
    }
  }
  ```
- [ ] Hook does not conflict with any existing SessionStart hooks
- [ ] Hook can be disabled by removing the entry from settings.json

## Functional Requirements

- **FR-1**: Hook script is a bash script at `~/.claude/hooks/cpm-auto-summary.sh` with `#!/bin/bash` shebang and executable permission (`chmod +x`)
- **FR-2**: Hook determines peer ID by querying the broker's `/list-peers` endpoint, filtering by the current process's parent PID (the Claude Code process that spawned the hook). Uses `curl` for HTTP call, `jq` for JSON parsing.
- **FR-3**: Hook calls `bun ~/MCPs/claude-peers-mcp/cli.ts auto-summary <peer-id>` with a 2-second timeout via `timeout 2`
- **FR-4**: All errors are redirected to `~/.claude/logs/cpm-auto-summary.log` with timestamps
- **FR-5**: Hook always exits with code 0 regardless of internal success/failure
- **FR-6**: Hook includes a brief `sleep 1` at the start to allow the MCP server time to register with the broker before querying for peer ID
- **FR-7**: The settings.json entry uses a 3-second timeout to account for the 1s sleep + 2s command timeout

## Non-Goals (Out of Scope)

- **NG-1**: Modifying `server.ts` to expose peer ID (the hook discovers it externally)
- **NG-2**: Running the hook on any event other than SessionStart
- **NG-3**: Setting session name (that's a separate concern — `/rename` + `set_name`)
- **NG-4**: Updating the summary during the session (summary reflects initial state only; user/AI can call `set_summary` later)
- **NG-5**: Supporting non-bash environments (Windows native, PowerShell)
- **NG-6**: Auto-installing the hook (user must add the settings.json entry manually or via the setup-docs skill)

## Technical Considerations

### File Paths (all in `~/.claude/`)

| File | Change Type | Description |
|------|-------------|-------------|
| `~/.claude/hooks/cpm-auto-summary.sh` | Create | Hook script (~30-40 lines) |
| `~/.claude/settings.json` | Modify | Add SessionStart hook entry |
| `~/.claude/logs/cpm-auto-summary.log` | Created at runtime | Error/debug log |

### Peer ID Discovery Challenge

The hook fires during SessionStart. At that point, the MCP server may or may not have registered with the broker yet. The timing is:

1. Claude Code starts
2. SessionStart hooks fire
3. MCP servers initialize (including claude-peers)
4. claude-peers MCP server registers with broker

The hook needs the peer ID from step 4, but fires at step 2. Solutions:
- **1-second sleep** to let registration happen (pragmatic, usually works)
- **Retry loop** with 3 attempts, 500ms apart (more robust)
- **Query by PID** — even if registration happens during the hook, the PID is known immediately

Recommended: Retry loop with PID-based lookup.

### Hook Script Skeleton

```bash
#!/bin/bash
# cpm-auto-summary.sh — SessionStart hook for claude-peers auto-summary
LOG="$HOME/.claude/logs/cpm-auto-summary.log"
CLI="$HOME/MCPs/claude-peers-mcp/cli.ts"
BROKER="http://127.0.0.1:${CLAUDE_PEERS_PORT:-7899}"

log() { echo "[$(date -Iseconds)] $1" >> "$LOG"; }

# Wait for MCP server to register, then find our peer ID by parent PID
PPID_TARGET="$$"  # Hook's parent is the Claude Code process
PEER_ID=""

for i in 1 2 3; do
  sleep 0.5
  PEERS=$(curl -sf -X POST "$BROKER/list-peers" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $(cat ~/.claude-peers-token 2>/dev/null)" \
    -d '{"scope":"machine","cwd":"/","git_root":null}' 2>/dev/null)

  if [ -n "$PEERS" ]; then
    PEER_ID=$(echo "$PEERS" | jq -r ".[] | select(.pid == $PPID_TARGET) | .id" 2>/dev/null)
    [ -n "$PEER_ID" ] && break
  fi
done

if [ -z "$PEER_ID" ]; then
  log "Could not determine peer ID (PID=$PPID_TARGET). Skipping."
  exit 0
fi

# Set auto-summary
timeout 2 bun "$CLI" auto-summary "$PEER_ID" >> "$LOG" 2>&1 || true
exit 0
```

### Auth Integration

The hook must include the `Authorization: Bearer <token>` header when calling `/list-peers`. It reads from `~/.claude-peers-token` (same file the broker, server, and CLI use).

## Success Metrics

| Metric | Target |
|--------|--------|
| Hook fires on session start | Verified by checking summary in `list_peers` after starting a session |
| Peer summary set within 3s | Timed from session start to summary visible |
| No session start delay | Session becomes interactive without waiting for hook |
| Silent failure on broker down | Start session without broker, verify no error shown to user |
| Log file captures errors | Check `~/.claude/logs/cpm-auto-summary.log` for entries |

## Open Questions

1. **PID mapping accuracy**: The hook's `$$` PID is the bash process, not the Claude Code process. Need to verify what PID the MCP server registers with — it's likely the `bun server.ts` process PID, not the Claude Code parent. May need `$PPID` or process tree traversal.

2. **SessionStart timing**: Does Claude Code wait for SessionStart hooks to complete before initializing MCP servers, or do they run in parallel? If hooks fire BEFORE MCP servers, the peer won't exist yet and the retry loop is essential. If hooks fire AFTER, the sleep/retry is unnecessary. Needs testing.

3. **Settings.json merge behavior**: If the user already has SessionStart hooks, the new entry must be added to the array, not replace it. The implementation must read-modify-write, not overwrite.

4. **Alternative: Server-side auto-summary**: Instead of a hook, the MCP server itself could call `auto-summary` logic after registration. This avoids the PID/timing issues entirely but couples the deterministic summary into `server.ts`. The hook approach was chosen to keep concerns separate, but if timing proves too fragile, the server-side approach is the fallback.
