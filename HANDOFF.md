# HANDOFF — claude-peers-mcp

## IMMEDIATE NEXT ACTION

Pick one of these to continue the backlog:
1. **LAN Discovery (Phase 4)** — Deep research needed first: Bun TLS server API, WSL2 mDNS behavior, `bonjour-service` Bun compatibility. PRD at `tasks/prd-lan-discovery.md`, Ralph JSON at `tasks/ralph/prd-lan-discovery-phase-a.json` (13 stories, Phase A only).
2. **hcom bridge** — Small (~50-80 lines). Forward claude-peers discovery to hcom event log. No PRD — direct subagent task.
3. **clink dual-bus** — Small (~20-30 lines). PAL's clink registers spawned agents with both hcom AND claude-peers. No PRD — direct subagent task.

## COMPLETED THIS SESSION

| Feature | Commit | Tests |
|---------|--------|-------|
| Auto-summary CLI | `57ee55a` | 17 |
| Broker Auth | `8d52439` | +5 (25 total broker) |
| Auto-summary Hook | `b4e388c` (in ~/.claude/) | Manual |
| Structured Messages + Broadcast | `133d09e` | +15 (40 total broker) |
| MCP Server Test Suite | `67baf9f` | +18 |
| 6 PRDs + 5 Ralph prd.json | `8f344b9`→`fe6ab5f` | — |

**Test suite: 75 tests, 205 assertions, 0 failures across 3 files.**

## KEY FILES FOR CONTEXT

| File | Purpose |
|------|---------|
| `tasks/prd-lan-discovery.md` | LAN federation PRD (3 phases, 577 lines) |
| `tasks/ralph/prd-lan-discovery-phase-a.json` | Ralph JSON for Phase A (13 stories) |
| `tasks/WORKFLOW-backlog-to-ralph-pipeline.md` | Reusable workflow pattern documented this session |
| `tasks/CHANGELOG-2026-03-24-for-rafi.md` | Non-technical changelog for Rafi |
| `FYI.md` | Backlog with current status (most items DONE) |

## CRITICAL BEHAVIOR RULES

- Bun runtime, not Node.js
- All broker endpoints require auth (`Authorization: Bearer <token>` from `~/.claude-peers-token`)
- `/health` GET is exempt from auth
- PAL MCP continuation_id for this project's planning: `0c4aa37b-6f43-4e16-bb9a-88265ae318a5`
- Pre-existing TS errors (BunFile type in logging) — not introduced by us, safe to ignore
