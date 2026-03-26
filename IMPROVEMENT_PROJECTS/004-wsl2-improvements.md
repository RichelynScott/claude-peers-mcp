# PRD-004: WSL2-Specific Federation Improvements

**Status**: Draft
**Author**: Claude (Opus 4.6)
**Created**: 2026-03-26
**Priority**: High
**Estimated Effort**: Medium (2-3 days)
**Affects**: `src/federation.ts`, `src/cli.ts`, `src/broker.ts`, `docs/TROUBLESHOOTING.md`

---

## 1. Introduction

WSL2 (Windows Subsystem for Linux 2) runs a lightweight Linux kernel inside a Hyper-V virtual machine with NAT-mode networking. This creates a unique set of challenges for LAN federation in claude-peers-mcp that do not exist on native Linux or macOS:

1. **NAT-isolated IP space**: WSL2 is assigned an internal IP from the 172.x.x.x/20 range (Hyper-V virtual switch). This IP is not reachable from the LAN. External machines cannot connect to services inside WSL2 without explicit port forwarding through the Windows host.

2. **Subnet auto-detection returns wrong range**: The default route inside WSL2 points to the Hyper-V gateway (172.x.x.x), not the actual LAN gateway (e.g., 192.168.x.x). Any subnet restriction based on auto-detection would reject all legitimate LAN peers.

3. **Port forwarding requires Windows admin elevation**: `netsh interface portproxy` commands need Administrator privileges. The current setup wizard invokes `Start-Process -Verb RunAs` which triggers a UAC prompt, but the result is opaque and hard to verify from inside WSL2.

4. **WSL2 IP changes on every restart**: The Hyper-V DHCP server assigns a new 172.x.x.x IP to WSL2 on each boot, breaking any previously configured `netsh interface portproxy` rules that forward to the old IP.

5. **Multicast/mDNS does not work**: WSL2's virtual network adapter does not forward multicast packets from the LAN, ruling out future auto-discovery protocols (mDNS, SSDP, etc.) without additional workarounds.

6. **Windows Firewall + Hyper-V Firewall dual layers**: On Windows 11 22H2+, the Hyper-V firewall is a separate layer from Windows Defender Firewall. Both must allow inbound TCP on the federation port. The current setup wizard only creates a Windows Firewall rule.

7. **Source IP rewriting**: When traffic arrives via `netsh portproxy`, the source IP is rewritten to the Windows host's WSL2-facing IP (typically 172.x.x.x). This means subnet-based access control is fundamentally unreliable on WSL2, which is why the current code defaults to `0.0.0.0/0`.

These issues were discovered during a real-world federation setup session between a WSL2 machine and a macOS machine. The current codebase has partial mitigations (see Section 2), but the experience remains painful and manual.

### Current State (v0.3.0)

The following WSL2 handling already exists:

| Component | Current Behavior | File | Lines |
|-----------|-----------------|------|-------|
| WSL2 detection | Checks `WSL_DISTRO_NAME` env var and `/proc/sys/fs/binfmt_misc/WSLInterop` | `src/federation.ts` | 126-133 |
| Subnet override | Defaults to `0.0.0.0/0` when WSL2 detected | `src/federation.ts` | 146-151 |
| Port forwarding setup | One-shot `netsh portproxy` via elevated PowerShell | `src/cli.ts` | 322-393 |
| Windows LAN IP detection | PowerShell `Get-NetIPAddress` filtered to 192.168.*/10.* | `src/cli.ts` | 369-388 |
| Windows Firewall rule | Creates `Claude-Peers-Federation` inbound rule | `src/cli.ts` | 350 |
| Troubleshooting docs | Subnet rejection and TLS handshake failure sections | `docs/TROUBLESHOOTING.md` | 183-209 |

---

## 2. Goals

### Primary Goals

1. **Zero-knowledge federation on WSL2**: A user who knows nothing about NAT, port forwarding, or Windows firewall should be able to run `bun src/cli.ts federation setup` and get a working federation endpoint reachable from the LAN.

2. **Survive WSL2 restarts**: Port forwarding rules should automatically update when the WSL2 IP changes, without requiring the user to re-run the setup wizard or manually edit `netsh` rules.

