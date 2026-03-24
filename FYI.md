# FYI - claude-peers-mcp Decision Journal

## 2026-03-24 - session_name feature implemented
### What: Added session_name as first-class field to peer registry
### Why: Claude Code sessions use /rename for human-friendly names, but list_peers only showed opaque 8-char IDs. Peers need to identify each other by name.
### How: New field in Peer/RegisterRequest types, ALTER TABLE migration for existing DBs, /set-name broker endpoint, set_name MCP tool, Name shown first in list_peers output, from_name in channel push meta, [SESSION_NAME] tag in CLI output.
### Impact: Peers can now identify each other by session name. Channel notifications include from_name metadata.
### Related: `6b8ec50`

## 2026-03-24 - Knowledge transfer from ADD_MORE_2_CC session
### What: Full backlog and architectural insights transferred from the session that adopted and configured claude-peers-mcp
### Why: ADD_MORE_2_CC completed initial setup (fork, ZSH wrapper, global CLAUDE.md docs, MCP scoping) and needed to hand off project ownership
### How: Via claude-peers channel messaging (dogfooding the tool itself)
### Impact: Backlog established below

## 2026-03-24 - Message observability improvements
### What: Full message logging to stderr and ~/.claude-peers-messages.log for both inbound and outbound messages
### Why: Channel notification preview in Claude Code UI truncates long messages. User needs to monitor inter-session communications in real time.
### How: Removed 80-char truncation in stderr log, added persistent log file for `tail -f` monitoring, logs both sent and received messages with timestamps and sender names.
### Impact: User can `tail -f ~/.claude-peers-messages.log` for full visibility

---

## Backlog (from ADD_MORE_2_CC knowledge transfer)

### HIGH Priority
| Item | Details | Source |
|------|---------|--------|
| Auto-summary SessionStart hook | Deterministic hook: reads cwd + git branch + TaskMaster state, calls cli.ts set-summary. PAL 5-model consensus: manual set_summary will fail due to forgetfulness. | PAL consensus (5 models) |
| Message table cleanup | Delivered messages never deleted. Need: DELETE WHERE delivered=1 AND sent_at < datetime('now', '-7 days') | Known bug |

### MEDIUM Priority
| Item | Details | Source |
|------|---------|--------|
| CLI set-name command | cli.ts has no `set-name` subcommand (only MCP tool). Parity gap. | ADD_MORE_2_CC |
| Broker auth | Auto-generated token at ~/.claude-peers-token, passed as Authorization header. Prevents rogue processes from injecting messages. | Gemini 3.1 Pro |
| Test suite | Zero tests. Need broker.test.ts, server.test.ts. Bun has built-in test runner. | ADD_MORE_2_CC |
| README.md update | Still upstream's version. Needs session_name, ZSH wrapper, set_name docs. | ADD_MORE_2_CC |
| Message size limits | No limit on /send-message payload. | Known gap |
| Rate limiting | No rate limiting on any broker endpoint. | Known gap |

### LOW Priority
| Item | Details | Source |
|------|---------|--------|
| hcom bridge | Forward claude-peers discovery to hcom event log for unified visibility. | Opus 4.6 |
| Structured message protocol | Add message types (query, response, handoff, broadcast), ACK beyond delivered flag. | ADD_MORE_2_CC |
| Broadcast endpoint | /broadcast for sending to all peers or scoped groups. Currently 1:1 only. | ADD_MORE_2_CC |
| clink dual-bus registration | PAL's clink registers spawned agents with both hcom AND claude-peers. | GLM-5 |

### DEFERRED
| Item | Checkpoint | Exit Criteria |
|------|-----------|---------------|
| Bun-to-UV port evaluation | 2026-04-23 | Port ONLY if: (a) daily multi-session usage, (b) Bun causes friction, (c) team adoption expands. Otherwise accept Bun as permanent. |

### PAL MCP References
- Consensus continuation_id: `27f8435a-f91f-446b-a122-966003ad0f65` (5 models)
- Thinkdeep continuation_id: `0b8f06a3-4ef7-402b-94d7-150e0077f423` (Gemini 3.1 Pro)
- Memory file: `~/.claude/projects/-home-riche--claude/memory/project_claude_peers_setup.md`
