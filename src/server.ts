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
import { loadConfig } from "./shared/config.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// US-003: Configurable startup timeout (env var > config file > default 15s)
const MIN_STARTUP_TIMEOUT_MS = 3_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const REGISTER_MAX_RETRIES = 3;
const REGISTER_PER_ATTEMPT_TIMEOUT_MS = 5_000;

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

function resolveStartupTimeout(): number {
  const config = loadConfig();
  const envVal = parseInt(process.env.CLAUDE_PEERS_STARTUP_TIMEOUT_MS ?? "", 10);
  const configVal = config.server?.startup_timeout_ms;
  let timeout = envVal > 0 ? envVal : (configVal ?? DEFAULT_STARTUP_TIMEOUT_MS);
  if (timeout < MIN_STARTUP_TIMEOUT_MS) {
    log(`WARNING: Startup timeout ${timeout}ms is below minimum, clamping to ${MIN_STARTUP_TIMEOUT_MS}ms`);
    timeout = MIN_STARTUP_TIMEOUT_MS;
  }
  return timeout;
}

async function ensureBroker(timeoutMs: number): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");

  // Read persistent config so the spawned broker inherits federation settings
  // even when the MCP server's shell doesn't have the env vars set
  const config = loadConfig();
  const brokerEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  if (config.federation?.enabled && !brokerEnv.CLAUDE_PEERS_FEDERATION_ENABLED) {
    brokerEnv.CLAUDE_PEERS_FEDERATION_ENABLED = "true";
  }
  if (config.federation?.port && !brokerEnv.CLAUDE_PEERS_FEDERATION_PORT) {
    brokerEnv.CLAUDE_PEERS_FEDERATION_PORT = String(config.federation.port);
  }
  if (config.federation?.subnet && !brokerEnv.CLAUDE_PEERS_FEDERATION_SUBNET) {
    brokerEnv.CLAUDE_PEERS_FEDERATION_SUBNET = config.federation.subnet;
  }

  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    env: brokerEnv,
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // US-003: Use configurable timeout for broker spawn wait
  const iterations = Math.ceil(timeoutMs / 200);
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error(`Failed to start broker daemon after ${timeoutMs}ms. Check if port ${BROKER_PORT} is in use: lsof -i :${BROKER_PORT}`);
}

// --- Utility ---

const CPM_LOG_DIR = new URL("../cpm-logs", import.meta.url).pathname;
const MSG_LOG_PATH = `${CPM_LOG_DIR}/messages.log`;
const SERVER_LOG_PATH = `${CPM_LOG_DIR}/server.log`;

// Ensure log directory exists
try { require("fs").mkdirSync(CPM_LOG_DIR, { recursive: true }); } catch {}