3. **Comprehensive verification**: After setup, the wizard should verify that federation is actually reachable from outside WSL2, not just report that commands were issued.

4. **Clear, actionable error messages**: When something fails (UAC denied, firewall blocked, port already in use), the error message should explain exactly what happened and what the user needs to do.

5. **Guided troubleshooting**: WSL2-specific diagnostic commands and a troubleshooting flow that accounts for the dual-firewall, NAT, and IP-change issues.

### Stretch Goals

- Detect Hyper-V firewall state and create rules if needed (Windows 11 22H2+)
- Offer to install a Windows Task Scheduler task for auto-updating port forwarding on login
- Detect WSL2 mirrored networking mode (Windows 11 23H2+) and skip port forwarding entirely

---

## 3. User Stories

### US-001: Auto-Detect WSL2 and Configure Subnet to 0.0.0.0/0

**As a** claude-peers user running on WSL2,
**I want** the federation system to automatically detect WSL2 and set the allowed subnet to `0.0.0.0/0`,
**So that** I don't have to manually configure subnet restrictions that would break due to NAT IP rewriting.

**Acceptance Criteria**:
- [x] `detectSubnet()` returns `0.0.0.0/0` when `isWSL2()` is true *(already implemented)*
- [x] `isWSL2()` checks both `WSL_DISTRO_NAME` and `/proc/sys/fs/binfmt_misc/WSLInterop` *(already implemented)*
- [ ] Log message explicitly states WHY subnet is set to allow-all (security justification: PSK + TLS provide auth)
- [ ] If user has `CLAUDE_PEERS_FEDERATION_SUBNET` env var set on WSL2, warn that subnet restrictions may not work due to source IP rewriting, but honor the setting
- [ ] Unit test: `detectSubnet()` returns `0.0.0.0/0` when `WSL_DISTRO_NAME` is set

**Status**: Partially implemented. Detection and default work. Missing: env var override warning, explicit security justification in logs.

**Priority**: P1 (foundation for all other WSL2 stories)

---

### US-002: Auto-Setup Windows Port Forwarding During Federation Setup

**As a** claude-peers user running on WSL2,
**I want** the federation setup wizard to automatically configure Windows port forwarding,
**So that** LAN peers can reach my federation endpoint without me knowing `netsh` commands.

**Acceptance Criteria**:
- [x] Setup wizard detects WSL2 and runs `netsh interface portproxy add v4tov4` via elevated PowerShell *(already implemented)*
- [x] Windows Firewall inbound rule created for federation port *(already implemented)*
- [ ] **Verify** port forwarding was actually created: query `netsh interface portproxy show v4tov4` after setup and parse output
- [ ] **Verify** firewall rule exists: query `Get-NetFirewallRule -DisplayName Claude-Peers-Federation` and confirm
- [ ] **Detect Hyper-V firewall** (Windows 11 22H2+): check if `Get-NetFirewallHyperVRule` cmdlet exists, and if so, create a Hyper-V firewall rule too
- [ ] **Handle UAC denial gracefully**: if `Start-Process -Verb RunAs` fails or user clicks "No" on UAC prompt, detect the failure and print manual instructions
- [ ] **Detect existing stale rules**: before creating a new portproxy rule, check if one already exists for the same port but different connectaddress (stale WSL2 IP). If found, remove and replace.
- [ ] **Print verification summary**: after all setup steps, print a table showing each component and pass/fail status

**Implementation Notes**:
- `netsh interface portproxy show v4tov4` outputs a table; parse the line matching the federation port
- Hyper-V firewall cmdlets are only available on Windows 11 22H2+ with Hyper-V enabled
- UAC denial from `Start-Process -Verb RunAs` may manifest as a non-zero exit code or as the elevated process simply not running (the parent process exits 0 regardless in some cases)
- Consider splitting the elevated command into separate operations (portproxy, firewall, hyper-v firewall) so partial failures are identifiable

**Priority**: P1

---

### US-003: Handle WSL2 IP Changes on Restart

**As a** claude-peers user running on WSL2,
**I want** port forwarding rules to automatically update when WSL2's internal IP changes after a reboot,
**So that** federation doesn't silently break every time I restart my machine.

