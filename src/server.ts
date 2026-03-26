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
let channelPushVerified = false;

// --- Deferred ack: pending confirmation buffer (US-001) ---
// Messages pushed via channel notification but not yet confirmed as received by Claude Code.
// Only acked to broker when confirmation evidence arrives:
//   1. Claude calls check_messages (explicit read)
//   2. Claude calls send_message with reply_to referencing a pending msg
//   3. Optimistic timeout (120s) expires without transport error

interface PendingMessage {
  msg: Message;
  pushedAt: number;
}

const pendingMessages = new Map<number, PendingMessage>();
const MAX_PENDING = 100;
const OPTIMISTIC_CONFIRM_MS = 120_000; // 120s — must be longer than DELIVERY_CHECK_DELAY_MS (30s) to avoid race

async function confirmMessages(messageIds: number[], reason: string) {
  if (messageIds.length === 0 || !myId) return;
  log(`Confirming ${messageIds.length} message(s) (reason: ${reason}): [${messageIds.join(", ")}]`);
  try {
    await brokerFetch("/ack-messages", { id: myId, message_ids: messageIds });
    for (const id of messageIds) {
      pendingMessages.delete(id);
    }
  } catch (e) {
    log(`Confirm-ack failed (reason: ${reason}), will retry: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function processOptimisticConfirmations() {
  const now = Date.now();
  const toConfirm: number[] = [];
  for (const [id, pending] of pendingMessages) {
    if (now - pending.pushedAt >= OPTIMISTIC_CONFIRM_MS) {
      toConfirm.push(id);
    }
  }
  if (toConfirm.length > 0) {
    await confirmMessages(toConfirm, "optimistic-timeout");
  }
}

// --- Task A: Sent message tracking for delivery confirmation ---

interface SentMessage {
  messageId: number;
  toId: string;
  sentAt: number;
  warned: boolean;
}

const sentMessages = new Map<number, SentMessage>();
const MAX_SENT = 200;
const DELIVERY_CHECK_DELAY_MS = 30_000; // Sender checks after 30s — must be shorter than OPTIMISTIC_CONFIRM_MS
const SENT_MESSAGE_TTL_MS = 300_000; // Clean up after 5 min
const deliveryWarnings: string[] = []; // Warnings to inject into next tool response (max 20)
const MAX_DELIVERY_WARNINGS = 20;

async function checkSentMessageDelivery() {
  const now = Date.now();
  const toCheck: SentMessage[] = [];

  for (const [id, sent] of sentMessages) {
    // Clean up old entries
    if (now - sent.sentAt > SENT_MESSAGE_TTL_MS) {
      sentMessages.delete(id);
      continue;
    }
    // Check unwarned messages older than 30s, and recheck warned ones every 60s for late delivery
    if (now - sent.sentAt > DELIVERY_CHECK_DELAY_MS) {
      if (!sent.warned) {
        toCheck.push(sent);
      } else if (now - sent.sentAt > DELIVERY_CHECK_DELAY_MS * 2) {
        // Recheck warned messages — if delivered late, clean up
        toCheck.push(sent);
      }
    }
  }

  for (const sent of toCheck) {
    try {
      const status = await brokerFetch<{ delivered: boolean; error?: string }>("/message-status", { message_id: sent.messageId });
      if (!status.delivered) {
        sent.warned = true;
        const warning = `⚠ Message #${sent.messageId} to ${sent.toId} may not have been delivered (sent ${Math.round((now - sent.sentAt) / 1000)}s ago, still unconfirmed)`;
        log(warning);
        if (deliveryWarnings.length < MAX_DELIVERY_WARNINGS) deliveryWarnings.push(warning);
        // Push a self-notification so the sender is interrupted immediately
        try {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: warning,
              meta: {
                from_id: "system",
                from_name: "claude-peers",
                from_summary: "",
                from_cwd: "",
                type: "text",
                message_id: `delivery-warning-${sent.messageId}`,
              },
            },
          });
        } catch {
          // Channel push may not be available — warning stays in deliveryWarnings for next tool response
        }
        // Task B: Auto bug report
        writeBugReport(sent, "unconfirmed_delivery");
      } else {
        // Confirmed — clean up
        sentMessages.delete(sent.messageId);
      }
    } catch {
      // Broker unreachable — skip this check
    }
  }
}

