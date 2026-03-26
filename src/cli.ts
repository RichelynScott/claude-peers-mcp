#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status                    — Show broker status and all peers
 *   bun cli.ts peers                     — List all peers
 *   bun cli.ts send <id> <msg>           — Send a message to a peer
 *   bun cli.ts broadcast <scope> <msg>   — Broadcast to all peers in scope
 *   bun cli.ts set-name <id> <name>      — Set a peer's session name
 *   bun cli.ts auto-summary <id>         — Generate and set a deterministic summary
 *   bun cli.ts rotate-token               — Rotate the auth token
 *   bun cli.ts restart                   — Kill ALL claude-peers processes (broker + servers)
 *   bun cli.ts kill-broker               — Stop the broker daemon
 *   bun cli.ts federation connect <host>:<port>  — Connect to a remote broker
 *   bun cli.ts federation disconnect <host>:<port> — Disconnect from a remote broker
 *   bun cli.ts federation status         — Show federation status
 *   bun cli.ts federation setup          — Guided federation setup (WSL2/macOS port forwarding)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { TOKEN_PATH, readTokenSync } from "./shared/token.ts";
import { loadConfig, writeConfig, CONFIG_PATH, addRemoteToConfig } from "./shared/config.ts";
import { ensureTlsCert } from "./federation.ts";
import type { BroadcastResponse, FederationStatusResponse } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

// Read auth token (required for all authenticated commands)
let authToken: string = "";