**Acceptance Criteria**:
- [ ] New CLI command: `bun src/cli.ts federation refresh-wsl2` that:
  1. Gets current WSL2 IP from `hostname -I`
  2. Queries existing portproxy rule for the federation port
  3. If the connectaddress differs from current WSL2 IP, updates the rule
  4. If no rule exists, creates it (same as setup)
  5. Prints before/after state
- [ ] `federation setup` on WSL2 offers to install a systemd user unit or shell profile hook that runs `refresh-wsl2` on login
- [ ] The `federation setup` wizard detects stale portproxy rules (wrong connectaddress) and auto-refreshes
- [ ] Broker startup on WSL2 checks if portproxy points to current WSL2 IP and logs a warning if mismatched
- [ ] Document the ZSH hook approach: add `bun /path/to/cli.ts federation refresh-wsl2 2>/dev/null &` to `~/.zshrc`

**Implementation Notes**:
- `netsh interface portproxy show v4tov4` can be queried from WSL2 via `powershell.exe`
- Parsing: the output has a fixed-width table format with `Address:Port` columns
- The refresh command needs admin elevation only if the rule needs updating
- A Windows Task Scheduler task triggered on login is more reliable than a shell hook (covers non-interactive shells, PowerShell sessions, etc.), but is harder to set up from WSL2
- systemd user units in WSL2 require `systemd=true` in `/etc/wsl.conf` (default on newer distros)

**Proposed ZSH hook** (minimal approach):
```bash
# ~/.zshrc addition (auto-generated by federation setup)
if [[ -n "$WSL_DISTRO_NAME" ]]; then
  bun /home/riche/MCPs/claude-peers-mcp/src/cli.ts federation refresh-wsl2 2>/dev/null &!
fi
```

**Priority**: P1

---

### US-004: Detect Windows Host LAN IP and Display for Remote Connection

**As a** claude-peers user running on WSL2,
**I want** the setup wizard to reliably detect my Windows host's LAN IP address,
**So that** I can share the correct connection string with remote peers.

**Acceptance Criteria**:
- [x] Setup wizard runs PowerShell `Get-NetIPAddress` to find Windows LAN IP *(already implemented)*
- [ ] **Improve IP detection reliability**: the current filter (`192.168.*` or `10.*`) misses `172.16-31.*` private ranges and may match VPN adapters
- [ ] Filter out known non-LAN interfaces: Hyper-V virtual switches (`vEthernet (WSL)`), VPN adapters (common names: `Tailscale`, `Mullvad`, `NordVPN`, `WireGuard`), Docker network adapters
- [ ] Prefer the interface that has the default route (gateway), not just any 192.168.* interface
- [ ] If multiple candidate IPs found, list all and highlight the most likely one (gateway-associated)
- [ ] If zero candidate IPs found, provide manual detection instructions: `ipconfig` in PowerShell, look for `Ethernet adapter` or `Wi-Fi adapter`
- [ ] Store the detected Windows LAN IP in the persistent config file for use by `refresh-wsl2` and status commands
- [ ] `federation status` on WSL2 shows: WSL2 IP, Windows LAN IP, portproxy rule, firewall rule status

**Implementation Notes**:
- Better PowerShell query:
  ```powershell
  Get-NetRoute -DestinationPrefix '0.0.0.0/0' |
    Sort-Object -Property RouteMetric |
    Select-Object -First 1 -ExpandProperty ifIndex |
    ForEach-Object { (Get-NetIPAddress -ifIndex $_ -AddressFamily IPv4).IPAddress }
  ```
  This gets the IP of the interface that has the default gateway, which is almost always the LAN adapter.
- Also support `172.16.0.0/12` private range (not just `192.168.*` and `10.*`)
- The config file (`~/.claude-peers-config.json`) already exists for federation settings; add a `wsl2` section

**Config schema addition**:
```json
{
  "federation": {
    "enabled": true,
    "port": 7900,
    "subnet": "0.0.0.0/0"
  },
  "wsl2": {
    "windowsLanIp": "192.168.4.5",
    "lastWslIp": "172.28.176.1",
    "lastRefresh": "2026-03-26T10:30:00Z"
  }
}
```

**Priority**: P2

---

### US-005: WSL2-Specific Documentation and Guided Troubleshooting

