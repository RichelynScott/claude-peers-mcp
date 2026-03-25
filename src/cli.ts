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
  const fedEnabled = process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "true";
  if (fedEnabled) {
    console.log("  2. ✓ Federation enabled (CLAUDE_PEERS_FEDERATION_ENABLED=true)");
  } else {
    console.log("  2. ✗ Federation not enabled");
    console.log("     Set CLAUDE_PEERS_FEDERATION_ENABLED=true in your environment");
    console.log("     (e.g., add to ~/.zshrc and restart the broker)");
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
  console.log(`\nOr manually: the token is a single line in ~/.claude-peers-token\n`);
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

        case "setup": {
          await federationSetup();
          break;
        }

        default:
          console.error(`Unknown federation subcommand: ${subCmd ?? "(none)"}`);
          console.error(
            "Usage: bun cli.ts federation <connect|disconnect|setup|status> [args]"
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
  bun cli.ts federation connect <host>:<port>      Connect to a remote broker
  bun cli.ts federation disconnect <host>:<port>   Disconnect from a remote broker
  bun cli.ts federation status                     Show federation status
  bun cli.ts federation setup                      Guided federation setup (WSL2/macOS port forwarding)`);
  }
}