async function brokerFetch<T>(fetchPath: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }
    : { headers };
  const res = await fetch(`${BROKER_URL}${fetchPath}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Exported helper functions (used by auto-summary, testable independently)
// ---------------------------------------------------------------------------

/**
 * Get the git repository name (basename of git root) for a directory.
 * Returns null if not a git repo.
 */
export function getGitRepoName(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    const toplevel = new TextDecoder().decode(proc.stdout).trim();
    if (!toplevel) return null;
    return path.basename(toplevel);
  } catch {
    return null;
  }
}

/**
 * Get the current git branch name for a directory.
 * Returns null if not a git repo.
 */
export function getGitBranchName(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    const branch = new TextDecoder().decode(proc.stdout).trim();
    if (!branch) return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Get the count of in-progress TaskMaster tasks.
 * Returns null if task-master is not installed, has no data, or times out.
 * Uses a 2-second timeout to prevent hanging.
 */
export async function getTaskMasterInProgress(cwd: string): Promise<number | null> {
  try {
    // Check if task-master is available
    const whichProc = Bun.spawnSync(["which", "task-master"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (whichProc.exitCode !== 0) return null;

    const proc = Bun.spawn(["task-master", "list", "--status=in-progress"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });

    // Race between process completion and 2s timeout
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 2000);
    });

    const resultPromise = (async (): Promise<number | null> => {
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) return null;

      const trimmed = text.trim();
      if (!trimmed) return null;

      // Try to parse as JSON first (array of tasks)
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.length;
        }
        return null;
      } catch {
        // Fall back to counting non-empty lines (text output)
        // Filter out header/separator lines that are common in CLI table output
        const lines = trimmed.split("\n").filter((line) => {
          const l = line.trim();
          return l.length > 0 && !l.startsWith("-") && !l.startsWith("=") && !l.startsWith("ID");
        });
        return lines.length > 0 ? lines.length : null;
      }
    })();

    const result = await Promise.race([resultPromise, timeoutPromise]);

    // Kill the process if it's still running (timeout case)
    try {
      proc.kill();
    } catch {
      // Process already exited, ignore
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Build a deterministic summary string from environment context.
 * Pure function — no side effects.
 *
 * Format rules:
 *   - Git repo + branch + tasks: `[<repo>:<branch>] <N> in-progress tasks`
 *   - Git repo + branch, no tasks: `[<repo>:<branch>] Working in <cwd>`
 *   - No git context: `Working in <cwd>`
 */
export function buildSummary(opts: {
  repoName: string | null;
  branch: string | null;
  cwd: string;
  taskCount: number | null;
}): string {
  const { repoName, branch, cwd, taskCount } = opts;

  const hasGit = repoName !== null && branch !== null;
  const prefix = hasGit ? `[${repoName}:${branch}] ` : "";

  if (hasGit && taskCount !== null && taskCount > 0) {
    return `${prefix}${taskCount} in-progress task${taskCount === 1 ? "" : "s"}`;
  }

  return `${prefix}Working in ${cwd}`;
}

/**
 * Format an ISO timestamp as a human-readable uptime string (e.g., "2h 15m").
 */
export function formatUptime(isoTimestamp: string): string {
  const connected = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const diffMs = Math.max(0, now - connected);
  const totalSec = Math.floor(diffMs / 1000);

  if (totalSec < 60) return `${totalSec}s`;

  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;

  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

// ---------------------------------------------------------------------------
// Federation setup wizard
// ---------------------------------------------------------------------------

async function federationSetup(): Promise<void> {
  const FEDERATION_PORT = parseInt(process.env.CLAUDE_PEERS_FEDERATION_PORT ?? "7900", 10);

  // --- Environment detection ---
  const isWSL2 =
    !!process.env.WSL_DISTRO_NAME ||
    (await Bun.file("/proc/sys/fs/binfmt_misc/WSLInterop").exists());
  const isMac = process.platform === "darwin";

  const platformLabel = isWSL2 ? "WSL2" : isMac ? "macOS" : "Linux";
  console.log(`\n[Federation Setup — ${platformLabel} Detected]\n`);

  // --- Step 1: Token file ---
  const tokenExists = await Bun.file(TOKEN_PATH).exists();
  if (tokenExists) {
    console.log(`  1. ✓ Token file exists (${TOKEN_PATH})`);
  } else {
    console.log(`  1. ✗ Token file missing (${TOKEN_PATH})`);
    console.log(`     Create one with: bun src/cli.ts rotate-token`);
    console.log("");
    return;
  }

  // --- Step 2: Federation enabled? ---
  const config = loadConfig();
  const fedEnabled =
    process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "true" ||
    config.federation?.enabled === true;
  if (fedEnabled) {
    const source = process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "true" ? "env var" : "config file";
    console.log(`  2. ✓ Federation enabled (${source})`);
  } else {
    console.log("  2. ✗ Federation not enabled");
    console.log("     Set CLAUDE_PEERS_FEDERATION_ENABLED=true in your environment");
    console.log(`     or run this command to enable persistently:`);
    console.log(`     bun src/cli.ts federation enable`);
    console.log("");
    return;
  }

  // --- Step 3: Broker running with federation? ---
  let brokerOk = false;
  let federationListening = false;
  try {
    await brokerFetch<{ status: string }>("/health");
    brokerOk = true;
    const fedStatus = await brokerFetch<FederationStatusResponse>("/federation/status");
    federationListening = fedStatus.enabled;
  } catch {
    // broker not running or federation endpoint failed
  }

  if (!brokerOk) {
    console.log("  3. ✗ Broker is not running");
    console.log("     Start a Claude Code session or run: bun src/broker.ts");
    console.log("");
    return;
  }
  if (!federationListening) {
    console.log("  3. ✗ Broker is running but federation is not active");
    console.log("     Restart the broker with CLAUDE_PEERS_FEDERATION_ENABLED=true");
    console.log("     Run: bun src/cli.ts kill-broker   (it will auto-restart with the env var)");
    console.log("");
    return;
  }
  console.log(`  3. ✓ Broker running with federation on port ${FEDERATION_PORT}`);

  // --- Platform-specific network setup ---
  if (isWSL2) {
    await federationSetupWSL2(FEDERATION_PORT);
  } else if (isMac) {
    await federationSetupMacOS(FEDERATION_PORT);
  } else {
    await federationSetupLinux(FEDERATION_PORT);
  }

  // --- Token sharing guidance (always) ---
  console.log(`\n[Token Sharing]`);
  console.log(`Both machines must share the same token for authentication.`);
  console.log(`Copy your token to the remote machine:`);
  console.log(`  scp ~/.claude-peers-token user@<remote-ip>:~/.claude-peers-token`);
  console.log(`\nOr manually: the token is a single line in ~/.claude-peers-token`);

  // --- Save config file so federation survives broker restarts ---
  const existingConfig = loadConfig();
  const newConfig = {
    ...existingConfig,
    federation: {
      enabled: true,
      port: FEDERATION_PORT,
      subnet: process.env.CLAUDE_PEERS_FEDERATION_SUBNET || existingConfig.federation?.subnet || "0.0.0.0/0",
    },
  };
  writeConfig(newConfig);
  console.log(`\n✓ Config saved to ${CONFIG_PATH}`);
  console.log("  Federation will auto-enable on broker restart (no env vars needed).\n");
}

async function federationSetupWSL2(fedPort: number): Promise<void> {
  console.log("  4. Setting up Windows port forwarding...");

  // WSL2 subnet must be 0.0.0.0/0 — port forwarding rewrites source IPs
  console.log("");
  console.log("     Note: On WSL2, subnet restriction is set to 0.0.0.0/0 (allow all)");
  console.log("     because Windows port forwarding rewrites source IPs. Security is");
  console.log("     provided by PSK authentication + TLS encryption.");
  console.log("");
  console.log("     Ensure your environment includes:");
  console.log("       export CLAUDE_PEERS_FEDERATION_SUBNET=0.0.0.0/0");
  console.log("");

  // Get WSL2 internal IP
  const wslIpProc = Bun.spawnSync(["hostname", "-I"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const wslIp = new TextDecoder().decode(wslIpProc.stdout).trim().split(" ")[0];
  if (!wslIp) {
    console.log("     ✗ Could not determine WSL2 IP address");
    return;
  }
  console.log(`     WSL2 IP: ${wslIp}`);
  console.log(`     Windows will forward port ${fedPort} to WSL2`);
  console.log(`     (This requires Windows admin — you may see a UAC prompt)`);

  // Set up port forwarding via elevated PowerShell
  const setupCmd = `Start-Process powershell -ArgumentList '-NoProfile -Command "netsh interface portproxy add v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 connectport=${fedPort} connectaddress=${wslIp}; New-NetFirewallRule -DisplayName Claude-Peers-Federation -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${fedPort} -ErrorAction SilentlyContinue"' -Verb RunAs`;

  const fwdProc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", setupCmd], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (fwdProc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(fwdProc.stderr).trim();
    console.log(`     ⚠ Port forwarding command returned exit code ${fwdProc.exitCode}`);
    if (stderr) console.log(`     ${stderr}`);
    console.log(`     You may need to run this manually from an elevated PowerShell:`);
    console.log(`     netsh interface portproxy add v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 connectport=${fedPort} connectaddress=${wslIp}`);
    console.log(`     New-NetFirewallRule -DisplayName Claude-Peers-Federation -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${fedPort}`);
  } else {
    console.log("     ✓ Port forwarding configured");
  }

  // Get Windows LAN IP
  const winIpProc = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoProfile",
      "-Command",
      "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1 -ExpandProperty IPAddress",
    ],
    { stdout: "pipe", stderr: "ignore" }
  );
  const windowsLanIp = new TextDecoder().decode(winIpProc.stdout).trim();

  if (windowsLanIp) {
    console.log(`     Your LAN IP: ${windowsLanIp}`);
    console.log("");
    console.log(`     Remote machines can connect with:`);
    console.log(`       bun src/cli.ts federation connect ${windowsLanIp}:${fedPort}`);
  } else {
    console.log("     ⚠ Could not determine Windows LAN IP");
    console.log("     Check your IP manually: ipconfig (in PowerShell/CMD)");
  }

  console.log("");
  console.log(`  5. To connect to a remote machine:`);
  console.log(`     bun src/cli.ts federation connect <remote-ip>:${fedPort}`);
}

async function federationSetupMacOS(fedPort: number): Promise<void> {
  console.log("  4. Checking firewall...");

  // Check if macOS firewall is on
  const fwProc = Bun.spawnSync(
    ["defaults", "read", "/Library/Preferences/com.apple.alf", "globalstate"],
    { stdout: "pipe", stderr: "ignore" }
  );
  const fwState = new TextDecoder().decode(fwProc.stdout).trim();
  if (fwState === "0") {
    console.log("     ✓ macOS firewall is off (no action needed)");
  } else {
    console.log("     macOS firewall is on — ensure Bun is allowed:");
    console.log(
      `     sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which bun) --unblockapp $(which bun)`
    );
  }

  // Get macOS LAN IP
  const macIpProc = Bun.spawnSync(["ipconfig", "getifaddr", "en0"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const macIp = new TextDecoder().decode(macIpProc.stdout).trim();

  if (macIp) {
    console.log(`     Your LAN IP: ${macIp}`);
    console.log("");
    console.log(`     Remote machines can connect with:`);
    console.log(`       bun src/cli.ts federation connect ${macIp}:${fedPort}`);
  } else {
    console.log("     ⚠ Could not determine LAN IP (en0 not active?)");
    console.log("     Check your IP manually: ipconfig getifaddr en0 (or en1 for ethernet)");
  }

  console.log("");
  console.log(`  5. To connect to a remote machine:`);
  console.log(`     bun src/cli.ts federation connect <remote-ip>:${fedPort}`);
}

async function federationSetupLinux(fedPort: number): Promise<void> {
  console.log("  4. Checking network...");

  // Get LAN IP
  const ipProc = Bun.spawnSync(["hostname", "-I"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const allIps = new TextDecoder().decode(ipProc.stdout).trim().split(/\s+/);
  // Prefer 192.168.x or 10.x addresses
  const lanIp =
    allIps.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.")) ??
    allIps[0];

  if (lanIp) {
    console.log(`     Your LAN IP: ${lanIp}`);
    console.log("");
    console.log(`     Remote machines can connect with:`);
    console.log(`       bun src/cli.ts federation connect ${lanIp}:${fedPort}`);
    console.log("");
    console.log(`     If connections are refused, check your firewall:`);
    console.log(`       sudo ufw allow ${fedPort}/tcp   # UFW`);
    console.log(`       sudo firewall-cmd --add-port=${fedPort}/tcp --permanent   # firewalld`);
  } else {
    console.log("     ⚠ Could not determine LAN IP");
    console.log("     Check your IP manually: hostname -I");
  }

  console.log("");
  console.log(`  5. To connect to a remote machine:`);
  console.log(`     bun src/cli.ts federation connect <remote-ip>:${fedPort}`);
}

