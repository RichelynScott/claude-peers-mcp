#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { timingSafeEqual } from "crypto";
import * as fs from "node:fs";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  SetNameRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  AckMessagesRequest,
  BroadcastRequest,
  BroadcastResponse,
  Peer,
  Message,
  MessageType,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const LOG_DIR = new URL("./cpm-logs", import.meta.url).pathname;
const TOKEN_PATH = process.env.CLAUDE_PEERS_TOKEN ?? `${process.env.HOME}/.claude-peers-token`;

// Ensure log directory exists
try { require("fs").mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function brokerLog(msg: string) {
  const line = `[${new Date().toISOString()}] [CPM-broker] ${msg}`;
  console.error(`[CPM-broker] ${msg}`);
  try { Bun.write(Bun.file(`${LOG_DIR}/broker.log`), line + "\n", { append: true }); } catch {}
}

// --- Token generation / loading ---

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function loadOrCreateToken(): string {
  if (fs.existsSync(TOKEN_PATH)) {
    const content = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    if (content) {
      brokerLog(`Token loaded from ${TOKEN_PATH}`);
      return content;
    }
  }
  // Generate new token
  const token = generateToken();
  fs.writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  brokerLog(`Token loaded from ${TOKEN_PATH}`);
  return token;
}

let currentToken = loadOrCreateToken();

function isValidToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

// Re-read token file periodically (60s) for rotation support
function rereadToken(): void {
  try {
    if (!fs.existsSync(TOKEN_PATH)) {
      brokerLog(`Warning: Token file missing at ${TOKEN_PATH}, keeping previous token`);
      return;
    }
    const content = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    if (content && content !== currentToken) {
      currentToken = content;
      brokerLog(`Token reloaded from ${TOKEN_PATH}`);
    }
  } catch {
    brokerLog(`Warning: Failed to re-read token file at ${TOKEN_PATH}, keeping previous token`);
  }
}

setInterval(rereadToken, 60_000);

// SIGHUP handler for immediate token re-read
process.on("SIGHUP", () => {
  brokerLog("Received SIGHUP, re-reading token file");
  rereadToken();
});

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Schema migration: add session_name column for existing databases
try { db.run("ALTER TABLE peers ADD COLUMN session_name TEXT DEFAULT ''"); } catch { /* column already exists */ }

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    metadata TEXT DEFAULT NULL,
    reply_to INTEGER DEFAULT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Schema migration: add structured message columns for existing databases
try { db.run("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'"); } catch { /* column already exists */ }
try { db.run("ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT NULL"); } catch { /* column already exists */ }
try { db.run("ALTER TABLE messages ADD COLUMN reply_to INTEGER DEFAULT NULL"); } catch { /* column already exists */ }

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, session_name, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const updateName = db.prepare(`
  UPDATE peers SET session_name = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, type, metadata, reply_to, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const selectMessageExists = db.prepare(`
  SELECT id FROM messages WHERE id = ?
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const deleteDeliveredMessages = db.prepare(`
  DELETE FROM messages WHERE delivered = 1 AND sent_at < datetime('now', '-7 days')
`);

// Clean delivered messages older than 7 days
function cleanDeliveredMessages() {
  const result = deleteDeliveredMessages.run();
  if (result.changes > 0) {
    brokerLog(`cleaned ${result.changes} delivered messages older than 7 days`);
  }
}

cleanDeliveredMessages();

// Periodically clean delivered messages (every 60s)
setInterval(cleanDeliveredMessages, 60_000);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Preserve session_name and summary from previous registration on re-register
  let sessionName = body.session_name ?? "";
  let summary = body.summary ?? "";
  const existing = db.query("SELECT id, session_name, summary FROM peers WHERE pid = ?").get(body.pid) as { id: string; session_name: string; summary: string } | null;
  if (existing) {
    if (!sessionName && existing.session_name) sessionName = existing.session_name;
    if (!summary && existing.summary) summary = existing.summary;
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, sessionName, summary, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleSetName(body: SetNameRequest): void {
  updateName.run(body.session_name, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });
}

const VALID_MESSAGE_TYPES = new Set<string>(["text", "query", "response", "handoff", "broadcast"]);

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string; message_id?: number } {
  // Validate type if provided
  const type: MessageType = (body.type ?? "text") as MessageType;
  if (!VALID_MESSAGE_TYPES.has(type)) {
    return { ok: false, error: `Invalid message type: ${body.type}` };
  }

  // Validate metadata if provided — must be a plain object (not array, string, number, etc.)
  let metadataStr: string | null = null;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
      return { ok: false, error: "metadata must be a JSON object" };
    }
    metadataStr = JSON.stringify(body.metadata);
  }

  // Enforce message size limit (10KB) — text + metadata combined
  const totalSize = body.text.length + (metadataStr?.length ?? 0);
  if (totalSize > 10240) {
    return { ok: false, error: "Message too large (text + metadata max 10KB)" };
  }

  // Validate reply_to if provided
  if (body.reply_to !== undefined && body.reply_to !== null) {
    const referenced = selectMessageExists.get(body.reply_to) as { id: number } | null;
    if (!referenced) {
      return { ok: false, error: `Referenced message ${body.reply_to} not found` };
    }
  }

  // Verify target exists and is alive
  const target = db.query("SELECT id, pid FROM peers WHERE id = ?").get(body.to_id) as { id: string; pid: number } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  // Liveness check — fail fast if recipient process is dead
  try {
    process.kill(target.pid, 0);
  } catch {
    // Clean up dead peer
    deletePeer.run(target.id);
    return { ok: false, error: `Peer ${body.to_id} is not running (PID ${target.pid} dead)` };
  }

  const result = insertMessage.run(
    body.from_id, body.to_id, body.text, type,
    metadataStr, body.reply_to ?? null, new Date().toISOString()
  );
  return { ok: true, message_id: Number(result.lastInsertRowid) };
}

