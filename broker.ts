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
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const LOG_DIR = new URL("./cpm-logs", import.meta.url).pathname;

// Ensure log directory exists
try { require("fs").mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function brokerLog(msg: string) {
  const line = `[${new Date().toISOString()}] [CPM-broker] ${msg}`;
  console.error(`[CPM-broker] ${msg}`);
  try { Bun.write(Bun.file(`${LOG_DIR}/broker.log`), line + "\n", { append: true }); } catch {}
}

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
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

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
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
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

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.session_name ?? "", body.summary, now, now);
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

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string; message_id?: number } {
  // Enforce message size limit (10KB)
  if (body.text.length > 10240) {
    return { ok: false, error: "Message too large (max 10KB)" };
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

  const result = insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true, message_id: Number(result.lastInsertRowid) };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  // Two-phase delivery: return messages but do NOT mark delivered.
  // Recipient must call /ack-messages after successful channel notification push.
  const messages = selectUndelivered.all(body.id) as Message[];
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

    // /health exempt — always respond
    if (path === "/health") {
      return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
    }

    // Rate limiting: only applies to /send-message (abuse vector).
    // Internal endpoints (/register, /heartbeat, /poll-messages, /ack-messages,
    // /set-summary, /set-name, /list-peers, /unregister) are exempt because:
    // - All traffic is localhost (127.0.0.1) so per-IP = per-machine = one bucket
    // - Normal polling alone (N peers × 1 req/sec) exceeds any reasonable per-IP limit
    // - The only abuse vector worth rate-limiting is message spam
    if (path === "/send-message" && req.method === "POST") {
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