// --- Platform detection helpers ---

async function isWSL2(): Promise<boolean> {
  return !!process.env.WSL_DISTRO_NAME || (await Bun.file("/proc/sys/fs/binfmt_misc/WSLInterop").exists());
}

async function isWSL2MirroredMode(): Promise<boolean> {
  // Check .wslconfig for networkingMode=mirrored
  try {
    const winUser = new TextDecoder().decode(
      Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", "$env:USERNAME"], { stdout: "pipe", stderr: "ignore" }).stdout
    ).trim();
    if (winUser) {
      const wslConfig = await Bun.file(`/mnt/c/Users/${winUser}/.wslconfig`).text();
      if (/networkingMode\s*=\s*mirrored/i.test(wslConfig)) return true;
    }
  } catch {}
  return false;
}

// --- Helper: detect LAN IP ---
async function detectLanIp(): Promise<string | null> {
  if (await isWSL2()) {
    // US-004: Use default route method for reliable LAN IP detection on WSL2
    const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command",
      "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -First 1).IPv4Address.IPAddress"],
      { stdout: "pipe", stderr: "ignore" });
    const ip = new TextDecoder().decode(proc.stdout).trim();
    if (ip) return ip;

    // Fallback: broader pattern matching (includes 172.16-31.*)
    const fallback = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command",
      "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or ($_.IPAddress -like '172.*' -and [int]($_.IPAddress.Split('.')[1]) -ge 16 -and [int]($_.IPAddress.Split('.')[1]) -le 31) } | Select-Object -First 1 -ExpandProperty IPAddress"],
      { stdout: "pipe", stderr: "ignore" });
    return new TextDecoder().decode(fallback.stdout).trim() || null;
  }
  if (process.platform === "darwin") {
    const proc = Bun.spawnSync(["ipconfig", "getifaddr", "en0"], { stdout: "pipe", stderr: "ignore" });
    return new TextDecoder().decode(proc.stdout).trim() || null;
  }
  // Linux
  const proc = Bun.spawnSync(["hostname", "-I"], { stdout: "pipe", stderr: "ignore" });
  const ips = new TextDecoder().decode(proc.stdout).trim().split(/\s+/);
  return ips.find(ip => ip.startsWith("192.168.") || ip.startsWith("10.")) ?? ips[0] ?? null;
}