**As a** claude-peers user experiencing federation issues on WSL2,
**I want** WSL2-specific troubleshooting documentation and diagnostic commands,
**So that** I can identify and fix problems without deep networking knowledge.

**Acceptance Criteria**:
- [ ] New section in `docs/TROUBLESHOOTING.md`: **"WSL2 Federation Troubleshooting"** covering:
  - Port forwarding verification: how to check if `netsh portproxy` rule exists and points to correct IP
  - Windows Firewall verification: how to check if inbound rule exists
  - Hyper-V Firewall verification: how to check on Windows 11 22H2+
  - WSL2 IP change detection: how to tell if your IP changed
  - End-to-end connectivity test from Windows host to WSL2
  - Common failure modes table with symptoms, causes, and fixes
- [ ] New CLI command: `bun src/cli.ts federation diagnose` that runs automated diagnostics:
  1. Detect platform (WSL2/macOS/Linux)
  2. Check broker health
  3. Check federation listener
  4. **WSL2-specific checks**:
     - Current WSL2 IP vs portproxy target IP (match?)
     - Windows Firewall rule exists?
     - Federation port reachable from Windows host? (test via `powershell.exe curl`)
     - Windows LAN IP detected?
     - Hyper-V firewall rule exists? (if applicable)
  5. Print a diagnostic report with pass/warn/fail for each check
- [ ] The `diagnose` command suggests specific fix commands for each failed check
- [ ] Quick-fix mode: `bun src/cli.ts federation diagnose --fix` that auto-remedies fixable issues

**Diagnostic Output Example**:
```
[Federation Diagnostics — WSL2]

  Broker health ..................... PASS
  Federation listener .............. PASS (port 7900)
  WSL2 IP .......................... 172.28.176.42
  Port forwarding rule ............. FAIL (stale: points to 172.28.160.1)
    Fix: bun src/cli.ts federation refresh-wsl2
  Windows Firewall rule ............ PASS (Claude-Peers-Federation)
  Hyper-V Firewall rule ............ WARN (cmdlet not available — likely not needed)
  Reachable from Windows host ...... FAIL (connection refused on localhost:7900)
    Fix: Run the port forwarding fix above first
  Windows LAN IP ................... 192.168.4.5

  Overall: 2 issues found. Run with --fix to auto-remediate.
```

**Priority**: P2

---

### US-006: Detect WSL2 Mirrored Networking Mode

**As a** claude-peers user running WSL2 with mirrored networking (Windows 11 23H2+),
**I want** the federation system to detect that port forwarding is unnecessary,
**So that** setup is simpler and I don't get confusing port forwarding instructions.

**Acceptance Criteria**:
- [ ] Detect mirrored networking mode by checking `/etc/wsl.conf` or `.wslconfig` for `networkingMode=mirrored`
- [ ] When mirrored mode detected, skip all port forwarding steps in setup wizard
- [ ] Log: "WSL2 mirrored networking detected — port forwarding not required"
- [ ] `federation diagnose` on mirrored mode skips portproxy checks
- [ ] Document mirrored mode as the recommended WSL2 networking config for federation users

**Implementation Notes**:
- `.wslconfig` is at `C:\Users\<username>\.wslconfig`, accessible from WSL2 via `/mnt/c/Users/<username>/.wslconfig`
- The `[wsl2]` section may contain `networkingMode=mirrored`
- Mirrored mode was introduced in Windows 11 23H2 (build 23H2) and makes WSL2 share the host's IP stack
- In mirrored mode, `hostname -I` returns the actual Windows LAN IP, and services bind directly to the LAN
- WSL2 in mirrored mode may still need a Windows Firewall rule

**Priority**: P3

---

### US-007: Port Forwarding Status in Federation Status Command

**As a** claude-peers user on WSL2,
**I want** `federation status` to show WSL2-specific information,
**So that** I can quickly see if port forwarding is configured and current.

**Acceptance Criteria**:
- [ ] `bun src/cli.ts federation status` on WSL2 includes:
  - WSL2 internal IP (current)
  - Windows LAN IP (detected or from config)
  - Port forwarding rule: exists? Target IP matches current WSL2 IP?
  - Windows Firewall rule: exists?
  - Networking mode: NAT or mirrored
- [ ] Non-WSL2 platforms show their own relevant info (macOS firewall state, Linux iptables, etc.)
- [ ] Status information is also available programmatically: `bun src/cli.ts federation status --json`

