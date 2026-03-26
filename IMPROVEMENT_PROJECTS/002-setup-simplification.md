# PRD-002: Federation Setup Simplification

**Author:** Claude Opus 4.6 (1M context)
**Date:** 2026-03-26
**Status:** Draft
**Project:** claude-peers-mcp
**Branch:** TBD (implementation)

---

## 1. Introduction

### Current State

Federation setup in claude-peers-mcp requires an experienced developer to coordinate multiple manual steps across two machines, often with platform-specific debugging. The current process involves:

1. Editing `~/.claude-peers-config.json` (or setting env vars in `~/.zshrc`) on **both** machines
2. Restarting the broker on both machines after config changes
3. Manually copying `~/.claude-peers-token` between machines via `scp` or other means
4. On WSL2: running an elevated PowerShell command for port forwarding, plus a Windows Firewall rule
5. On macOS: potentially allowing Bun through the application firewall
6. Running `federation connect <ip>:<port>` from **each** machine to the other (bidirectional)
7. Debugging TLS handshake failures (Ed25519 vs RSA-2048 cert mismatch, subnet filtering rejections, source IP rewriting on WSL2)

### Pain Points

The setup between a WSL2 machine and a macOS machine in March 2026 took experienced developers over an hour. The root causes were:

- **Too many moving parts**: Token file, config file, env vars, broker restart, port forwarding, firewall, bidirectional connect -- each is simple alone, but the combination creates a high-friction gauntlet.
- **No config persistence for remotes**: The `remoteMachines` map in `broker.ts` is purely in-memory. Every broker restart loses all federation connections, requiring manual re-execution of `federation connect` commands.
- **Env vars vs config file confusion**: Federation can be enabled via `CLAUDE_PEERS_FEDERATION_ENABLED=true` (env var) or `federation.enabled: true` (config file). The `federation setup` wizard checks for the env var first, and if it's absent, tells the user to set it -- even though the config file method exists and is simpler.
- **Wizard is read-only diagnostic, not a setup tool**: The current `federation setup` command checks prerequisites and prints instructions, but doesn't actually perform the setup. Users must manually execute each printed command.
- **Token sharing is manual and error-prone**: Users must `scp` the token file or manually copy-paste a 64-character hex string. No CLI command generates a shareable one-liner.
- **Platform detection works, but remediation is manual**: The wizard correctly detects WSL2/macOS/Linux but only prints instructions -- it doesn't execute the fixes.
- **No "did it work?" validation**: After completing all steps, there's no single command that verifies end-to-end federation health.

### Scope

This PRD covers Phase B improvements to the federation CLI and broker startup, reducing manual setup from 7+ steps to a guided 1-2 command flow. It does not cover mDNS/auto-discovery (Phase C) or internet/cloud relay functionality.

---

## 2. Goals

| # | Goal | Metric |
|---|------|--------|
| G1 | **One-command setup on each machine** | `federation init` performs all local config, cert generation, firewall/port-forwarding, and outputs a join token |
| G2 | **Zero `.zshrc` edits required for federation** | Config file is the sole persistent config method; env vars remain as overrides for CI/testing only |
| G3 | **Auto-reconnect to known remotes on broker restart** | Remotes list persisted in config file; broker connects to all saved remotes on startup |
| G4 | **Token sharing via CLI** | Single command generates a compact, copy-pasteable connection string |
| G5 | **End-to-end validation** | `federation doctor` checks every prerequisite, tests connectivity, and reports pass/fail |
| G6 | **Time from `git clone` to working federation < 5 minutes** | Measured on fresh WSL2 + macOS pair, both with Bun installed |

---

## 3. User Stories

### US-001: Config File as Sole Configuration Method

**As a** user setting up federation,
**I want** all federation settings to live in `~/.claude-peers-config.json`,
**so that** I never need to edit `.zshrc` or set environment variables for federation to work.

#### Acceptance Criteria

- [ ] `~/.claude-peers-config.json` supports all federation fields: `enabled`, `port`, `subnet`, and a new `remotes` array.
- [ ] Broker reads federation config exclusively from the config file on startup (env vars still override for backward compatibility but are not required).
- [ ] The `federation setup` wizard no longer instructs users to set env vars. All guidance points to the config file.
- [ ] The `federation enable` command writes all necessary fields to the config file, including subnet.
- [ ] Removing all `CLAUDE_PEERS_*` env vars from `.zshrc` does not break any federation functionality if the config file is present.
- [ ] Documentation (README.md, TROUBLESHOOTING.md) updated to show config file as the primary method, env vars as "advanced override."