// --- US-003: WSL2 port forwarding refresh ---
async function refreshWSL2PortForwarding(): Promise<void> {
  if (!(await isWSL2())) {
    console.error("Error: This command is only for WSL2 environments.");
    process.exit(1);
  }

  if (await isWSL2MirroredMode()) {
    console.log("WSL2 mirrored networking detected — port forwarding not required.");
    return;
  }

  const config = loadConfig();
  const fedPort = config.federation?.port || parseInt(process.env.CLAUDE_PEERS_FEDERATION_PORT ?? "7900", 10);

  // Get current WSL2 IP
  const wslIp = new TextDecoder().decode(
    Bun.spawnSync(["hostname", "-I"], { stdout: "pipe", stderr: "ignore" }).stdout
  ).trim().split(" ")[0];

  if (!wslIp) {
    console.error("Error: Could not determine WSL2 IP address.");
    process.exit(1);
  }

  // Query existing portproxy rule
  const showProc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command",
    "netsh interface portproxy show v4tov4"], { stdout: "pipe", stderr: "ignore" });
  const rules = new TextDecoder().decode(showProc.stdout);

  // Parse: look for our port
  const portRegex = new RegExp(`0\\.0\\.0\\.0\\s+${fedPort}\\s+(\\S+)\\s+${fedPort}`, "m");
  const match = rules.match(portRegex);

  if (match) {
    const currentTarget = match[1];
    if (currentTarget === wslIp) {
      console.log(`Port forwarding is current (port ${fedPort} → ${wslIp})`);
      return;
    }
    console.log(`Stale portproxy detected: port ${fedPort} → ${currentTarget} (should be ${wslIp})`);
    console.log("Updating...");
  } else {
    console.log(`No portproxy rule for port ${fedPort}. Creating...`);
  }

  // Update via elevated PowerShell (delete old + add new)
  const updateCmd = `Start-Process powershell -ArgumentList '-NoProfile -Command "netsh interface portproxy delete v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 2>$null; netsh interface portproxy add v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 connectport=${fedPort} connectaddress=${wslIp}"' -Verb RunAs -Wait`;
  Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", updateCmd], { stdout: "ignore", stderr: "ignore" });

  // Verify
  await new Promise(r => setTimeout(r, 1000));
  const verifyProc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command",
    "netsh interface portproxy show v4tov4"], { stdout: "pipe", stderr: "ignore" });
  const verifyRules = new TextDecoder().decode(verifyProc.stdout);
  const verifyMatch = verifyRules.match(portRegex);

  if (verifyMatch && verifyMatch[1] === wslIp) {
    console.log(`OK  Port forwarding updated (port ${fedPort} → ${wslIp})`);
  } else {
    console.log(`WARN  Could not verify port forwarding update. You may need admin elevation.`);
    console.log(`Manual fix: Run in elevated PowerShell:`);
    console.log(`  netsh interface portproxy add v4tov4 listenport=${fedPort} listenaddress=0.0.0.0 connectport=${fedPort} connectaddress=${wslIp}`);
  }
}

// --- US-003: federation init ---
async function federationInit(): Promise<void> {
  const isWSL2Flag = await isWSL2();
  const isMac = process.platform === "darwin";
  const platform = isWSL2Flag ? "WSL2" : isMac ? "macOS" : "Linux";
  const fedPort = parseInt(process.env.CLAUDE_PEERS_FEDERATION_PORT ?? "7900", 10);

  console.log(`\n[Federation Init — ${platform} Detected]\n`);
  let step = 1;

  // 1. Config file
  const existingConfig = loadConfig();
  const subnet = isWSL2Flag ? "0.0.0.0/0" : (existingConfig.federation?.subnet || "0.0.0.0/0");
  const newConfig = {
    ...existingConfig,
    federation: {
      ...existingConfig.federation,
      enabled: true,
      port: fedPort,
      subnet,
    },
  };
  writeConfig(newConfig);
  console.log(`  ${step++}. OK  Config file written (${CONFIG_PATH})`);

  // 2. TLS certificate
  try {
    await ensureTlsCert();
    console.log(`  ${step++}. OK  TLS certificate ready`);
  } catch (e) {
    console.log(`  ${step++}. FAIL  TLS certificate: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Auth token
  const tokenExists = await Bun.file(TOKEN_PATH).exists();
  if (tokenExists) {
    console.log(`  ${step++}. OK  Auth token ready (${TOKEN_PATH})`);
  } else {
    // Token is auto-created by broker; just note it
    console.log(`  ${step++}. OK  Auth token will be created on broker start`);
  }

  // 4. Platform-specific network setup
  if (isWSL2Flag) {
    if (await isWSL2MirroredMode()) {
      console.log(`  ${step++}. OK  WSL2 mirrored networking detected — port forwarding not required`);
      step++;
    } else {
      await federationSetupWSL2(fedPort);
      step += 2;
    }
  } else if (isMac) {
    await federationSetupMacOS(fedPort);
    step += 2;
  } else {
    await federationSetupLinux(fedPort);
    step += 2;
  }

  // 5. Kill broker to restart with new config
  try {
    await brokerFetch<{ ok: boolean }>("/health");
    // Broker is running — kill it so it restarts with federation
    const killProc = Bun.spawnSync(["pkill", "-f", "bun.*src/broker.ts"], { stdout: "ignore", stderr: "ignore" });
    console.log(`  ${step++}. OK  Broker restarted with federation enabled`);
  } catch {
    console.log(`  ${step++}. OK  Broker not running (will start with federation on next session)`);
  }

  // 6. Output join command
  const lanIp = await detectLanIp();
  if (lanIp && tokenExists) {
    try {
      const token = readTokenSync();
      const encodedToken = Buffer.from(token).toString("base64url");
      const joinUrl = `cpt://${lanIp}:${fedPort}/${encodedToken}`;
      console.log(`\nYour LAN IP: ${lanIp}`);
      console.log(`\nTo connect another machine, run this on the remote:`);
      console.log(`  bun src/cli.ts federation join ${joinUrl}`);
      console.log(`\n⚠  This URL contains your federation token. Share it only with trusted machines on your LAN.`);
    } catch {
      console.log(`\nYour LAN IP: ${lanIp}`);
      console.log(`\nGenerate a join URL: bun src/cli.ts federation token`);
    }
  } else if (lanIp) {
    console.log(`\nYour LAN IP: ${lanIp}`);
    console.log(`After broker starts, generate a join URL: bun src/cli.ts federation token`);
  }
  console.log("");
}