**Priority**: P3

---

## 4. Technical Considerations

### 4.1 Windows Admin Elevation

`netsh interface portproxy` and `New-NetFirewallRule` require Administrator privileges. From WSL2:

- **Current approach**: `Start-Process powershell -Verb RunAs` triggers a UAC prompt on the Windows side.
- **Problem**: The elevated process runs asynchronously. The WSL2 side cannot reliably determine if the UAC prompt was accepted, denied, or timed out. Exit code 0 is returned regardless.
- **Mitigation**: After issuing the elevated command, wait briefly (1-2 seconds), then query the state (`netsh interface portproxy show v4tov4`) to verify the rule was created.
- **Alternative**: Write a small `.ps1` script to the Windows filesystem (`/mnt/c/temp/`), execute it elevated, and have it write a status file that WSL2 can read back.

### 4.2 WSL2 IP Determination

- **`hostname -I`**: Returns all IP addresses. First one is typically the Hyper-V NAT IP (172.x.x.x). Reliable.
- **`ip addr show eth0`**: More specific but assumes `eth0` as the interface name.
- **Edge case**: Multiple IPs if Docker or other network namespaces are active. Filter to `172.` prefix for the WSL2 NAT range.

### 4.3 Windows Host LAN IP Determination

- **Current**: `Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' }` — misses `172.16-31.*`, may match VPN adapters.
- **Better**: Follow the default route to find the LAN-facing interface:
  ```powershell
  (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } |
   Select-Object -First 1).IPv4Address.IPAddress
  ```
- **Fallback**: Parse `ipconfig` output for adapters named "Ethernet" or "Wi-Fi".

### 4.4 Windows Firewall vs. Hyper-V Firewall

| Layer | Applies To | Cmdlet | Windows Version |
|-------|-----------|--------|-----------------|
| Windows Defender Firewall | Host network stack | `New-NetFirewallRule` | All |
| Hyper-V Firewall | WSL2 VM traffic specifically | `New-NetFirewallHyperVRule` | Win 11 22H2+ |

On Windows 11 22H2+, both layers apply. Traffic from LAN must pass through Windows Firewall (on the host NIC) AND Hyper-V Firewall (on the WSL2 virtual switch). If only one rule is created, traffic may still be blocked.

**Detection**: `Get-Command Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue` — if the cmdlet exists, Hyper-V firewall is active.

**Rule creation**:
```powershell
New-NetFirewallHyperVRule -Name Claude-Peers-Federation -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7900 -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
```
(The VMCreatorId for WSL2 is the well-known GUID above.)

### 4.5 Mirrored Networking Detection

WSL2 mirrored networking (Windows 11 23H2+) fundamentally changes the networking model:

| Property | NAT Mode (default) | Mirrored Mode |
|----------|-------------------|---------------|
| WSL2 IP | 172.x.x.x (internal) | Same as Windows host |
| LAN reachability | Requires portproxy | Direct |
| `hostname -I` | Returns NAT IP | Returns LAN IP |
| Multicast | Not forwarded | Forwarded |
| Port forwarding | Required | Not needed |

**Detection methods** (check in order):
1. Read `/mnt/c/Users/<username>/.wslconfig` for `networkingMode=mirrored`
2. Check if `hostname -I` returns a LAN IP (192.168.*, 10.*, 172.16-31.*) instead of 172.16+ NAT range
3. Check `WSL_INTEROP` or registry keys

**Getting Windows username from WSL2**: `powershell.exe -NoProfile -Command '$env:USERNAME'` or parse `/mnt/c/Users/` directory.

### 4.6 Concurrency and Race Conditions

- Port forwarding refresh (US-003) must be idempotent. Two shells running refresh simultaneously should not corrupt the portproxy table.
- `netsh interface portproxy delete` + `netsh interface portproxy add` is not atomic. Brief window where no rule exists. Acceptable for this use case (federation retries on connection failure).

### 4.7 Testing Strategy

WSL2-specific code is difficult to unit test on non-WSL2 environments. Approach:

