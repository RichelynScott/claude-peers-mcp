# HANDOFF — claude-peers-mcp

## IMMEDIATE NEXT ACTION

**LAN Federation is RESEARCH-COMPLETE. Three paths forward:**

1. **Fix PRD bugs → implement Phase A** — The PRD has 3 bugs identified by PAL consensus. Fix them, then either:
   - a. Run Ralph (`ralph.sh --tool claude`) using `tasks/ralph/prd-lan-discovery-phase-a.json` (13 stories)
   - b. Manual implementation with subagents
2. **hcom bridge** — Small (~50-80 lines). Forward claude-peers discovery to hcom event log. No PRD — direct subagent task.
3. **clink dual-bus** — Small (~20-30 lines). PAL's clink registers spawned agents with both hcom AND claude-peers. No PRD — direct subagent task.

### PRD Bugs to Fix Before Phase A Implementation

| Bug | Location | Fix |
|-----|----------|-----|
| Auth confusion | US-A12 | Federation endpoints use PSK only (not bearer+PSK). Local broker endpoints use bearer only. |
| Routing ambiguity | FR-5 / US-A12 | Remove `/federation/send-to-remote` — use in-process function call instead |
| HMAC canonicalization | Technical section | Document that `Object.keys().sort()` only handles top-level keys, or switch to recursive sort |

### Implementation Gotchas (from research)

- **Ed25519 certs** (not RSA-2048): `openssl genpkey -algorithm Ed25519 -out key.pem && openssl req -new -x509 -key key.pem -out cert.pem -days 365 -subj "/CN=$(hostname)"`
- **WSL2 subnet detection**: Use `ip route show default`, NOT `os.networkInterfaces()` (returns 172.x.x.x)
- **PID liveness bypass**: Relay endpoint must skip `process.kill(pid,0)` for remote `from_id`s
- **Hostname normalization**: Lowercase, truncate >63 chars, reject colons at startup
- **Federation startup**: Wrap in try/catch — graceful degradation if TLS or port binding fails
- **Tailscale**: `/32` routes need special handling in subnet detection
- **`fetch()` TLS**: `tls: { rejectUnauthorized: false }` works in Bun (verified)

## COMPLETED THIS SESSION

| Feature | Commit | Details |
|---------|--------|---------|
| Deep research report | `9007d28` | 14 sources, 296 lines at `.firecrawl/deep-research-lan-discovery.md` |
| FYI.md deep research entry | `1ae4067` | Research findings documented |
| PAL consensus + local verification | `7f452e9` | 4-model consensus (avg 8.25/10), 5 Bun smoke tests (all PASS) |

**Research pipeline completed: Phase 0 (deep research) → Phase 1 (local verification) → Phase 2 (PAL consensus) → Phase 3 (synthesis)**

## KEY FILES FOR CONTEXT

| File | Purpose |
|------|---------|
| `tasks/prd-lan-discovery.md` | LAN federation PRD (3 phases, 577 lines) — HAS 3 BUGS to fix |
| `tasks/ralph/prd-lan-discovery-phase-a.json` | Ralph JSON for Phase A (13 stories) |
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