// --- US-004: federation token ---
async function federationToken(): Promise<void> {
  const config = loadConfig();
  const fedPort = config.federation?.port || parseInt(process.env.CLAUDE_PEERS_FEDERATION_PORT ?? "7900", 10);
  const lanIp = await detectLanIp();

  if (!lanIp) {
    console.error("Error: Could not detect LAN IP. Specify manually with: CLAUDE_PEERS_LAN_IP=x.x.x.x bun src/cli.ts federation token");
    process.exit(1);
  }

  let token: string;
  try {
    token = readTokenSync();
  } catch {
    console.error(`Error: Token file not found at ${TOKEN_PATH}. Run 'federation init' first.`);
    process.exit(1);
  }

  const encodedToken = Buffer.from(token).toString("base64url");
  const joinUrl = `cpt://${lanIp}:${fedPort}/${encodedToken}`;

  console.log(joinUrl);
  console.error(`\n⚠  This URL contains your federation token. Share it only with trusted machines on your LAN.`);
}

// --- US-004: federation join ---
async function federationJoin(cptUrl: string): Promise<void> {
  // Parse cpt://<host>:<port>/<base64url-token>
  if (!cptUrl.startsWith("cpt://")) {
    console.error(`Error: Invalid URL format. Expected cpt://<host>:<port>/<token>`);
    process.exit(1);
  }

  const remainder = cptUrl.slice(6); // strip cpt://
  const slashIdx = remainder.indexOf("/", remainder.indexOf(":") + 1);
  if (slashIdx === -1) {
    console.error(`Error: Invalid URL format. Expected cpt://<host>:<port>/<token>`);
    process.exit(1);
  }

  const hostPort = remainder.slice(0, slashIdx);
  const encodedToken = remainder.slice(slashIdx + 1);
  const colonIdx = hostPort.lastIndexOf(":");
  const host = hostPort.slice(0, colonIdx);
  const port = parseInt(hostPort.slice(colonIdx + 1), 10);

  if (!host || isNaN(port)) {
    console.error(`Error: Could not parse host:port from "${hostPort}"`);
    process.exit(1);
  }

  let token: string;
  try {
    token = Buffer.from(encodedToken, "base64url").toString("utf-8");
  } catch {
    console.error(`Error: Could not decode token from URL`);
    process.exit(1);
  }

  console.log(`[Federation Join]\n`);

  // 1. Write token
  const existingToken = await Bun.file(TOKEN_PATH).exists();
  if (existingToken) {
    const current = readTokenSync();
    if (current !== token) {
      console.log(`  ⚠  Token file already exists with a different token.`);
      console.log(`  Overwriting with the new token from the join URL.`);
    }
  }
  fs.writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  console.log(`  1. OK  Token written to ${TOKEN_PATH}`);

  // 2. Update config
  const config = loadConfig();
  const fedPort = config.federation?.port || 7900;
  writeConfig({
    ...config,
    federation: {
      ...config.federation,
      enabled: true,
      port: fedPort,
      remotes: [
        ...(config.federation?.remotes ?? []).filter(r => `${r.host}:${r.port}` !== `${host}:${port}`),
        { host, port },
      ],
    },
  });
  console.log(`  2. OK  Config updated (federation enabled, remote added)`);

  // 3. TLS cert
  try {
    await ensureTlsCert();
    console.log(`  3. OK  TLS certificate ready`);
  } catch (e) {
    console.log(`  3. FAIL  TLS certificate: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. Kill broker to restart
  try {
    Bun.spawnSync(["pkill", "-f", "bun.*src/broker.ts"], { stdout: "ignore", stderr: "ignore" });
    console.log(`  4. OK  Broker restarted`);
  } catch {
    console.log(`  4. OK  Broker not running (will start on next session)`);
  }

  // 5. Wait for broker to come up and try to connect
  console.log(`  5. Connecting to ${host}:${port}...`);
  await new Promise(r => setTimeout(r, 2000)); // Wait for broker restart

  try {
    const result = await brokerFetch<{ ok: boolean; hostname?: string; error?: string }>("/federation/connect", { host, port });
    if (result.ok) {
      console.log(`     OK  Connected to ${result.hostname ?? host}`);
    } else {
      console.log(`     ⚠  Connection attempt failed: ${result.error}`);
      console.log(`     The broker will auto-reconnect on next restart.`);
    }
  } catch {
    console.log(`     ⚠  Broker not ready yet. Auto-reconnect will handle it on next startup.`);
  }

  console.log("");
}

// --- US-007: federation doctor ---
async function federationDoctor(): Promise<void> {
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  function ok(msg: string) { console.log(`  OK   ${msg}`); passed++; }
  function fail(msg: string, fix?: string) {
    console.log(`  FAIL ${msg}`);
    if (fix) console.log(`       Fix: ${fix}`);
    failed++;
  }
  function warn(msg: string, fix?: string) {
    console.log(`  WARN ${msg}`);
    if (fix) console.log(`       Fix: ${fix}`);
    warnings++;
  }

  console.log(`\nFederation Health Check\n${"=".repeat(23)}\n`);

  // 1. Config file
  const config = loadConfig();
  if (Object.keys(config).length > 0) {
    ok(`Config file (${CONFIG_PATH})`);
  } else {
    fail(`Config file missing or empty`, `bun src/cli.ts federation init`);
  }

  // 2. Federation enabled
  const fedEnabled = process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "true" || config.federation?.enabled === true;
  if (fedEnabled) {
    const source = process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "true" ? "env var" : "config file";
    ok(`Federation enabled (source: ${source})`);
  } else {
    fail(`Federation not enabled`, `bun src/cli.ts federation enable`);
  }

  // 3. Token file
  const tokenExists = await Bun.file(TOKEN_PATH).exists();
  if (tokenExists) {
    ok(`Auth token (${TOKEN_PATH})`);
  } else {
    fail(`Auth token missing`, `bun src/cli.ts rotate-token`);
  }

  // 4. TLS certificate
  const certPath = `${process.env.HOME}/.claude-peers-federation.crt`;
  const certExists = await Bun.file(certPath).exists();
  if (certExists) {
    ok(`TLS certificate (${certPath})`);
  } else {
    fail(`TLS certificate missing`, `bun src/cli.ts federation init`);
  }

  // 5. Broker running
  let brokerOk = false;
  let peerCount = 0;
  try {
    const health = await fetch("http://127.0.0.1:7899/health", { signal: AbortSignal.timeout(2000) });
    if (health.ok) {
      const data = await health.json() as { peers: number };
      peerCount = data.peers;
      ok(`Broker running (${peerCount} local peers)`);
      brokerOk = true;
    } else {
      fail(`Broker returned HTTP ${health.status}`, `bun src/cli.ts kill-broker`);
    }
  } catch {
    fail(`Broker not running`, `Start a Claude Code session or run: bun src/broker.ts`);
  }

  // 6. Federation TLS listening
  if (brokerOk) {
    try {
      const status = await brokerFetch<FederationStatusResponse>("/federation/status");
      if (status.enabled) {
        ok(`Federation TLS listening on port ${status.port}`);

        // 7. Connected remotes
        if (status.remotes.length > 0) {
          for (const r of status.remotes) {
            ok(`Remote: ${r.hostname} (${r.host}:${r.port}) — ${r.peer_count} peer(s)`);
          }
        }

        // Check config remotes vs actual connections
        const connectedKeys = new Set(status.remotes.map((r: { host: string; port: number }) => `${r.host}:${r.port}`));
        for (const saved of config.federation?.remotes ?? []) {
          const key = `${saved.host}:${saved.port}`;
          if (!connectedKeys.has(key)) {
            warn(`Config has remote ${key} but it's not currently connected`, `bun src/cli.ts federation connect ${key}`);
          }
        }
      } else {
        fail(`Federation TLS not listening`, `Restart broker: bun src/cli.ts kill-broker`);
      }
    } catch {
      fail(`Could not query federation status`);
    }
  }

  // 8. LAN IP
  const lanIp = await detectLanIp();
  if (lanIp) {
    ok(`LAN IP detected: ${lanIp}`);
  } else {
    warn(`Could not detect LAN IP`);
  }

  console.log(`\n${passed} passed, ${failed} failed, ${warnings} warning(s)\n`);
  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI entry point (only runs when executed directly, not when imported)