// --- Task B: Auto bug reports on delivery failure ---

const BUG_REPORT_DIR = new URL("../BUG_REPORTS", import.meta.url).pathname;
const FAILURE_LOG_PATH = `${CPM_LOG_DIR}/delivery-failures.log`;

async function writeBugReport(sent: SentMessage, reason: string, error?: string) {
  const timestamp = new Date().toISOString();
  const msgLabel = sent.messageId > 0 ? `msg${sent.messageId}` : `failure-${Date.now()}`;
  const filename = `${timestamp.replace(/[:.]/g, "-")}_${msgLabel}.md`;

  // Gather diagnostics (best-effort, short timeout — don't block error path)
  let brokerHealth = "unknown";
  let peerList = "unknown";
  try {
    const health = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(500) });
    if (health.ok) brokerHealth = JSON.stringify(await health.json());
  } catch {}
  try {
    const peers = await brokerFetch<{ id: string; session_name?: string }[]>("/list-peers", { scope: "machine", cwd: myCwd, git_root: myGitRoot });
    peerList = peers.map((p: any) => `${p.session_name || p.id} (${p.id})`).join(", ");
  } catch {}

  const report = `# Bug Report: ${reason}

**Timestamp**: ${timestamp}
**Message ID**: ${sent.messageId}
**From**: ${myId}
**To**: ${sent.toId}
**Sent At**: ${new Date(sent.sentAt).toISOString()}
**Age**: ${Math.round((Date.now() - sent.sentAt) / 1000)}s
**Reason**: ${reason}
${error ? `**Error**: ${error}\n` : ""}
## Diagnostics

**Broker Health**: ${brokerHealth}
**Active Peers**: ${peerList}
**Pending Inbound**: ${pendingMessages.size} message(s)
**Tracked Outbound**: ${sentMessages.size} message(s)
`;

  // Write bug report file
  try {
    require("fs").mkdirSync(BUG_REPORT_DIR, { recursive: true });
    await Bun.write(Bun.file(`${BUG_REPORT_DIR}/${filename}`), report);
    log(`Bug report written: BUG_REPORTS/${filename}`);
  } catch (e) {
    log(`Failed to write bug report: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Append to delivery failures log
  try {
    const logEntry = `[${timestamp}] ${reason} | msg#${sent.messageId} to ${sent.toId} | age=${Math.round((Date.now() - sent.sentAt) / 1000)}s${error ? ` | error=${error}` : ""}\n`;
    await Bun.write(Bun.file(FAILURE_LOG_PATH), logEntry, { append: true });
  } catch {}
}

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
      "Check for messages. Returns any unconfirmed pushed messages AND any new messages from the broker. Use this if channel notifications are not appearing.",
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
      "Diagnose messaging health: broker status, pending messages, delivery failures, and channel push state. Use when messages are not being delivered.",
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
          if (p.channel_push && p.channel_push !== "working") parts.push(`Channel push: ${p.channel_push}`);
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
        // US-001: If reply_to references a pending message, confirm it (reply is proof of receipt)
        if (reply_to !== undefined && pendingMessages.has(reply_to)) {
          confirmMessages([reply_to], "reply_to").catch(() => {});
        }

        // Task A: Track sent message for delivery confirmation
        if (result.message_id != null && sentMessages.size < MAX_SENT) {
          sentMessages.set(result.message_id, {
            messageId: result.message_id,
            toId: to_id,
            sentAt: Date.now(),
            warned: false,
          });
        }

        // Build preview: first line or first 120 chars
        const preview = message.split("\n")[0].slice(0, 120) + (message.length > 120 ? "..." : "");
        // Include any pending delivery warnings
        let responseText = `Message sent to peer ${to_id} (${msgIdTag})\n> Preview: ${preview}`;
        if (deliveryWarnings.length > 0) {
          responseText += `\n\n${deliveryWarnings.join("\n")}`;
          deliveryWarnings.length = 0;
        }
        return {
          content: [{ type: "text" as const, text: responseText }],
        };
      } catch (e) {
        // Task B: Auto bug report on send failure
        const errMsg = e instanceof Error ? e.message : String(e);
        const failedSent: SentMessage = { messageId: 0, toId: to_id, sentAt: Date.now(), warned: true };
        writeBugReport(failedSent, "send_failure", errMsg).catch(() => {});
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${errMsg}`,
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
        // US-003: Return pending (pushed but unconfirmed) + new broker messages, deduplicated.
        // This is the real fallback when channel push isn't working.
        const pendingMsgs = [...pendingMessages.values()].map(p => p.msg);
        const pendingIds = new Set(pendingMsgs.map(m => m.id));

        // Poll broker for undelivered messages (includes pending since they're unacked)
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

        // Merge: pending + new broker messages, deduped by message_id
        const allMessages: Message[] = [...pendingMsgs];
        for (const m of result.messages) {
          if (!pendingIds.has(m.id)) {
            allMessages.push(m);
          }
        }

        if (allMessages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        // Model is explicitly reading — confirm all messages as seen
        const allIds = allMessages.map(m => m.id);
        await confirmMessages(allIds, "check_messages");

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
      report.push(`Inbound pending (pushed, unconfirmed): ${pendingMessages.size}`);
      report.push(`Outbound tracked (sent, awaiting confirmation): ${sentMessages.size}`);
      report.push(`Delivery warnings pending: ${deliveryWarnings.length}`);

      // Recent delivery failures
      try {
        const failLogExists = await Bun.file(FAILURE_LOG_PATH).exists();
        if (failLogExists) {
          const content = await Bun.file(FAILURE_LOG_PATH).text();
          const lines = content.trim().split("\n").filter(l => l.trim());
          const recent = lines.slice(-5);
          if (recent.length > 0) {
            report.push("");
            report.push(`Recent delivery failures (last ${recent.length}):`);
            for (const line of recent) {
              report.push(`  ${line}`);
            }
          }
        }
      } catch {}

      // Bug reports count
      try {
        const dirExists = require("fs").existsSync(BUG_REPORT_DIR);
        if (dirExists) {
          const files = require("fs").readdirSync(BUG_REPORT_DIR).filter((f: string) => f.endsWith(".md"));
          if (files.length > 0) {
            report.push("");
            report.push(`Bug reports: ${files.length} in BUG_REPORTS/`);
          }
        }
      } catch {}

      return {
        content: [{ type: "text" as const, text: report.join("\n") }],
      };
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

    for (const msg of result.messages) {
      // Skip messages already in pending confirmation buffer (not yet acked, awaiting confirmation)
      if (pendingMessages.has(msg.id)) continue;

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

      // Deferred ack (US-001): add to pending buffer instead of acking immediately.
      // Message will be acked when confirmation evidence arrives.
      if (pendingMessages.size >= MAX_PENDING) {
        // Buffer full — force-ack oldest to make room
        let oldestId: number | null = null;
        let oldestTime = Infinity;
        for (const [id, pending] of pendingMessages) {
          if (pending.pushedAt < oldestTime) {
            oldestTime = pending.pushedAt;
            oldestId = id;
          }
        }
        if (oldestId !== null) {
          await confirmMessages([oldestId], "buffer-overflow");
        }
      }
      pendingMessages.set(msg.id, { msg, pushedAt: Date.now() });

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

    // Process optimistic confirmations: ack messages pending > 30s
    await processOptimisticConfirmations();

    // Task A: Check delivery status of sent messages
    await checkSentMessageDelivery();
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
    // Mark as unverified immediately
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