- **Mock-based unit tests**: Mock `isWSL2()`, `hostname -I`, and PowerShell commands. Test logic paths.
- **Integration tests**: Only run on WSL2 (skip with `describe.skipIf(!isWSL2())`). Verify actual portproxy creation/deletion.
- **Snapshot tests**: Capture diagnostic output format for the `diagnose` command.
- **CI consideration**: GitHub Actions does not support WSL2. WSL2-specific integration tests must run locally only.

---

## 5. Non-Goals

The following are explicitly out of scope for this PRD:

1. **WSL1 support**: WSL1 does not use a VM and has different networking (shared host IP). It is uncommon for development workflows and not worth the additional code paths.

2. **Automatic mDNS/Bonjour discovery on WSL2**: Multicast does not work on WSL2 NAT mode. Auto-discovery is a Phase B federation feature and will be addressed separately with WSL2 mirrored mode as a prerequisite.

3. **GUI/graphical setup wizard**: The CLI wizard is sufficient. No Windows GUI or system tray application.

4. **VPN tunnel support**: Tailscale, ZeroTier, WireGuard, and similar overlay networks have their own IP ranges and routing. Supporting these adds significant complexity and is better handled by user-configured `CLAUDE_PEERS_FEDERATION_SUBNET`.

5. **Docker Desktop for Windows networking**: Docker on WSL2 adds yet another network namespace. Out of scope.

6. **WSL2 networking mode changes at runtime**: If the user switches between NAT and mirrored mode, they need to re-run `federation setup`. No hot-reload.

7. **Automated Windows Update detection**: Windows updates can reset firewall rules or change Hyper-V behavior. This is documented in troubleshooting but not auto-detected.

---

## 6. Success Metrics

### Quantitative

| Metric | Target | Measurement |
|--------|--------|-------------|
| Setup wizard completion rate on WSL2 | 100% of automated steps succeed (excluding UAC denial) | Verify via `federation diagnose` after setup |
| Port forwarding survives WSL2 restart | 100% when ZSH hook or systemd unit installed | `federation diagnose` returns all-PASS after reboot |
| Time to working federation on WSL2 | < 3 minutes from `federation setup` to verified connectivity | Manual timing during user testing |
| Diagnostic coverage | `federation diagnose` catches 100% of known WSL2 failure modes | Enumerated in test suite |

### Qualitative

| Metric | Target |
|--------|--------|
| User needs zero Windows networking knowledge | Setup wizard handles everything; user only needs to accept UAC prompt |
| Error messages are actionable | Every FAIL in diagnostics includes a specific fix command |
| Documentation is self-contained | WSL2 troubleshooting section answers all common questions without external links |
| No silent failures | Every step that can fail is verified and reported |

### Definition of Done

- [ ] All user stories at P1 priority are implemented and tested
- [ ] `federation setup` on WSL2 produces all-PASS from `federation diagnose`
- [ ] `federation refresh-wsl2` correctly updates stale portproxy rules
- [ ] `docs/TROUBLESHOOTING.md` has a comprehensive WSL2 section
- [ ] At least 10 new tests covering WSL2 code paths (mock-based)
- [ ] Manual end-to-end test: WSL2 machine federates with macOS or native Linux machine after fresh setup
- [ ] CHANGELOG.md updated with WSL2 improvements

---

## 7. Implementation Plan

### Phase 1: Verification and Refresh (US-001 hardening, US-002 verification, US-003)

**Goal**: Make the existing setup robust and survivable across reboots.

1. Add post-setup verification to `federationSetupWSL2()` — query portproxy and firewall state after commands run
2. Implement `federation refresh-wsl2` CLI command
3. Add stale rule detection to `federation setup`
4. Add env var override warning for `CLAUDE_PEERS_FEDERATION_SUBNET` on WSL2
5. Write mock-based unit tests for refresh logic

### Phase 2: Diagnostics and IP Detection (US-004, US-005)

**Goal**: Reliable IP detection and comprehensive diagnostics.

1. Improve Windows LAN IP detection (default route method)
2. Implement `federation diagnose` command with WSL2-specific checks
3. Add `--fix` mode to diagnose
4. Store WSL2 state in config file
5. Update `federation status` with WSL2 info (US-007)

### Phase 3: Mirrored Mode and Documentation (US-005 docs, US-006)

**Goal**: Future-proof for mirrored networking and comprehensive docs.