// ---------------------------------------------------------------------------

if (Bun.main === import.meta.path) {
  const cmd = process.argv[2];

  // rotate-token does not need an existing token
  if (cmd !== "rotate-token") {
    try {
      authToken = readTokenSync();
    } catch {
      // Token file missing — allow health-only commands to proceed
      // Authenticated commands will fail at brokerFetch with 401
    }
  }

  switch (cmd) {
    case "status": {
      try {
        const health = await brokerFetch<{ status: string; peers: number }>("/health");
        console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
        console.log(`URL: ${BROKER_URL}`);

        if (health.peers > 0) {
          const peers = await brokerFetch<
            Array<{
              id: string;
              pid: number;
              cwd: string;
              git_root: string | null;
              tty: string | null;
              session_name: string;
              summary: string;
              last_seen: string;
            }>
          >("/list-peers", {
            scope: "machine",
            cwd: "/",
            git_root: null,
          });

          console.log("\nPeers:");
          for (const p of peers) {
            const nameTag = p.session_name ? ` [${p.session_name}]` : "";
            console.log(`  ${p.id}${nameTag}  PID:${p.pid}  ${p.cwd}`);
            if (p.summary) console.log(`         ${p.summary}`);
            if (p.tty) console.log(`         TTY: ${p.tty}`);
            console.log(`         Last seen: ${p.last_seen}`);
          }
        }
      } catch {
        console.log("Broker is not running.");
      }
      break;
    }

    case "peers": {
      try {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            session_name: string;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        if (peers.length === 0) {
          console.log("No peers registered.");
        } else {
          for (const p of peers) {
            const nameTag = p.session_name ? ` [${p.session_name}]` : "";
            const parts = [`${p.id}${nameTag}  PID:${p.pid}  ${p.cwd}`];
            if (p.summary) parts.push(`  Summary: ${p.summary}`);
            console.log(parts.join("\n"));
          }
        }
      } catch {
        console.log("Broker is not running.");
      }
      break;
    }

    case "send": {
      const toId = process.argv[3];
      const msg = process.argv.slice(4).join(" ");
      if (!toId || !msg) {
        console.error("Usage: bun cli.ts send <peer-id> <message>");
        process.exit(1);
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string; message_id?: number }>("/send-message", {
          from_id: "cli",
          to_id: toId,
          text: msg,
        });
        if (result.ok) {
          console.log(`Message sent to ${toId} (msg#${result.message_id}, type: text)`);
        } else {
          console.error(`Failed: ${result.error}`);
        }
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }

    case "broadcast": {
      const scope = process.argv[3] as "machine" | "directory" | "repo";
      const msg = process.argv.slice(4).join(" ");
      if (!scope || !msg || !["machine", "directory", "repo"].includes(scope)) {
        console.error("Usage: bun cli.ts broadcast <machine|directory|repo> <message>");
        process.exit(1);
      }
      const cwd = process.cwd();
      let gitRoot: string | null = null;
      try {
        const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
          cwd,
          stdout: "pipe",
          stderr: "ignore",
        });
        if (proc.exitCode === 0) {
          gitRoot = new TextDecoder().decode(proc.stdout).trim() || null;
        }
      } catch {}
      try {
        const result = await brokerFetch<BroadcastResponse>("/broadcast", {
          from_id: "cli",
          text: msg,
          type: "broadcast",
          scope,
          cwd,
          git_root: gitRoot,
        });
        if (!result.ok) {
          console.error(`Failed: ${result.error}`);
        } else if (result.recipients === 0) {
          console.log(`No peers in scope '${scope}'`);
        } else {
          console.log(`Broadcast sent to ${result.recipients} peer(s)`);
        }
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }

    case "set-name": {
      const peerId = process.argv[3];
      const name = process.argv.slice(4).join(" ");
      if (!peerId || !name) {
        console.error("Usage: bun cli.ts set-name <peer-id> <name>");
        process.exit(1);
      }
      try {
        const result = await brokerFetch<{ ok: boolean }>("/set-name", {
          id: peerId,
          session_name: name,
        });
        if (result.ok) {
          console.log(`Session name set for ${peerId}: "${name}"`);
        } else {
          console.error("Failed to set session name.");
        }
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }

    case "auto-summary": {
      const peerId = process.argv[3];
      if (!peerId) {
        console.error("Usage: bun cli.ts auto-summary <peer-id>");
        process.exit(1);
      }

      const cwd = process.cwd();
      const repoName = getGitRepoName(cwd);
      const branch = getGitBranchName(cwd);
      const taskCount = await getTaskMasterInProgress(cwd);

      const summary = buildSummary({ repoName, branch, cwd, taskCount });

      // Always print the generated summary (useful for debugging even if set fails)
      console.log(summary);

      try {
        const result = await brokerFetch<{ ok: boolean }>("/set-summary", {
          id: peerId,
          summary,
        });
        if (!result.ok) {
          console.error("Error: Broker returned failure for /set-summary.");
          process.exit(1);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("ConnectionRefused") || msg.includes("Unable to connect")) {
          console.error(`Error: Broker not reachable at ${BROKER_URL}. Is it running?`);
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      }
      break;
    }

    case "rotate-token": {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const newToken = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      fs.writeFileSync(TOKEN_PATH, newToken + "\n", { mode: 0o600 });
      console.log(`Token rotated. New token written to ${TOKEN_PATH}. Broker will pick it up within 60 seconds.`);
      break;
    }

    case "restart": {
      console.log("Killing all claude-peers processes (broker + MCP servers)...");

      // Kill broker via port lookup (safe — broker is always on known port)
      try {
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder()
          .decode(proc.stdout)
          .trim()
          .split("\n")
          .filter((p) => p);
        for (const pid of pids) {
          try { process.kill(parseInt(pid), "SIGTERM"); } catch {}
        }
      } catch {}

      // When the broker dies, MCP servers will detect it on next poll
      // and the parent death detection (stdin close) handles the rest.
      // Do NOT use pkill -f "bun.*server.ts" — it matches shell wrapper
      // processes and causes collateral damage.

      console.log("Broker killed. MCP servers will exit when their sessions reconnect.");
      console.log("Run /mcp in each Claude Code session to reconnect.");
      break;
    }

    case "kill-broker": {
      try {
        const health = await brokerFetch<{ status: string; peers: number }>("/health");
        console.log(`Broker has ${health.peers} peer(s). Shutting down...`);
        // Find and kill the broker process on the port
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder()
          .decode(proc.stdout)
          .trim()
          .split("\n")
          .filter((p) => p);
        for (const pid of pids) {
          process.kill(parseInt(pid), "SIGTERM");
        }
        console.log("Broker stopped.");
      } catch {
        console.log("Broker is not running.");
      }
      break;
    }

    case "federation": {
      const subCmd = process.argv[3];

      switch (subCmd) {
        case "connect": {
          const target = process.argv[4];
          if (!target || !target.includes(":")) {
            console.error("Usage: bun cli.ts federation connect <host>:<port>");
            process.exit(1);
          }
          const lastColon = target.lastIndexOf(":");
          const host = target.slice(0, lastColon);
          const port = parseInt(target.slice(lastColon + 1), 10);
          if (isNaN(port) || port <= 0 || port > 65535) {
            console.error(`Invalid port in "${target}". Expected <host>:<port>.`);
            process.exit(1);
          }
          try {
            const result = await brokerFetch<{
              ok: boolean;
              hostname?: string;
              peer_count?: number;
              error?: string;
            }>("/federation/connect", { host, port });
            if (result.ok) {
              const remoteName = result.hostname ?? host;
              const peerCount = result.peer_count ?? 0;
              console.log(
                `Connected to ${host}:${port} (${remoteName}). ${peerCount} remote peer${peerCount === 1 ? "" : "s"} available.`
              );
            } else {
              console.error(`Failed: ${result.error ?? "Unknown error"}`);
              process.exit(1);
            }
          } catch (e) {
            console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
          }
          break;
        }

        case "disconnect": {
          const target = process.argv[4];
          if (!target || !target.includes(":")) {
            console.error("Usage: bun cli.ts federation disconnect <host>:<port>");
            process.exit(1);
          }
          const lastColon = target.lastIndexOf(":");
          const host = target.slice(0, lastColon);
          const port = parseInt(target.slice(lastColon + 1), 10);
          if (isNaN(port) || port <= 0 || port > 65535) {
            console.error(`Invalid port in "${target}". Expected <host>:<port>.`);
            process.exit(1);
          }
          try {
            const result = await brokerFetch<{ ok: boolean; error?: string }>(
              "/federation/disconnect",
              { host, port }
            );
            if (result.ok) {
              console.log(`Disconnected from ${host}:${port}.`);
            } else {
              console.error(`Failed: ${result.error ?? "Unknown error"}`);
              process.exit(1);
            }
          } catch (e) {
            console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
          }
          break;
        }

        case "status": {
          try {
            const status = await brokerFetch<FederationStatusResponse>(
              "/federation/status"
            );
            if (!status.enabled) {
              console.log(
                "Federation is disabled. Set CLAUDE_PEERS_FEDERATION_ENABLED=true to enable."
              );
              break;
            }

            if (status.remotes.length === 0) {
              console.log(
                `Federation enabled on port ${status.port}. No remote machines connected.`
              );
              break;
            }

            console.log(`Federation enabled on port ${status.port} (subnet: ${status.subnet})`);
            console.log(`\nConnected remotes (${status.remotes.length}):`);
            for (const r of status.remotes) {
              const uptime = formatUptime(r.connected_at);
              console.log(
                `  ${r.host}:${r.port}  hostname=${r.hostname}  peers=${r.peer_count}  uptime=${uptime}`
              );
            }
            console.log(`\nTotal remote peers: ${status.total_remote_peers}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (
              msg.includes("fetch") ||
              msg.includes("ECONNREFUSED") ||
              msg.includes("ConnectionRefused") ||
              msg.includes("Unable to connect")
            ) {
              console.log("Broker is not running.");
            } else {
              console.error(`Error: ${msg}`);
            }
          }
          break;
        }

        case "setup":
        case "init": {
          await federationInit();
          break;
        }

        case "token": {
          await federationToken();
          break;
        }

        case "join": {
          const joinUrl = process.argv[4];
          if (!joinUrl) {
            console.error("Usage: bun cli.ts federation join cpt://<host>:<port>/<token>");
            process.exit(1);
          }
          await federationJoin(joinUrl);
          break;
        }

        case "doctor": {
          await federationDoctor();
          break;
        }

        case "refresh-wsl2": {
          await refreshWSL2PortForwarding();
          break;
        }

        case "enable": {
          const existingConfig = loadConfig();
          const port = parseInt(process.argv[4] || "") || existingConfig.federation?.port || 7900;
          const subnet = process.argv[5] || existingConfig.federation?.subnet || "0.0.0.0/0";
          const newConfig = {
            ...existingConfig,
            federation: { enabled: true, port, subnet },
          };
          writeConfig(newConfig);
          console.log(`Federation enabled in config file.`);
          console.log(`  Config: ${CONFIG_PATH}`);
          console.log(`  Port: ${port}`);
          console.log(`  Subnet: ${subnet}`);
          console.log(`\nRestart the broker to apply: bun src/cli.ts kill-broker`);
          break;
        }

        case "disable": {
          const existingConfig = loadConfig();
          const newConfig = {
            ...existingConfig,
            federation: {
              ...existingConfig.federation,
              enabled: false,
            },
          };
          writeConfig(newConfig);
          console.log(`Federation disabled in config file.`);
          console.log(`  Config: ${CONFIG_PATH}`);
          console.log(`\nRestart the broker to apply: bun src/cli.ts kill-broker`);
          break;
        }

        default:
          console.error(`Unknown federation subcommand: ${subCmd ?? "(none)"}`);
          console.error(
            "Usage: bun cli.ts federation <init|join|connect|disconnect|status|doctor|token|enable|disable> [args]"
          );
          process.exit(1);
      }
      break;
    }

    default:
      console.log(`claude-peers CLI

Usage:
  bun cli.ts status                                Show broker status and all peers
  bun cli.ts peers                                 List all peers
  bun cli.ts send <id> <msg>                       Send a message to a peer
  bun cli.ts broadcast <scope> <msg>               Broadcast to all peers in scope (machine/directory/repo)
  bun cli.ts set-name <id> <name>                  Set a peer's session name
  bun cli.ts auto-summary <id>                     Generate and set a deterministic summary
  bun cli.ts rotate-token                          Rotate the auth token
  bun cli.ts restart                               Kill ALL claude-peers processes (broker + servers)
  bun cli.ts kill-broker                           Stop the broker daemon

Federation:
  bun cli.ts federation init                       One-command federation setup (config, certs, firewall)
  bun cli.ts federation join <cpt-url>             Join a federation using a cpt:// URL from another machine
  bun cli.ts federation token                      Generate a cpt:// URL for other machines to join
  bun cli.ts federation doctor                     Diagnose federation health (checks all prerequisites)
  bun cli.ts federation connect <host>:<port>      Connect to a remote broker (persists to config)
  bun cli.ts federation disconnect <host>:<port>   Disconnect from a remote broker (removes from config)
  bun cli.ts federation status                     Show federation status
  bun cli.ts federation refresh-wsl2                Update WSL2 port forwarding if IP changed
  bun cli.ts federation enable [port] [subnet]     Enable federation in config file
  bun cli.ts federation disable                    Disable federation in config file`);
  }
}