function handleBroadcast(body: BroadcastRequest): BroadcastResponse {
  // Validate type if provided
  const type: MessageType = (body.type ?? "broadcast") as MessageType;
  if (!VALID_MESSAGE_TYPES.has(type)) {
    return { ok: false, recipients: 0, message_ids: [], error: `Invalid message type: ${body.type}` };
  }

  // Validate metadata if provided
  let metadataStr: string | null = null;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
      return { ok: false, recipients: 0, message_ids: [], error: "metadata must be a JSON object" };
    }
    metadataStr = JSON.stringify(body.metadata);
  }

  // Enforce message size limit (10KB) — text + metadata combined
  const totalSize = body.text.length + (metadataStr?.length ?? 0);
  if (totalSize > 10240) {
    return { ok: false, recipients: 0, message_ids: [], error: "Message too large (text + metadata max 10KB)" };
  }

  // Resolve recipients using existing list-peers logic, excluding sender
  const peers = handleListPeers({
    scope: body.scope,
    cwd: body.cwd,
    git_root: body.git_root,
    exclude_id: body.from_id,
  });

  if (peers.length === 0) {
    return { ok: true, recipients: 0, message_ids: [] };
  }

  const now = new Date().toISOString();
  const messageIds: number[] = [];

  // Atomic: all messages inserted in one transaction
  const insertAll = db.transaction(() => {
    for (const peer of peers) {
      const result = insertMessage.run(
        body.from_id, peer.id, body.text, type,
        metadataStr, null, now
      );
      messageIds.push(Number(result.lastInsertRowid));
    }
  });
  insertAll();

  brokerLog(`broadcast from ${body.from_id} to ${peers.length} peer(s) in scope ${body.scope}`);
  return { ok: true, recipients: peers.length, message_ids: messageIds };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  // Two-phase delivery: return messages but do NOT mark delivered.
  // Recipient must call /ack-messages after successful channel notification push.
  const rows = selectUndelivered.all(body.id) as Array<Record<string, unknown>>;
  // Parse metadata from JSON string back to object
  const messages: Message[] = rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    reply_to: row.reply_to as number | null,
    type: (row.type as MessageType) ?? "text",
  })) as Message[];
  return { messages };
}

function handleAckMessages(body: AckMessagesRequest): void {
  // Phase 2: mark messages as delivered after recipient confirms receipt
  for (const mid of body.message_ids) {
    markDelivered.run(mid);
  }
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- Rate limiting ---

const rateLimits = new Map<string, { count: number; resetAt: number }>();

// Clean expired rate limit entries every 60s to prevent unbounded map growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimits) {
    if (now >= limit.resetAt) rateLimits.delete(ip);
  }
}, 60_000);

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // /health exempt — always respond (no auth required)
    if (path === "/health") {
      return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
    }

    // --- Auth check (before rate limiting and body parsing) ---
    if (req.method === "POST") {
      const authHeader = req.headers.get("authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const providedToken = authHeader.slice(7);
      if (!isValidToken(providedToken, currentToken)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Rate limiting: only applies to /send-message (abuse vector).
    // Internal endpoints (/register, /heartbeat, /poll-messages, /ack-messages,
    // /set-summary, /set-name, /list-peers, /unregister) are exempt because:
    // - All traffic is localhost (127.0.0.1) so per-IP = per-machine = one bucket
    // - Normal polling alone (N peers × 1 req/sec) exceeds any reasonable per-IP limit
    // - The only abuse vector worth rate-limiting is message spam
    if ((path === "/send-message" || path === "/broadcast") && req.method === "POST") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";
      const now = Date.now();
      const limit = rateLimits.get(ip);
      if (limit && now < limit.resetAt) {
        limit.count++;
        if (limit.count > 60) {
          return new Response(JSON.stringify({ error: "Rate limited" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
      } else {
        rateLimits.set(ip, { count: 1, resetAt: now + 60_000 });
      }
    }

    if (req.method !== "POST") {
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/set-name":
          handleSetName(body as SetNameRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/broadcast":
          return Response.json(handleBroadcast(body as BroadcastRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/ack-messages":
          handleAckMessages(body as AckMessagesRequest);
          return Response.json({ ok: true });
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

brokerLog(`listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