1. Implement mirrored networking detection
2. Skip port forwarding when mirrored mode detected
3. Write comprehensive WSL2 troubleshooting documentation
4. Add common failure modes table to docs

### Phase 4: Polish

1. ZSH hook generation for auto-refresh
2. Optional systemd user unit for auto-refresh
3. End-to-end manual testing on real WSL2 + macOS/Linux setup
4. CHANGELOG and README updates

---

## Appendix A: Known WSL2 Failure Modes

This table captures all WSL2-specific failure modes discovered during real-world testing. Each should be detectable by `federation diagnose`.

| # | Failure Mode | Symptom | Root Cause | Fix |
|---|-------------|---------|------------|-----|
| 1 | Stale portproxy rule | Connection refused from LAN | WSL2 IP changed after reboot; portproxy points to old IP | `federation refresh-wsl2` |
| 2 | Missing portproxy rule | Connection refused from LAN | Setup never run, or rule was deleted | `federation setup` |
| 3 | Missing Windows Firewall rule | Connection timeout from LAN | Firewall blocks inbound TCP on federation port | Create rule via `New-NetFirewallRule` |
| 4 | Missing Hyper-V Firewall rule | Connection timeout from LAN (Win 11 22H2+) | Second firewall layer blocks traffic | Create rule via `New-NetFirewallHyperVRule` |
| 5 | UAC denied | Port forwarding not created | User clicked "No" on elevation prompt | Re-run setup and accept UAC |
| 6 | Subnet rejection | "outside allowed subnet" error | Manually set subnet conflicts with NAT IP rewriting | Set subnet to `0.0.0.0/0` |
| 7 | Wrong LAN IP shared | Remote peer can't connect | VPN adapter IP was detected instead of LAN IP | Use default-route method for IP detection |
| 8 | WSL2 not started with systemd | Refresh hook not running | `/etc/wsl.conf` missing `systemd=true` | Use ZSH hook instead of systemd unit |
| 9 | Multiple portproxy rules | Unpredictable routing | Previous setup created rule, new setup creates duplicate | Delete-then-add pattern |
| 10 | Broker listening on 127.0.0.1 only | Federation unreachable even with portproxy | Federation not enabled; broker only binds localhost | Enable federation: `federation enable` + restart broker |

---

## Appendix B: PowerShell Commands Reference

Commands used from WSL2 via `powershell.exe`:

```powershell
# --- Port Forwarding ---
# Create
netsh interface portproxy add v4tov4 listenport=7900 listenaddress=0.0.0.0 connectport=7900 connectaddress=<WSL2_IP>

# Update (delete + re-add)
netsh interface portproxy delete v4tov4 listenport=7900 listenaddress=0.0.0.0
netsh interface portproxy add v4tov4 listenport=7900 listenaddress=0.0.0.0 connectport=7900 connectaddress=<NEW_WSL2_IP>

# Query
netsh interface portproxy show v4tov4

# --- Windows Firewall ---
# Create inbound rule
New-NetFirewallRule -DisplayName "Claude-Peers-Federation" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7900

# Check if rule exists
Get-NetFirewallRule -DisplayName "Claude-Peers-Federation" -ErrorAction SilentlyContinue

# --- Hyper-V Firewall (Win 11 22H2+) ---
# Check if cmdlet exists
Get-Command Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue

# Create rule (WSL2 VMCreatorId)
New-NetFirewallHyperVRule -Name "Claude-Peers-Federation" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7900 -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'

# --- LAN IP Detection (default route method) ---
(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -First 1).IPv4Address.IPAddress

# --- Connectivity Test ---
curl.exe -sk https://localhost:7900/health
```

---

## Appendix C: Related Files

| File | Relevance |
|------|-----------|
| `src/federation.ts` | `isWSL2()`, `detectSubnet()` — WSL2 detection and subnet logic |
| `src/cli.ts` | `federationSetupWSL2()` — current port forwarding setup |
| `src/broker.ts` | Federation TLS listener, subnet checking |
| `docs/TROUBLESHOOTING.md` | User-facing troubleshooting docs |
| `~/.claude-peers-config.json` | Persistent federation config (will add `wsl2` section) |
| `tests/federation.test.ts` | Existing federation tests (will add WSL2-specific tests) |
