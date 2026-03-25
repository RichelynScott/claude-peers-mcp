# HANDOFF — claude-peers-mcp

## IMMEDIATE NEXT ACTION

**LAN Federation Phase A is IMPLEMENTED on branch `ralph/lan-federation-phase-a`.** Next steps:

1. **PAL codereview** — Run codereview on the 7 implementation commits
2. **Create PR** — `gh pr create` from `ralph/lan-federation-phase-a` → `main`
3. **Manual testing** — Test between Riche (WSL2) and Rafi (Mac):
   - Both machines: copy `~/.claude-peers-token` to the other machine
   - Both machines: `CLAUDE_PEERS_FEDERATION_ENABLED=true` in env
   - Machine A: `bun cli.ts federation status` → should show "enabled on port 7900"
   - Machine A: `bun cli.ts federation connect <rafi-ip>:7900`
   - Both machines: `list_peers(scope="lan")` → should show cross-machine peers
   - Send a message from Machine A to a peer on Machine B
4. **Phase B (mDNS)** — Optional enhancement, works on macOS, unreliable on WSL2
5. **Phase C (WSL2 docs)** — Documentation and WSL2 detection

## COMPLETED THIS SESSION

| Feature | Commit | Details |
|---------|--------|---------|
| Deep research (14 sources) | `9007d28` | Bun TLS, WSL2 mDNS, bonjour-service |
| PAL consensus (4 models, 8.25/10) | `7f452e9` | Architecture validated |
| PRD bug fixes (consensus) | `d1a5f31` | Auth, routing, HMAC |
| Critical architecture fix (codereview) | `1edfe5e` | Process isolation |
| US-001: Federation types | `fe21727` | shared/types.ts |
| US-002: TLS cert gen + HMAC + subnet | `67494ce` | federation.ts (155 lines) |
| US-003+004+006: Broker federation | `0b15f69` | broker.ts (+434 lines) |
| US-005+007+008+012: CLI commands | `0c20250` | cli.ts federation subcommand |
| US-009: Peer list sync | `7030c59` | 30s interval, 90s stale timeout |
| US-010+011: Server.ts LAN scope | `6a6d73f` | list_peers + send_message |
| US-013: Test suite (21 tests) | `b6a57a4` | federation.test.ts (686 lines) |

**Test results: 96 tests, 0 failures, 290 assertions across 4 files.**

## KEY FILES FOR CONTEXT

| File | Purpose |
|------|---------|
| `federation.ts` | New file — TLS cert gen, HMAC signing, subnet utils (155 lines) |
| `federation.test.ts` | New file — 21 federation tests (686 lines) |
| `broker.ts` | Modified — federation TLS server, endpoints, remote peer map (+434 lines) |
| `server.ts` | Modified — LAN scope, remote peer routing |
| `cli.ts` | Modified — federation connect/disconnect/status commands |
| `shared/types.ts` | Modified — 9 new federation interfaces |

## CRITICAL BEHAVIOR RULES

- Bun runtime, not Node.js
- broker.ts and server.ts are SEPARATE PROCESSES (server spawns broker via Bun.spawn)
- Federation TLS server runs IN-PROCESS with broker.ts (shared memory)
- server.ts and cli.ts communicate with broker via HTTP to localhost:7899
- LAN-facing endpoints use PSK auth, local-facing use bearer token
- All broker POST endpoints require auth (`Authorization: Bearer <token>`)
- Federation is opt-in: `CLAUDE_PEERS_FEDERATION_ENABLED=true`
- PAL continuation_id: `435275f0-6c9c-4add-9992-3d08e68f021b`
