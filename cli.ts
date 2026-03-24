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
 *   bun cli.ts set-name <id> <name>      — Set a peer's session name
 *   bun cli.ts auto-summary <id>         — Generate and set a deterministic summary
 *   bun cli.ts rotate-token               — Rotate the auth token
 *   bun cli.ts kill-broker               — Stop the broker daemon
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { TOKEN_PATH, readTokenSync } from "./shared/token.ts";

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
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: "cli",
          to_id: toId,
          text: msg,
        });
        if (result.ok) {
          console.log(`Message sent to ${toId}`);
        } else {
          console.error(`Failed: ${result.error}`);
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

    default:
      console.log(`claude-peers CLI

Usage:
  bun cli.ts status                    Show broker status and all peers
  bun cli.ts peers                     List all peers
  bun cli.ts send <id> <msg>           Send a message to a peer
  bun cli.ts set-name <id> <name>      Set a peer's session name
  bun cli.ts auto-summary <id>         Generate and set a deterministic summary
  bun cli.ts rotate-token              Rotate the auth token
  bun cli.ts kill-broker               Stop the broker daemon`);
  }
}