#### Config File Schema (Extended)

```json
{
  "federation": {
    "enabled": true,
    "port": 7900,
    "subnet": "192.168.1.0/24",
    "remotes": [
      { "host": "192.168.1.42", "port": 7900, "label": "rafi-macbook" }
    ]
  }
}
```

---

### US-002: Auto-Reconnect to Last Known Remotes on Broker Restart

**As a** user with an established federation,
**I want** the broker to automatically reconnect to all previously connected remotes when it restarts,
**so that** I don't have to manually run `federation connect` after every broker restart.

#### Acceptance Criteria

- [ ] The config file's `federation.remotes` array is read on broker startup.
- [ ] For each entry in `remotes`, the broker attempts a TLS handshake + peer fetch within 30 seconds of startup.
- [ ] Failed reconnections are logged to `cpm-logs/federation.log` with the error reason but do not block broker startup.
- [ ] Failed reconnections are retried with exponential backoff: 5s, 15s, 45s, then every 60s.
- [ ] Successfully connecting to a new remote via `federation connect` adds it to the config file's `remotes` array automatically.
- [ ] Disconnecting via `federation disconnect` removes it from the config file's `remotes` array.
- [ ] The `remotes` array is deduplicated by `host:port` (no duplicate entries).
- [ ] `federation status` shows reconnection state: "connected", "reconnecting (attempt 3)", or "unreachable."

#### Technical Notes

- The current `remoteMachines` in-memory Map (`broker.ts:571`) stays as the runtime data structure. The config file is the persistence layer that seeds it on startup.
- Auto-reconnect should run after the federation TLS server is listening, so inbound connections from the remote side are also accepted.
- The `label` field in config is informational only (for human readability in the JSON file). The broker uses the `hostname` from the TLS handshake response as the canonical identifier.

---

### US-003: `federation init` Generates Config and Performs Local Setup

**As a** user setting up federation for the first time,
**I want** a single `federation init` command that configures everything locally,
**so that** I don't have to manually create config files, generate certs, or configure firewalls.

#### Acceptance Criteria

- [ ] `bun src/cli.ts federation init` performs all of the following in sequence:
  1. Detects platform (WSL2 / macOS / Linux).
  2. Creates `~/.claude-peers-config.json` with `federation.enabled: true`, detected subnet, and default port.
  3. Generates TLS certificate if not present (calls `ensureTlsCert()`).
  4. Generates auth token if not present (calls `loadOrCreateToken()` logic).
  5. **WSL2 only**: Runs elevated PowerShell to set up port forwarding and firewall rule. Retries once if UAC is dismissed.
  6. **macOS only**: Adds Bun to the application firewall allow list (with `sudo` prompt if needed).
  7. **Linux only**: Checks if UFW/firewalld is active and adds the port rule (with `sudo` prompt if needed).
  8. Kills existing broker if running (so it restarts with new config).
  9. Outputs a **join command** that the remote machine can run (see US-004).
- [ ] Each step prints status: checkmark for success, X for failure with remediation instructions.
- [ ] If any step fails, subsequent steps still execute (best-effort). A summary at the end lists what succeeded and what needs manual attention.
- [ ] `federation init` is idempotent: running it again on an already-configured machine updates/verifies without breaking anything.
- [ ] The existing `federation setup` command becomes an alias for `federation init` (backward compatible).

#### Output Example

```
[Federation Init — WSL2 Detected]

  1. OK  Config file written (~/.claude-peers-config.json)
  2. OK  TLS certificate ready (~/.claude-peers-federation.crt)
  3. OK  Auth token ready (~/.claude-peers-token)
  4. OK  Windows port forwarding configured (port 7900)
  5. OK  Windows Firewall rule added
  6. OK  Broker restarted with federation enabled

Your LAN IP: 192.168.1.100

To connect another machine, run this on the remote:
  bun src/cli.ts federation join cpt://192.168.1.100:7900/abc123def456

Or manually:
  1. Copy token: scp user@192.168.1.100:~/.claude-peers-token ~/.claude-peers-token
  2. Enable: bun src/cli.ts federation enable
  3. Connect: bun src/cli.ts federation connect 192.168.1.100:7900
```

---

### US-004: Token Sharing via CLI (Join Command)

**As a** user connecting a second machine to an existing federation,
**I want** a single command that handles token transfer and connection in one step,
**so that** I don't have to manually `scp` token files or copy-paste hex strings.

