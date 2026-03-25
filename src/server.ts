#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./src/server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  BroadcastResponse,
  Message,
  MessageType,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import { TOKEN_PATH, readTokenSync } from "./shared/token.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// --- Auth token (loaded after broker is up) ---

let authToken: string = "";

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });
  // On 401, re-read token file and retry once (handles token rotation)
  if (res.status === 401) {
    try {
      authToken = readTokenSync();
    } catch {
      const err = await res.text();
      throw new Error(`Broker error (${path}): ${res.status} ${err}`);
    }
    const retryRes = await fetch(`${BROKER_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!retryRes.ok) {
      const err = await retryRes.text();
      throw new Error(`Broker error (${path}): ${retryRes.status} ${err}`);
    }
    return retryRes.json() as Promise<T>;
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

const CPM_LOG_DIR = new URL("../cpm-logs", import.meta.url).pathname;
const MSG_LOG_PATH = `${CPM_LOG_DIR}/messages.log`;
const SERVER_LOG_PATH = `${CPM_LOG_DIR}/server.log`;

// Ensure log directory exists
try { require("fs").mkdirSync(CPM_LOG_DIR, { recursive: true }); } catch {}

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  const line = `[${new Date().toISOString()}] [CPM-server] ${msg}`;
  console.error(`[CPM-server] ${msg}`);
  try { Bun.write(Bun.file(SERVER_LOG_PATH), line + "\n", { append: true }); } catch {}
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id. Check the type attribute for message intent: "query" means they're asking a question, "handoff" means task delegation, "response" means a reply to a previous message, "broadcast" means a group announcement.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo/lan). Use 'lan' scope to find peers on other machines on the local network (requires federation).
- send_message: Send a message to another instance by ID. Supports cross-machine messaging via LAN federation — remote peer IDs contain a colon (e.g., 'hostname:peer_id'). Supports optional type (text/query/response/handoff/broadcast), metadata (JSON object), and reply_to (message ID for threading).
- broadcast_message: Send a message to all peers in a scope (machine/directory/repo). Useful for announcements, help requests, or coordination.
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- set_name: Set your session name (from /rename). Helps peers identify you by name instead of opaque ID.
- check_messages: Manually check for new messages

When you start or after using /rename, call set_name with your session name. This helps other instances identify you by name instead of opaque ID. Also call set_summary with [SESSION_NAME] prefix convention: '[MySession] description of work'.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances. Returns their ID, working directory, git repo, and summary. Use scope 'lan' to discover peers on other machines on the local network (requires federation).",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo", "lan"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories). "lan" = all instances on this machine plus peers on connected LAN machines (requires federation to be enabled).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification. Supports cross-machine messaging: if the peer ID contains a colon (e.g., 'hostname:peer_id'), the message is routed through LAN federation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers). For remote peers on the LAN, use the 'hostname:peer_id' format returned by list_peers with scope 'lan'.",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
        type: {
          type: "string" as const,
          enum: ["text", "query", "response", "handoff", "broadcast"],
          description: 'Message type. Defaults to "text". Use "query" for questions expecting a response, "response" for replies, "handoff" for task delegation.',
        },
        metadata: {
          type: "object" as const,
          description: "Optional structured metadata. For handoff: { task, files?, context? }. For query/response: { topic? }.",
        },
        reply_to: {
          type: "number" as const,
          description: "Message ID to reply to (for threading). The referenced message must exist.",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "set_name",
    description:
      "Set your session name (from /rename). Visible to peers in list_peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "Your Claude Code session name (from /rename)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "broadcast_message",
    description:
      "Send a message to all Claude Code instances in a scope (machine, directory, repo, or lan). Useful for announcements, help requests, or coordination. Use 'lan' to broadcast to peers on other machines via federation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string" as const,
          description: "The message to broadcast",
        },
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo", "lan"],
          description: 'Scope of broadcast. "machine" = all instances. "directory" = same working directory. "repo" = same git repository. "lan" = all instances on this machine plus peers on connected LAN machines (requires federation).',
        },
      },
      required: ["message", "scope"],
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo" | "lan";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.session_name) parts.unshift(`Name: ${p.session_name}`);
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message, type: msgType, metadata, reply_to } = args as {
        to_id: string;
        message: string;
        type?: MessageType;
        metadata?: Record<string, unknown>;
        reply_to?: number;
      };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        // Detect remote peer: colon in to_id indicates "hostname:peer_id" format
        const isRemotePeer = to_id.includes(":");

        let result: { ok: boolean; error?: string; message_id?: number };

        if (isRemotePeer) {
          // Route through federation endpoint for cross-machine delivery
          result = await brokerFetch<{ ok: boolean; error?: string }>("/federation/send-to-remote", {
            to_id,
            from_id: myId,
            text: message,
            type: msgType,
            metadata,
            reply_to,
          });
        } else {
          // Local peer — use normal send-message endpoint
          const sendBody: Record<string, unknown> = {
            from_id: myId,
            to_id,
            text: message,
          };
          if (msgType) sendBody.type = msgType;
          if (metadata) sendBody.metadata = metadata;
          if (reply_to !== undefined) sendBody.reply_to = reply_to;
          result = await brokerFetch<{ ok: boolean; error?: string; message_id?: number }>("/send-message", sendBody);
        }

        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        // Log outbound messages for observability
        const timestamp = new Date().toLocaleTimeString();
        const msgIdTag = result.message_id != null ? `msg#${result.message_id}` : (isRemotePeer ? "remote" : "unknown");
        log(`--- MESSAGE SENT ---\n[${timestamp}] To ${to_id} (${msgIdTag}):\n${message}\n--- END MESSAGE ---`);
        try {
          const logPath = MSG_LOG_PATH;
          const entry = `\n${"=".repeat(60)}\n[${timestamp}] SENT to ${to_id} (${msgIdTag}):\n${message}\n`;
          await Bun.write(Bun.file(logPath), entry, { append: true });
        } catch {
          // Non-critical
        }
        // Build preview: first line or first 120 chars
        const preview = message.split("\n")[0].slice(0, 120) + (message.length > 120 ? "..." : "");
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id} (${msgIdTag})\n> Preview: ${preview}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_name": {
      const { name: sessionName } = args as { name: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-name", { id: myId, session_name: sessionName });
        return {
          content: [{ type: "text" as const, text: `Session name set: "${sessionName}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting name: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map((m) => {
          let prefix = "";
          if (m.type === "query") prefix = "[QUERY] ";
          else if (m.type === "response") prefix = `[RESPONSE]${m.reply_to ? ` re: msg#${m.reply_to}` : ""} `;
          else if (m.type === "handoff") prefix = "[HANDOFF] ";
          else if (m.type === "broadcast") prefix = "[BROADCAST] ";
          // "text" type: no prefix (backward compatible)
          let line = `${prefix}From ${m.from_id} (${m.sent_at}):\n${m.text}`;
          if (m.metadata) {
            line += `\nMetadata: ${JSON.stringify(m.metadata)}`;
          }
          return line;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "broadcast_message": {
      const { message, scope } = args as { message: string; scope: "machine" | "directory" | "repo" | "lan" };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<BroadcastResponse>("/broadcast", {
          from_id: myId,
          text: message,
          type: "broadcast",
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Broadcast failed: ${result.error}` }],
            isError: true,
          };
        }
        if (result.recipients === 0) {
          return {
            content: [{ type: "text" as const, text: `No peers found in scope '${scope}'. Broadcast not sent.` }],
          };
        }
        // Log outbound broadcast
        const timestamp = new Date().toLocaleTimeString();
        log(`--- BROADCAST SENT ---\n[${timestamp}] To ${result.recipients} peer(s) in scope '${scope}':\n${message}\n--- END BROADCAST ---`);
        try {
          const entry = `\n${"=".repeat(60)}\n[${timestamp}] BROADCAST to ${result.recipients} peer(s) in scope '${scope}':\n${message}\n`;
          await Bun.write(Bun.file(MSG_LOG_PATH), entry, { append: true });
        } catch {
          // Non-critical
        }
        return {
          content: [{ type: "text" as const, text: `Broadcast sent to ${result.recipients} peer(s) in scope '${scope}'` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error broadcasting: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    if (result.messages.length === 0) return;

    // Two-phase delivery: push notifications first, then ack to broker
    const ackedIds: number[] = [];

    for (const msg of result.messages) {
      // Look up the sender's info for context
      let fromSummary = "";
      let fromCwd = "";
      let fromName = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
          fromName = sender.session_name ?? "";
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      // Push as channel notification — this is what makes it immediate.
      // IMPORTANT: Claude Code silently drops notifications with null meta values.
      // Use conditional spread to OMIT optional fields rather than passing null.
      // Also message_id is required for Claude Code to render the notification.
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_name: fromName,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            type: msg.type || "text",
            message_id: String(msg.id),
            ...(msg.sent_at ? { sent_at: msg.sent_at } : {}),
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
            ...(msg.reply_to ? { reply_to: String(msg.reply_to) } : {}),
          },
        },
      });

      // Notification succeeded — mark for ack
      ackedIds.push(msg.id);

      // Full message log for observability (stderr + file)
      const senderLabel = fromName || msg.from_id;
      const timestamp = new Date().toLocaleTimeString();
      const typeTag = msg.type && msg.type !== "text" ? `[${msg.type.toUpperCase()}] ` : "";
      // Build bullet summary: first 3 lines, truncated
      const lines = msg.text.split("\n").filter((l: string) => l.trim());
      const bullets = lines.slice(0, 3).map((l: string) => `  • ${l.slice(0, 100)}${l.length > 100 ? "..." : ""}`).join("\n");
      const summaryLine = lines.length > 3 ? `\n  (${lines.length - 3} more lines)` : "";
      const logEntry = `[${timestamp}] ${typeTag}From ${senderLabel} (${msg.from_id}):\n${bullets}${summaryLine}\n\nFull message:\n${msg.text}`;
      log(`--- MESSAGE RECEIVED ---\n[${timestamp}] ${typeTag}From ${senderLabel} (${msg.from_id}):\n${bullets}${summaryLine}\n--- END MESSAGE ---`);

      // Append to persistent message log for tail -f monitoring
      try {
        const logPath = `${process.env.HOME}/.claude-peers-messages.log`;
        const entry = `\n${"=".repeat(60)}\n${logEntry}\n`;
        await Bun.write(Bun.file(logPath), entry, { append: true });
      } catch {
        // Non-critical — file logging is best-effort
      }
    }

    // Phase 2: Ack delivered messages — only after successful notification push
    if (ackedIds.length > 0) {
      try {
        await brokerFetch("/ack-messages", { id: myId, message_ids: ackedIds });
      } catch (e) {
        // Ack failed — messages stay undelivered, will retry on next poll (at-least-once)
        log(`Ack failed, will retry next poll: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    // Broker might be down temporarily, don't crash
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Stale process detection ---

/**
 * Kill stale MCP server processes that are running from a different path.
 * This handles the case where the MCP config path changed (e.g., repo restructure)
 * but old processes are still alive from the old path.
 */
async function killStaleMcpServers(): Promise<void> {
  const myPid = process.pid;
  // Resolve our own server.ts path for comparison
  const myServerPath = new URL(import.meta.url).pathname;

  try {
    // Find all bun processes running server.ts
    const proc = Bun.spawn(["pgrep", "-f", "bun.*server\\.ts"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const pids = output
      .trim()
      .split("\n")
      .filter((p) => p.length > 0)
      .map(Number)
      .filter((p) => !isNaN(p));

    for (const pid of pids) {
      if (pid === myPid) continue; // Don't kill ourselves

      try {
        // Read the process's command line to check its path
        const cmdline = await Bun.file(`/proc/${pid}/cmdline`).text();
        // cmdline is null-separated
        const args = cmdline.split("\0");

        // Check if this process is running a DIFFERENT server.ts path.
        // Use path.resolve() to normalize relative paths (e.g., "./src/server.ts")
        // before comparison. Without this, relative vs absolute paths cause
        // a murder-suicide loop where sessions kill each other on startup.
        const serverArg = args.find((a) => a.includes("server.ts"));
        if (serverArg) {
          const resolvedArg = require("node:path").resolve(serverArg);
          const resolvedMy = require("node:path").resolve(myServerPath);
          if (resolvedArg !== resolvedMy) {
            log(`Killing stale MCP server PID ${pid} (running from old path: ${serverArg})`);
            process.kill(pid, "SIGTERM");
          }
        }
      } catch {
        // Process may have already exited, ignore
      }
    }
  } catch {
    // pgrep not available or failed, non-fatal
  }
}

// --- Startup ---

async function main() {
  // 0. Kill stale MCP servers from old paths before anything else
  await killStaleMcpServers();

  // 1. Ensure broker is running
  await ensureBroker();

  // 1b. Read auth token (broker creates the file on startup)
  try {
    authToken = readTokenSync();
    log(`Auth token loaded from ${TOKEN_PATH}`);
  } catch (e) {
    log(`Fatal: Token file not found at ${TOKEN_PATH}. Is the broker running?`);
    process.exit(1);
  }

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Parent death detection — exit when the Claude session that spawned us dies.
  // MCP servers communicate over stdio. When the parent closes stdin, we must exit.
  // Without this, the MCP server becomes a zombie that keeps polling and consuming
  // messages meant for the replacement session. This is the #1 cause of "messages
  // not delivered" bugs.
  process.stdin.on("end", () => {
    log("stdin closed (parent session died) — exiting");
    cleanup();
  });
  process.stdin.on("error", () => {
    log("stdin error (parent session died) — exiting");
    cleanup();
  });
  // Also check parent PID periodically — belt and suspenders
  const ppid = process.ppid;
  const parentCheckTimer = setInterval(() => {
    try {
      process.kill(ppid, 0); // Check if parent is alive (signal 0 = no-op)
    } catch {
      log(`Parent PID ${ppid} is dead — exiting`);
      cleanup();
    }
  }, 5000);

  // 9. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearInterval(parentCheckTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
