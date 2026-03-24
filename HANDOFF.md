# HANDOFF — claude-peers-mcp

## IMMEDIATE NEXT ACTION

**LAN Federation PRD bugs FIXED. Ready to implement Phase A:**

1. **Implement Phase A** — prd.json has all 3 PAL consensus bugs fixed (`d1a5f31`). Two options:
   - a. Run Ralph (`ralph.sh --tool claude`) using `tasks/ralph/prd-lan-discovery-phase-a.json` (13 stories)
   - b. Manual implementation with subagents
2. **hcom bridge** — Small (~50-80 lines). Forward claude-peers discovery to hcom event log. No PRD — direct subagent task.
3. **clink dual-bus** — Small (~20-30 lines). PAL's clink registers spawned agents with both hcom AND claude-peers. No PRD — direct subagent task.

### PRD Bugs FIXED (commit `d1a5f31`)

| Bug | Location | Fix Applied |
|-----|----------|-------------|
| Auth confusion | US-006 | Federation endpoints use PSK only (not bearer+PSK) |
| Routing ambiguity | US-011 | In-process function call, not `/federation/send-to-remote` |
| HMAC canonicalization | US-005 | Documented top-level-only sorting as known limitation |

### Implementation Gotchas (baked into prd.json notes)

All gotchas from research are now embedded as `notes` on relevant stories in prd.json:
- Ed25519 certs (US-002), WSL2 subnet detection (US-004), PID liveness bypass (US-006)
- Hostname normalization (US-002), federation try/catch (US-003), Tailscale /32 (US-004)
- fetch() TLS rejectUnauthorized:false (US-007)

## COMPLETED THIS SESSION

| Feature | Commit | Details |
|---------|--------|---------|
| Deep research report | `9007d28` | 14 sources, 296 lines at `.firecrawl/deep-research-lan-discovery.md` |
| FYI.md deep research entry | `1ae4067` | Research findings documented |
| PAL consensus + local verification | `7f452e9` | 4-model consensus (avg 8.25/10), 5 Bun smoke tests (all PASS) |
| PRD bug fixes in prd.json | `d1a5f31` | 3 bugs fixed, research gotchas baked into story notes |

**Research pipeline completed: Phase 0 (deep research) → Phase 1 (local verification) → Phase 2 (PAL consensus) → Phase 3 (synthesis) → Phase 4 (prd.json bug fixes)**

## KEY FILES FOR CONTEXT

| File | Purpose |
|------|---------|
| `tasks/prd-lan-discovery.md` | LAN federation PRD (3 phases, 577 lines) — original PRD (bugs in prose, fixed in prd.json) |
| `tasks/ralph/prd-lan-discovery-phase-a.json` | Ralph JSON for Phase A (13 stories) — BUGS FIXED in `d1a5f31` |
| `.firecrawl/deep-research-lan-discovery.md` | Deep research report (296 lines, 14 sources) |
| `FYI.md` | Decision journal with PAL consensus findings |
| `memory/project_lan_discovery.md` | Memory file with consolidated research conclusions |

## CRITICAL BEHAVIOR RULES

- Bun runtime, not Node.js
- All broker endpoints require auth (`Authorization: Bearer <token>` from `~/.claude-peers-token`)
- `/health` GET is exempt from auth
- PAL MCP continuation_id for consensus: `435275f0-6c9c-4add-9992-3d08e68f021b`
- Pre-existing TS errors (BunFile type in logging) — not introduced by us, safe to ignore
- 75 tests, 205 assertions, all passing across 3 test files