#### Acceptance Criteria

- [ ] `bun src/cli.ts federation token` outputs a connection string in the format: `cpt://<host>:<port>/<base64-encoded-token>` (CPT = Claude Peers Token).
- [ ] `bun src/cli.ts federation join <cpt-url>` on the remote machine:
  1. Parses the `cpt://` URL to extract host, port, and token.
  2. Writes the token to `~/.claude-peers-token` (with `0600` permissions).
  3. Writes/updates `~/.claude-peers-config.json` with `federation.enabled: true` and the remote in the `remotes` array.
  4. Generates a local TLS certificate if not present.
  5. Kills the local broker (so it restarts with federation enabled).
  6. Attempts to connect to the remote and reports success/failure.
- [ ] The `cpt://` URL is URL-safe and can be copy-pasted across chat apps, email, or terminal without escaping issues.
- [ ] If `~/.claude-peers-token` already exists with a different token, the command warns and asks for confirmation before overwriting (since it would break existing local federation connections with other machines using the old token).
- [ ] The token in the `cpt://` URL is base64url-encoded (no `+`, `/`, or `=` padding), not raw hex.
- [ ] `federation token` works without a running broker (it reads the token file directly).
- [ ] Security: The `cpt://` URL contains a secret. The command prints a warning: "This URL contains your federation token. Share it only with trusted machines on your LAN."

#### Connection String Format

```
cpt://192.168.1.100:7900/dGhpcyBpcyBhIHRlc3QgdG9rZW4
      ^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
      host:port          base64url-encoded token
```

---

### US-005: Broker Auto-Starts with Federation If Config File Says Enabled

**As a** user who has already run `federation init`,
**I want** the broker to always start with federation enabled,
**so that** I don't need to pass env vars or restart manually after reboots.

#### Acceptance Criteria

- [ ] When broker starts (either via MCP server auto-launch or direct `bun src/broker.ts`), it reads `~/.claude-peers-config.json`.
- [ ] If `federation.enabled` is `true` in the config file, the federation TLS server starts automatically -- no env vars required.
- [ ] This already works in the current implementation (`broker.ts:60-63`), but this story ensures the behavior is **tested** and **documented** as the primary path.
- [ ] Add integration test: broker started with only config file (no env vars) correctly starts federation TLS server.
- [ ] Add integration test: broker started with `federation.enabled: false` in config file does NOT start federation, even if the `remotes` array has entries.
- [ ] `federation status` shows the config source: "enabled via config file" or "enabled via env var."

#### Technical Notes

- The current implementation already supports this (`persistentConfig.federation?.enabled` at `broker.ts:63`). This story is primarily about testing coverage and documentation, plus the "config source" indicator in status output.

---

### US-006: First-Run Wizard with Platform Detection and End-to-End Validation

**As a** first-time user who just cloned the repo,
**I want** a guided wizard that detects my platform and walks me through everything including verification,
**so that** I know federation is working before I consider setup complete.

#### Acceptance Criteria

- [ ] `bun src/cli.ts federation init --wizard` launches an interactive guided flow (non-interactive is the default for scripting/automation).
- [ ] Wizard steps:
  1. **Platform detection**: "Detected WSL2 on Windows 11" / "Detected macOS 14.x" / "Detected Ubuntu 24.04"
  2. **Prerequisites check**: Bun version, openssl available, network interfaces detected
  3. **Config generation**: Creates config file with explanation of each field
  4. **Cert generation**: Creates TLS cert with explanation of what it's for
  5. **Token generation**: Creates or displays existing token
  6. **Network setup**: Platform-specific firewall/port-forwarding (with explanation)
  7. **Broker restart**: Kills old broker, waits for new one to start with federation
  8. **Self-test**: Verifies federation TLS server is reachable on detected LAN IP (connects to self as a smoke test)
  9. **Join command output**: Prints the `cpt://` URL for connecting remote machines
  10. **Remote connection** (optional): If user has a `cpt://` URL from another machine, offers to join immediately
- [ ] Each step shows `[1/10]`, `[2/10]`, etc. for progress tracking.
- [ ] The wizard detects if federation is already configured and offers to re-run (verify) or reconfigure.
- [ ] After setup, `federation doctor` (see below) is run automatically to validate the full setup.

---

### US-007: `federation doctor` End-to-End Health Check

**As a** user debugging federation issues,
**I want** a single diagnostic command that checks every prerequisite, tests connectivity, and tells me exactly what's wrong,
**so that** I can fix issues without reading the troubleshooting guide.