function formatAge(isoTimestamp: string): string {
  const diffMs = Math.max(0, Date.now() - new Date(isoTimestamp).getTime());
  const totalMin = Math.floor(diffMs / 60_000);
  if (totalMin < 1) return "<1m";
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

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
let mySessionName: string = "";
let channelPushVerified = false;

// --- Simple message dedup ---
// Push once, ack immediately, never push same message twice.
// check_messages is the reliable fallback if channel push drops the notification.
const pushedMessageIds = new Set<number>();
const MAX_PUSHED_IDS = 1000;

// --- Queued messages for piggyback delivery ---
// When channel push is unreliable, messages are queued here and surfaced
// on the next tool call as a banner prepended to the tool response.
interface QueuedMessage {
  from_id: string;
  from_name: string;
  text: string;
  type: string;
  message_id: number;
  sent_at: string;
  pushedAt: number; // Date.now() when notification was sent
}
const queuedMessages: QueuedMessage[] = [];
const MAX_QUEUED = 50;
const PIGGYBACK_GRACE_MS = 5_000; // wait 5s before surfacing via piggyback (give notification time)

function rememberPushedId(id: number) {
  pushedMessageIds.add(id);
  if (pushedMessageIds.size > MAX_PUSHED_IDS) {
    const toKeep = [...pushedMessageIds].slice(-MAX_PUSHED_IDS / 2);
    pushedMessageIds.clear();
    for (const keptId of toKeep) pushedMessageIds.add(keptId);
  }
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.5.1" },
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
- check_messages: Check for messages. Channel push notifications are unreliable — call this when you are waiting for a reply that hasn't appeared, or periodically every few minutes.

When you start or after using /rename, call set_name with your session name. This helps other instances identify you by name instead of opaque ID.

IMPORTANT — KEEP YOUR SUMMARY CURRENT: Call set_summary whenever your work focus changes — starting a new task, switching files, beginning a review, etc. Use the convention '[SessionName] specific task description' (e.g., '[AUTH_WORKER] implementing JWT refresh logic in auth.ts'). Multiple sessions in the same directory rely on summaries to tell each other apart. Generic summaries like 'Working in project' are unhelpful — be specific about WHAT you are doing, not just WHERE.

IMPORTANT: Channel push notifications may not always appear. If you are waiting for a reply and it hasn't arrived, call check_messages to retrieve it. Messages sent to you are reliably stored — they just may not trigger a visible notification every time.`,
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
      "Poll the broker for stored messages and acknowledge them once read. Use this if channel notifications are not appearing.",
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
  {
    name: "message_status",
    description:
      "Check the delivery status of a previously sent message by its message ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "number" as const,
          description: "The message ID returned when the message was sent.",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "channel_health",
    description:
      "Diagnose broker status, pending messages, and local dedup state.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  // Channel push verification: any tool call proves the model is active
  if (!channelPushVerified) {
    channelPushVerified = true;
    log("Channel push verified: tool call received — marking as working");
    brokerFetch("/set-channel-push", { id: myId, status: "working" }).catch(() => {});
  }

  // --- Piggyback delivery: surface queued messages on tool calls ---
  // Messages are queued after every channel push. After a 5s grace period
  // (giving the notification time to render), unsurfaced messages are
  // prepended as a banner on the next tool call. This is the reliable
  // second delivery layer when channel push silently drops notifications.
  function wrapResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
    const now = Date.now();
    // Only surface messages past the grace period (notification had time to display)
    const ready = queuedMessages.filter(m => now - m.pushedAt >= PIGGYBACK_GRACE_MS);
    if (ready.length > 0) {
      // Remove surfaced messages from queue
      for (const m of ready) {
        const idx = queuedMessages.indexOf(m);
        if (idx !== -1) queuedMessages.splice(idx, 1);
      }
      const lines = ready.map((m) => {
        const label = m.from_name || m.from_id;
        const typeTag = m.type && m.type !== "text" ? `[${m.type.toUpperCase()}] ` : "";
        return `${typeTag}From ${label} (msg#${m.message_id}): ${m.text.slice(0, 200)}${m.text.length > 200 ? "..." : ""}`;
      });
      const banner = `--- QUEUED PEER MESSAGES (${ready.length}) ---\n${lines.join("\n---\n")}\n--- END QUEUED MESSAGES ---`;
      log(`Piggybacked ${ready.length} queued message(s) onto ${name} tool call`);
      if (result.content.length > 0 && result.content[0].type === "text") {
        result.content[0].text = banner + "\n\n" + result.content[0].text;
      }
    }
    return result;
  }

  const toolResult = await (async () => { switch (name) {
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
          // Name is the header — most prominent element
          const header = p.session_name
            ? `**${p.session_name}** (${p.id})`
            : `${p.id} (unnamed)`;
          // Registration age for disambiguation
          const age = p.registered_at ? formatAge(p.registered_at) : "";
          const ageTag = age ? `  Active: ${age}` : "";
          const details = [
            `  PID: ${p.pid}  |  CWD: ${p.cwd}${ageTag}`,
          ];
          if (p.git_root) details.push(`  Repo: ${p.git_root}`);
          if (p.tty) details.push(`  TTY: ${p.tty}`);
          if (p.summary) details.push(`  Summary: ${p.summary}`);
          if (p.channel_push && p.channel_push !== "working") details.push(`  Channel push: ${p.channel_push}`);
          details.push(`  Last seen: ${p.last_seen}`);
          return `${header}\n${details.join("\n")}`;
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
      if (!to_id || !message) {
        return {
          content: [{ type: "text" as const, text: "Missing required parameter: to_id and message are required" }],
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
        mySessionName = sessionName;
        // Immediately regenerate summary with the new session name
        try {
          const branch = await getGitBranch(myCwd);
          const recentFiles = await getRecentFiles(myCwd);
          const ttyVal = getTty();
          const updatedSummary = await generateSummary({
            cwd: myCwd, git_root: myGitRoot, git_branch: branch,
            recent_files: recentFiles, session_name: sessionName, tty: ttyVal,
          });
          if (updatedSummary) {
            await brokerFetch("/set-summary", { id: myId, summary: updatedSummary });
          }
        } catch { /* Non-critical */ }
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
        // Poll broker for undelivered messages and ack them
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        // Ack all — the model is explicitly reading them
        const allIds = result.messages.map(m => m.id);
        try {
          await brokerFetch("/ack-messages", { id: myId, message_ids: allIds });
        } catch {}
        // Add to dedup set (with cap)
        for (const id of allIds) rememberPushedId(id);

        const allMessages = result.messages;

        const lines = allMessages.map((m) => {
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
              text: `${allMessages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
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
      if (!message || !scope) {
        return {
          content: [{ type: "text" as const, text: "Missing required parameter: message and scope are required" }],
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

    case "message_status": {
      const { message_id } = args as { message_id: number };
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const status = await brokerFetch<{ id: number; from_id: string; to_id: string; delivered: boolean; sent_at: string; error?: string }>("/message-status", { message_id });
        if (status.error) {
          return { content: [{ type: "text" as const, text: `Message #${message_id}: ${status.error}` }] };
        }
        const state = status.delivered ? "confirmed" : "unconfirmed";
        return {
          content: [{ type: "text" as const, text: `Message #${status.id}: ${state}\n  From: ${status.from_id}\n  To: ${status.to_id}\n  Sent: ${status.sent_at}\n  Delivered: ${status.delivered}` }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error checking status: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "channel_health": {
      const report: string[] = ["Channel Health Report", "=".repeat(21), ""];

      // Broker health
      try {
        const health = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
        if (health.ok) {
          const data = await health.json() as { status: string; peers: number; uptime_ms?: number; requests_last_minute?: number; pending_messages?: number };
          report.push(`Broker: ${data.status} (${data.peers} peers)`);
          if (data.uptime_ms) report.push(`  Uptime: ${Math.round(data.uptime_ms / 1000)}s`);
          if (data.requests_last_minute != null) report.push(`  Requests/min: ${data.requests_last_minute}`);
          if (data.pending_messages != null) report.push(`  Pending in broker: ${data.pending_messages}`);
        } else {
          report.push(`Broker: error (HTTP ${health.status})`);
        }
      } catch {
        report.push("Broker: unreachable");
      }

      // Channel push state
      report.push("");
      report.push(`Pushed message IDs tracked (dedup): ${pushedMessageIds.size}`);
      report.push(`Piggyback queue: ${queuedMessages.length} message(s) awaiting tool call delivery`);
      if (queuedMessages.length > 0) {
        const oldest = Math.min(...queuedMessages.map(m => m.pushedAt));
        report.push(`  Oldest queued: ${Math.round((Date.now() - oldest) / 1000)}s ago`);
      }

      return {
        content: [{ type: "text" as const, text: report.join("\n") }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  })();
  return wrapResult(toolResult as { content: Array<{ type: string; text: string }>; isError?: boolean });
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    const ackedIds: number[] = [];

    // Fetch peer list once per poll cycle (not per message) for sender context
    let peersById = new Map<string, Peer>();
    if (result.messages.length > 0) {
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "lan",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        peersById = new Map(peers.map(p => [p.id, p]));
      } catch {}
    }

    for (const msg of result.messages) {
      // Skip messages already pushed (permanent dedup — never push same message twice)
      if (pushedMessageIds.has(msg.id)) continue;

      // Look up sender from cached peer list
      const sender = peersById.get(msg.from_id);
      const fromName = sender?.session_name ?? "";
      const fromSummary = sender?.summary ?? "";
      const fromCwd = sender?.cwd ?? "";

      // Push as channel notification — this is what makes it immediate.
      // IMPORTANT: Claude Code silently drops notifications with null meta values.
      // Use conditional spread to OMIT optional fields rather than passing null.
      // Also message_id is required for Claude Code to render the notification.
      try {
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
      } catch (e) {
        // Channel push failed (transport disconnected, etc.)
        // Message stays unacked in broker — will be re-polled next cycle
        log(`Channel push failed for msg#${msg.id}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      // Mark as pushed (dedup) and queue for immediate ack
      rememberPushedId(msg.id);
      ackedIds.push(msg.id);

      // Also queue for piggyback delivery — channel push may silently fail.
      // The queue drains on the next tool call after a 5s grace period.
      // If channel push worked, the model already saw it via notification.
      // If it failed, piggyback is the reliable backup delivery.
      if (queuedMessages.length < MAX_QUEUED) {
        queuedMessages.push({
          from_id: msg.from_id,
          from_name: fromName,
          text: msg.text,
          type: msg.type || "text",
          message_id: msg.id,
          sent_at: msg.sent_at,
          pushedAt: Date.now(),
        });
      }

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

    // Ack all successfully pushed messages
    if (ackedIds.length > 0) {
      try {
        await brokerFetch("/ack-messages", { id: myId, message_ids: ackedIds });
      } catch (e) {
        log(`Ack failed, will retry next poll: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    // Broker might be down temporarily, don't crash
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Stale process cleanup ---
// Stale MCP servers are handled by two mechanisms:
// 1. Parent death detection: stdin close + PPID check (see main() setup)
//    → When a Claude session exits, its MCP server detects stdin close and exits
// 2. TTY-based broker eviction: handleRegister in broker.ts
//    → When a new MCP server registers on the same TTY, the old peer is evicted
//
// The previous pgrep-based approach was removed because it caused a
// murder-suicide loop: pgrep -f matched shell wrapper processes (not just bun),
// and /proc/pid/cmdline contained the entire eval'd shell script, causing
// path comparisons to fail and sessions to kill each other on startup.

// --- Startup ---

async function main() {
  const startupStart = Date.now();
  const startupTimeout = resolveStartupTimeout();
  log(`Startup timeout: ${startupTimeout}ms`);

  // US-005: Phase timings
  const timing: Record<string, number> = {};

  // 1. Ensure broker is running
  let t0 = Date.now();
  await ensureBroker(startupTimeout);
  timing.broker = Date.now() - t0;

  // 1b. Read auth token (broker creates the file on startup)
  t0 = Date.now();
  try {
    authToken = readTokenSync();
    log(`Auth token loaded from ${TOKEN_PATH}`);
  } catch (e) {
    log(`Fatal: Token file not found at ${TOKEN_PATH}. Is the broker running?`);
    process.exit(1);
  }
  timing.token = Date.now() - t0;

  // 2. Gather context
  t0 = Date.now();
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();
  timing.context = Date.now() - t0;

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via git-based auto-summary (non-blocking, best-effort)
  t0 = Date.now();
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
        session_name: mySessionName || null,
        tty,
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
  timing.summary = Date.now() - t0;

  // 4. Register with broker (US-001: retry with exponential backoff)
  t0 = Date.now();
  const registerBody = {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    session_name: mySessionName || undefined,
  };

  let reg: RegisterResponse | null = null;
  const retryDelays = [0, 1000, 3000]; // attempt 1 immediate, attempt 2 after 1s, attempt 3 after 3s

  for (let attempt = 1; attempt <= REGISTER_MAX_RETRIES; attempt++) {
    const delay = retryDelays[attempt - 1] ?? 0;
    if (delay > 0) {
      log(`Register attempt ${attempt - 1}/${REGISTER_MAX_RETRIES} failed, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const res = await fetch(`${BROKER_URL}/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`,
        },
        body: JSON.stringify(registerBody),
        signal: AbortSignal.timeout(REGISTER_PER_ATTEMPT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err}`);
      }
      reg = await res.json() as RegisterResponse;
      if (attempt > 1) {
        log(`Registered as peer ${reg.id} (attempt ${attempt}/${REGISTER_MAX_RETRIES})`);
      } else {
        log(`Registered as peer ${reg.id}`);
      }
      break;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (attempt === REGISTER_MAX_RETRIES) {
        // US-004: Graceful error with diagnostics
        let diagnostics = `Broker URL: ${BROKER_URL}`;
        try {
          const healthRes = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(1000) });
          if (healthRes.ok) {
            const health = await healthRes.json() as { status: string; peers: number };
            diagnostics += `\nBroker reachable: yes (${health.peers} active peers)`;
            diagnostics += `\nSuggestion: The broker may be overloaded with ${health.peers} active peers. Try again or run \`bun src/cli.ts kill-broker\` to restart it.`;
          } else {
            diagnostics += `\nBroker reachable: yes, but returned HTTP ${healthRes.status}`;
          }
        } catch {
          diagnostics += `\nBroker reachable: no`;
          diagnostics += `\nSuggestion: Check if the broker is running: \`lsof -i :${BROKER_PORT}\``;
        }
        const timingStr = Object.entries(timing).map(([k, v]) => `${k}=${v}ms`).join(", ");
        log(`Fatal: All ${REGISTER_MAX_RETRIES} registration attempts failed.\nLast error: ${errMsg}\n${diagnostics}\nStartup timing so far: ${timingStr}`);
        process.exit(1);
      }
    }
  }

  timing.register = Date.now() - t0;
  myId = reg!.id;

  // Restore session name from broker (persists across /mcp reconnects)
  if (reg!.session_name && !mySessionName) {
    mySessionName = reg!.session_name;
    log(`Session name restored from broker: "${mySessionName}"`);
    // Regenerate auto-summary with [SessionName] prefix
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const updatedSummary = await generateSummary({
        cwd: myCwd, git_root: myGitRoot, git_branch: branch,
        recent_files: recentFiles, session_name: mySessionName, tty,
      });
      if (updatedSummary) {
        await brokerFetch("/set-summary", { id: myId, summary: updatedSummary });
        log(`Summary regenerated with restored name: ${updatedSummary}`);
      }
    } catch { /* Non-critical */ }
  }

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

  // Ensure a summary is always set — even for brand-new sessions with no work yet.
  // This guarantees the session name appears in list_peers immediately.
  if (myId && !initialSummary && mySessionName) {
    const dir = myGitRoot || myCwd;
    const projectName = dir.split("/").pop() || dir;
    const fallback = `[${mySessionName}] Awaiting tasks in ${projectName}`;
    try {
      await brokerFetch("/set-summary", { id: myId, summary: fallback });
      log(`Fallback summary set: ${fallback}`);
    } catch { /* Non-critical */ }
  }

  // 5. Connect MCP over stdio
  t0 = Date.now();
  await mcp.connect(new StdioServerTransport());
  timing.mcp = Date.now() - t0;
  log("MCP connected");

  // US-005: Log startup timing summary
  timing.total = Date.now() - startupStart;
  const timingStr = Object.entries(timing).map(([k, v]) => `${k}=${v}ms`).join(", ");
  log(`Startup complete: ${timingStr}`);

  // 6. Channel push verification — test if notifications reach Claude Code
  // Push a hello notification, then wait 10s. If any tool call arrives
  // (proving the model is active and processing), mark channel_push as "working".
  // Otherwise mark as "unverified" so senders see the warning.
  channelPushVerified = false;

  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: "claude-peers MCP server connected. Channel push active.",
        meta: {
          from_id: "system",
          from_name: "claude-peers",
          from_summary: "",
          from_cwd: "",
          type: "text",
          message_id: "startup-hello",
        },
      },
    });
    log("Channel push hello sent — waiting 10s for verification");
  } catch (e) {
    log(`Channel push hello failed: ${e instanceof Error ? e.message : String(e)}`);
    // Mark as unverified immediately (timer may also fire — idempotent, acceptable)
    try { await brokerFetch("/set-channel-push", { id: myId, status: "unverified" }); } catch {}
  }

  // Set a timer: if no tool call within 10s, mark as unverified
  const verificationTimer = setTimeout(async () => {
    if (!channelPushVerified) {
      log("Channel push verification: no tool call within 10s — marking as unverified");
      try { await brokerFetch("/set-channel-push", { id: myId, status: "unverified" }); } catch {}
    }
  }, 10_000);

  // 7. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7b. Periodic queue cleanup — evict stale queued messages older than 2 min
  // (if no tool call happened in 2 min, the messages would never be surfaced)
  const queueCleanupTimer = setInterval(() => {
    const now = Date.now();
    const staleThreshold = 120_000; // 2 minutes
    let cleaned = 0;
    for (let i = queuedMessages.length - 1; i >= 0; i--) {
      if (now - queuedMessages[i].pushedAt > staleThreshold) {
        queuedMessages.splice(i, 1);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log(`Queue cleanup: evicted ${cleaned} stale queued message(s) older than 2min`);
    }
  }, 30_000);

  // 7c. Safety-net polling — catch messages that channel push missed
  // Even when channel push is "working", periodically check for undelivered
  // messages in the broker that weren't picked up by the main poll loop.
  // This catches edge cases where poll+push succeeded but the message was
  // somehow not rendered by Claude Code.
  const SAFETY_NET_INTERVAL_MS = 30_000;
  const safetyNetTimer = setInterval(async () => {
    if (!myId) return;
    try {
      const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
      if (result.messages.length === 0) return;

      let newQueued = 0;
      for (const msg of result.messages) {
        // Skip already-pushed messages (dedup)
        if (pushedMessageIds.has(msg.id)) continue;
        rememberPushedId(msg.id);

        // Queue for piggyback delivery instead of trying channel push again
        if (queuedMessages.length < MAX_QUEUED) {
          queuedMessages.push({
            from_id: msg.from_id,
            from_name: "",  // No peer lookup for safety net — keep it lightweight
            text: msg.text,
            type: msg.type || "text",
            message_id: msg.id,
            sent_at: msg.sent_at,
            pushedAt: Date.now(),
          });
          newQueued++;
        }
      }

      // Ack all messages we just queued
      const allIds = result.messages.filter(m => !pushedMessageIds.has(m.id) || newQueued > 0).map(m => m.id);
      if (allIds.length > 0) {
        try { await brokerFetch("/ack-messages", { id: myId, message_ids: allIds }); } catch {}
      }

      if (newQueued > 0) {
        log(`Safety net: queued ${newQueued} missed message(s) for piggyback delivery`);
      }
    } catch {
      // Non-critical — broker may be temporarily unavailable
    }
  }, SAFETY_NET_INTERVAL_MS);

  // 8. Start heartbeat
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
  // DO NOT use process.stdin.on("end") — the MCP SDK's StdioServerTransport owns
  // stdin, and attaching listeners causes premature exit on startup.
  // Instead, periodically check if the parent PID is still alive.
  let parentCheckTimer: ReturnType<typeof setInterval> | undefined;
  const ppid = process.ppid;
  if (ppid && ppid > 1) {
    parentCheckTimer = setInterval(() => {
      try {
        process.kill(ppid, 0); // signal 0 = check if alive, don't actually send signal
      } catch {
        log(`Parent PID ${ppid} is dead — exiting`);
        cleanup();
      }
    }, 5000);
    parentCheckTimer.unref(); // Don't prevent process exit
  }

  // 9. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearInterval(safetyNetTimer);
    clearTimeout(verificationTimer);
    if (parentCheckTimer) clearInterval(parentCheckTimer);
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
  const msg = e instanceof Error ? e.message : String(e);
  log(`Fatal startup error: ${msg}`);
  process.exit(1);
});