#### Acceptance Criteria

- [ ] `bun src/cli.ts federation doctor` runs the following checks and reports pass/fail for each:
  1. **Config file exists** and is valid JSON
  2. **Federation enabled** in config file or env var
  3. **Token file exists** and is readable (non-empty)
  4. **TLS certificate exists** and is not expired
  5. **Broker is running** (health check on localhost:7899)
  6. **Federation TLS server is listening** (health check on localhost:7900)
  7. **LAN IP detected** (platform-specific)
  8. **Federation port reachable from LAN IP** (self-connect test via TLS handshake)
  9. **WSL2 only**: Port forwarding rule exists (checks `netsh interface portproxy show v4tov4` via PowerShell)
  10. **WSL2 only**: Windows Firewall rule exists
  11. **macOS only**: Bun allowed through application firewall
  12. **Connected remotes** (lists each with latency)
  13. **Config file `remotes` vs actual connections** (flags remotes in config that aren't currently connected)
- [ ] Output uses color: green for pass, red for fail, yellow for warning.
- [ ] Each failed check includes a one-line fix command.
- [ ] Exit code 0 if all critical checks pass, 1 if any critical check fails.
- [ ] `federation doctor --json` outputs machine-readable JSON for scripting.

#### Output Example

```
Federation Health Check
=======================

  OK   Config file (~/.claude-peers-config.json)
  OK   Federation enabled (source: config file)
  OK   Auth token (~/.claude-peers-token)
  OK   TLS certificate (expires 2027-03-26, RSA-2048)
  OK   Broker running (3 local peers)
  OK   Federation TLS listening on port 7900
  OK   LAN IP detected: 192.168.1.100
  OK   Self-connect test passed (TLS handshake OK)
  OK   WSL2 port forwarding rule present
  OK   Windows Firewall rule present
  OK   Remote: rafi-macbook (192.168.1.42:7900) — 2ms latency, 1 peer

  WARN Config has remote 10.0.0.5:7900 but it's not currently connected
       Fix: bun src/cli.ts federation connect 10.0.0.5:7900

11/11 checks passed, 1 warning
```

---

### US-008: `federation connect` Persists Remotes and Supports Labels

**As a** user managing multiple federated machines,
**I want** `federation connect` to remember connections across broker restarts and support human-readable labels,
**so that** I don't have to re-connect manually or remember IP addresses.

#### Acceptance Criteria

- [ ] `bun src/cli.ts federation connect <host>:<port>` adds the remote to `federation.remotes` in the config file on successful connection.
- [ ] `bun src/cli.ts federation connect <host>:<port> --label "rafi-macbook"` stores an optional label.
- [ ] If no label is provided, the remote's hostname (from TLS handshake) is used as the default label.
- [ ] `bun src/cli.ts federation disconnect <host>:<port>` removes the entry from `federation.remotes`.
- [ ] `federation status` shows the label alongside each remote.
- [ ] Duplicate `host:port` entries in `remotes` are prevented (upsert, not append).

---

## 4. Technical Considerations

### Config File Schema Evolution

The current `PeersConfig` interface in `src/shared/config.ts` needs to be extended:

```typescript
export interface PeersConfig {
  federation?: {
    enabled?: boolean;
    port?: number;
    subnet?: string;
    remotes?: Array<{
      host: string;
      port: number;
      label?: string;
    }>;
  };
}
```

The schema is backward compatible -- existing config files without `remotes` continue to work. The `loadConfig()` function already returns `{}` for missing/invalid files.

### Auto-Reconnect Lifecycle

```
Broker starts
  -> loadConfig() reads federation.remotes
  -> Start federation TLS server (listen on 0.0.0.0:FEDERATION_PORT)
  -> For each remote in config:
       -> Spawn async reconnection task
       -> TLS handshake + peer fetch
       -> On success: add to remoteMachines Map
       -> On failure: log, schedule retry with backoff
  -> Normal broker operation continues (doesn't block on reconnection)
```

Reconnection must happen AFTER the TLS server is listening so that the remote side can also accept our inbound connections (federation is bidirectional).

### `cpt://` URL Security

The connection URL contains the PSK token. Mitigations:

- The token is base64url-encoded (not plaintext) to reduce accidental exposure in logs
- `federation token` prints a security warning about sharing
- `federation join` writes the token file with `0600` permissions
- The token is single-use per machine pair (once both machines have the same token, the URL is no longer needed)
- Future enhancement: time-limited tokens (out of scope for this PRD)

### WSL2 Port Forwarding Persistence

The current `netsh interface portproxy` rule survives Windows reboots, but the WSL2 IP address changes on every WSL restart. The `federation init` command should:

1. Detect the current WSL2 IP
2. Check if a port proxy rule already exists for the federation port
3. Update the rule if the WSL2 IP has changed (delete + re-add)
4. Optionally create a Windows Scheduled Task that runs at logon to refresh the rule (stretch goal, not required for this PRD)

### Backward Compatibility

- Env vars continue to override config file values (existing behavior preserved)
- `federation setup` becomes an alias for `federation init` (no breaking change)
- The `federation enable` / `federation disable` commands continue to work
- Existing `~/.claude-peers-config.json` files without `remotes` field work unchanged

---

## 5. Non-Goals

| Item | Reason |
|------|--------|
| Internet connectivity / cloud relay | Federation is LAN-only by design. Cloud relay is a separate project. |
| mDNS auto-discovery | That's Phase C. This PRD focuses on making manual setup painless, not automatic. |
| Multi-token support (per-machine tokens) | Single shared PSK is sufficient for trusted LAN environments. |
| GUI / web-based setup | CLI-first project. A web UI would be a separate initiative. |
| Windows native support (non-WSL2) | claude-peers requires Bun + Unix-like environment. WSL2 is the supported Windows path. |
| Automatic WSL2 IP refresh on reboot | Detecting WSL IP changes is a Windows Scheduled Task problem, not a broker problem. Document it as a known limitation. |
| Token expiration / rotation during join | Token rotation is already supported via `rotate-token` + SIGHUP. Adding time-limited join tokens is a nice-to-have for a future PRD. |

---

## 6. Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Time from `git clone` to working federation (2-machine LAN) | < 5 minutes | Timed test with fresh WSL2 + macOS, Bun pre-installed |
| Number of manual commands per machine | <= 2 (`federation init` + `federation join`) | Count commands in the setup flow |
| Number of `.zshrc` edits required for federation | 0 | Verify federation works with clean `.zshrc` (no `CLAUDE_PEERS_*` exports) |
| Broker restart preserves federation connections | 100% of persisted remotes reconnect within 60s | Integration test: kill broker, restart, verify `federation status` shows all remotes |
| `federation doctor` catches all known failure modes | 100% coverage of TROUBLESHOOTING.md federation entries | Each troubleshooting entry maps to a doctor check |
| Zero support requests for setup issues (team internal) | 0 requests in first month after shipping | Track in team chat |

---

## 7. Implementation Order

Stories should be implemented in this order due to dependencies:

| Phase | Stories | Rationale |
|-------|---------|-----------|
| 1. Foundation | US-001 (config as sole method), US-005 (broker auto-start test) | Config schema must be solid before building on it |
| 2. Persistence | US-002 (auto-reconnect), US-008 (connect persists) | Depends on extended config schema from Phase 1 |
| 3. Streamlined CLI | US-003 (federation init), US-004 (token sharing / join) | Depends on persistence working correctly |
| 4. Validation | US-007 (federation doctor) | Depends on all other features being in place to validate |
| 5. Polish | US-006 (first-run wizard) | Depends on init + doctor being implemented |

Estimated total effort: 3-4 focused sessions or 1 Ralph autonomous run.

---

## 8. Open Questions

| # | Question | Proposed Answer |
|---|----------|-----------------|
| 1 | Should `federation join` initiate a bidirectional connection (both machines connect to each other)? | Yes -- the joining machine connects to the remote, and the remote's auto-reconnect (if configured) handles the reverse. Document that `federation init` on the original machine adds the joiner to its remotes list via the handshake. |
| 2 | Should the `cpt://` URL encode the subnet, or should the joining machine auto-detect? | Auto-detect. Subnet is a local security policy, not something the remote should dictate. |
| 3 | What happens if two machines have different tokens in their `~/.claude-peers-token`? | Handshake fails with "PSK mismatch." `federation doctor` should detect this when it tests connectivity. |
| 4 | Should `federation init` be the new default for `federation setup`, or a separate command? | Make `federation init` the canonical name, `federation setup` an alias for backward compat. |
| 5 | Should auto-reconnect have a max retry count before giving up? | No max -- but exponential backoff caps at 60s intervals. Stale remotes are already evicted after 90s of no sync. The user can `federation disconnect` to stop retries. |
