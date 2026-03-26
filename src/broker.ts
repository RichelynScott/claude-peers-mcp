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
  RemoteMachine,
  RemotePeer,
  FederationHandshakeRequest,
  FederationRelayRequest,
  FederationPeersResponse,
  FederationConnectRequest,
  FederationStatusResponse,
} from "./shared/types.ts";
import {
  ensureTlsCert,
  getMachineHostname,
  detectSubnet,
  federationLog,
  signMessage,
  verifySignature,
  ipInSubnet,
  federationFetch,
} from "./federation.ts";
import { loadConfig } from "./shared/config.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const LOG_DIR = new URL("../cpm-logs", import.meta.url).pathname;
const TOKEN_PATH = process.env.CLAUDE_PEERS_TOKEN ?? `${process.env.HOME}/.claude-peers-token`;

// --- Persistent config file (env vars override config file values) ---
const persistentConfig = loadConfig();

// --- Federation configuration (US-003) ---
const FEDERATION_ENABLED =
  process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "true" ||
  process.env.CLAUDE_PEERS_FEDERATION_ENABLED === "1" ||
  persistentConfig.federation?.enabled === true;
const FEDERATION_PORT =
  parseInt(process.env.CLAUDE_PEERS_FEDERATION_PORT || "") ||
  persistentConfig.federation?.port ||
  7900;
const FEDERATION_SYNC_INTERVAL_MS = 30_000;
const FEDERATION_STALE_TIMEOUT_MS = 90_000;

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

  // Evict stale peers on re-register: check both PID and TTY.
  // When a Claude session restarts, it spawns a NEW MCP server with a new PID,
  // but the OLD MCP server may still be alive (zombie). Evicting by TTY ensures
  // only one peer per terminal, preventing message theft by zombie processes.
  let sessionName = body.session_name ?? "";
  let summary = body.summary ?? "";

  // Evict by PID (same process re-registering)
  const existingByPid = db.query("SELECT id, session_name, summary FROM peers WHERE pid = ?").get(body.pid) as { id: string; session_name: string; summary: string } | null;
  if (existingByPid) {
    if (!sessionName && existingByPid.session_name) sessionName = existingByPid.session_name;
    if (!summary && existingByPid.summary) summary = existingByPid.summary;
    deletePeer.run(existingByPid.id);
  }

  // Evict by TTY (new process on same terminal — session was restarted)
  if (body.tty) {
    const existingByTty = db.query("SELECT id, session_name, summary FROM peers WHERE tty = ? AND pid != ?").all(body.tty, body.pid) as Array<{ id: string; session_name: string; summary: string }>;
    for (const stale of existingByTty) {
      if (!sessionName && stale.session_name) sessionName = stale.session_name;
      if (!summary && stale.summary) summary = stale.summary;
      brokerLog(`Evicting stale peer ${stale.id} (same TTY ${body.tty}, replaced by PID ${body.pid})`);
      deletePeer.run(stale.id);
    }
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
    case "lan":
      // LAN scope: local machine peers + all remote peers from federation
      peers = selectAllPeers.all() as Peer[];
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  peers = peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });

  // For "lan" scope, merge remote peers from federation (US-006)
  if (body.scope === "lan" && FEDERATION_ENABLED) {
    for (const remote of remoteMachines.values()) {
      for (const rp of remote.peers) {
        // Convert RemotePeer to Peer shape for the response
        // Remote peer IDs are already prefixed with hostname (e.g., "rafi-mac:a1b2c3d4")
        const asPeer: Peer = {
          id: rp.id,
          pid: 0,             // Remote — no local PID
          cwd: rp.cwd,
          git_root: rp.git_root,
          tty: null,
          session_name: rp.session_name,
          summary: rp.summary,
          registered_at: rp.last_seen,
          last_seen: rp.last_seen,
        };
        if (body.exclude_id && asPeer.id === body.exclude_id) continue;
        peers.push(asPeer);
      }
    }
  }

  return peers;
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

async function handleBroadcast(body: BroadcastRequest): Promise<BroadcastResponse> {
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

  // Separate local peers (have real PIDs) from remote peers (pid === 0, ID contains ":")
  const localPeers = peers.filter((p) => !p.id.includes(":"));
  const remotePeers = peers.filter((p) => p.id.includes(":"));

  // Insert messages for local peers atomically
  if (localPeers.length > 0) {
    const insertAll = db.transaction(() => {
      for (const peer of localPeers) {
        const result = insertMessage.run(
          body.from_id, peer.id, body.text, type,
          metadataStr, null, now
        );
        messageIds.push(Number(result.lastInsertRowid));
      }
    });
    insertAll();
  }

  // Relay broadcast to remote peers via federation (FR-11: LAN broadcast)
  if (remotePeers.length > 0 && FEDERATION_ENABLED) {
    const relayPromises = remotePeers.map(async (peer) => {
      try {
        const result = await handleFederationSendToRemote({
          to_id: peer.id,
          from_id: body.from_id,
          text: body.text,
          type,
          metadata: body.metadata as Record<string, unknown> | undefined,
        });
        if (result.ok) {
          messageIds.push(-1); // Remote — no local message ID
        } else {
          brokerLog(`broadcast relay to ${peer.id} failed: ${result.error}`);
        }
      } catch (err) {
        brokerLog(`broadcast relay to ${peer.id} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    await Promise.allSettled(relayPromises);
  }

  const totalRecipients = localPeers.length + remotePeers.length;
  brokerLog(`broadcast from ${body.from_id} to ${totalRecipients} peer(s) in scope ${body.scope} (${localPeers.length} local, ${remotePeers.length} remote)`);
  return { ok: true, recipients: totalRecipients, message_ids: messageIds };
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

// --- US-006: Request counting + uptime for /health ---

const BROKER_START_TIME = Date.now();
let requestsThisMinute = 0;
let requestsLastMinute = 0;

// Rotate request counter every 60s
setInterval(() => {
  requestsLastMinute = requestsThisMinute;
  requestsThisMinute = 0;
}, 60_000);

// Clean expired rate limit entries every 60s to prevent unbounded map growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimits) {
    if (now >= limit.resetAt) rateLimits.delete(ip);
  }
}, 60_000);

// --- Federation state (US-003) ---
// In-memory map of connected remote machines and their peers
const remoteMachines = new Map<string, RemoteMachine>();

// Resolved federation subnet (set during startup if federation enabled)
let federationSubnet = "0.0.0.0/0";
let federationHostname = "";

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    requestsThisMinute++;
    const url = new URL(req.url);
    const path = url.pathname;

    // /health exempt — always respond (no auth required)
    if (path === "/health") {
      const pendingCount = (db.query("SELECT COUNT(*) as cnt FROM messages WHERE delivered = 0").get() as { cnt: number }).cnt;
      return Response.json({
        status: "ok",
        peers: (selectAllPeers.all() as Peer[]).length,
        uptime_ms: Date.now() - BROKER_START_TIME,
        requests_last_minute: requestsLastMinute,
        pending_messages: pendingCount,
      });
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

    // GET /federation/status — returns federation state (auth still required via query param or no auth for GET)
    if (req.method === "GET" && path === "/federation/status") {
      return Response.json(handleFederationStatus());
    }

    if (req.method !== "POST") {
      return new Response("claude-peers broker", { status: 200 });
    }

    // US-002: Cooperative yield for background traffic.
    // /heartbeat and /poll-messages yield to the event loop before body parsing,
    // allowing queued /register requests to run first (priority admission).
    if (path === "/heartbeat" || path === "/poll-messages") {
      await new Promise(r => setTimeout(r, 0));
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
          return Response.json(await handleBroadcast(body as BroadcastRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/ack-messages":
          handleAckMessages(body as AckMessagesRequest);
          return Response.json({ ok: true });
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });

        // --- Federation local-facing endpoints (US-006) ---
        case "/federation/status":
          return Response.json(handleFederationStatus());
        case "/federation/connect":
          return Response.json(await handleFederationConnect(body as FederationConnectRequest));
        case "/federation/disconnect":
          return Response.json(handleFederationDisconnect(body as { host: string; port: number }));
        case "/federation/send-to-remote":
          return Response.json(await handleFederationSendToRemote(body as {
            to_id: string; from_id: string; text: string;
            type?: string; metadata?: Record<string, unknown>; reply_to?: number;
          }));

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

// --- Federation local-facing handlers (US-006) ---

function handleFederationStatus(): FederationStatusResponse {
  if (!FEDERATION_ENABLED) {
    return {
      enabled: false,
      port: FEDERATION_PORT,
      subnet: "",
      remotes: [],
      total_remote_peers: 0,
    };
  }

  const remotes: FederationStatusResponse["remotes"] = [];
  let totalRemotePeers = 0;
  for (const rm of remoteMachines.values()) {
    remotes.push({
      host: rm.host,
      port: rm.port,
      hostname: rm.hostname,
      peer_count: rm.peers.length,
      connected_at: rm.connected_at,
      last_sync: rm.last_sync,
    });
    totalRemotePeers += rm.peers.length;
  }

  return {
    enabled: true,
    port: FEDERATION_PORT,
    subnet: federationSubnet,
    remotes,
    total_remote_peers: totalRemotePeers,
  };
}

async function handleFederationConnect(body: FederationConnectRequest): Promise<{ ok: boolean; hostname?: string; error?: string }> {
  if (!FEDERATION_ENABLED) {
    return { ok: false, error: "Federation is not enabled" };
  }

  const { host, port } = body;
  const key = `${host}:${port}`;

  // Already connected?
  if (remoteMachines.has(key)) {
    return { ok: true, hostname: remoteMachines.get(key)!.hostname };
  }

  try {
    // TLS handshake with remote federation agent (curl workaround for self-signed certs)
    const handshakeResult = await federationFetch<{ hostname: string; version: string; error?: string }>(
      `https://${host}:${port}/federation/handshake`,
      {
        psk: currentToken,
        hostname: federationHostname,
        version: "1.0.0",
      } satisfies FederationHandshakeRequest,
      currentToken,
    );

    if (!handshakeResult.ok) {
      const errMsg = (handshakeResult.data as { error?: string })?.error ?? "unknown";
      return { ok: false, error: `Handshake failed (${handshakeResult.status}): ${errMsg}` };
    }

    const result = handshakeResult.data;

    // Fetch initial peer list from remote
    const peersResult = await federationFetch<FederationPeersResponse>(
      `https://${host}:${port}/federation/peers`,
      {},
      currentToken,
    );

    let remotePeers: RemotePeer[] = [];
    if (peersResult.ok) {
      const peersData = peersResult.data;
      remotePeers = peersData.peers.map((p: Peer) => ({
        id: `${result.hostname}:${p.id}`,
        machine: result.hostname,
        cwd: p.cwd,
        git_root: p.git_root,
        session_name: p.session_name,
        summary: p.summary,
        last_seen: p.last_seen,
      }));
    }

    const now = new Date().toISOString();
    remoteMachines.set(key, {
      host,
      port,
      hostname: result.hostname,
      peers: remotePeers,
      connected_at: now,
      last_sync: now,
    });

    federationLog(`Connected to ${result.hostname} at ${host}:${port} (${remotePeers.length} peers)`);
    return { ok: true, hostname: result.hostname };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    federationLog(`Failed to connect to ${host}:${port}: ${msg}`);
    return { ok: false, error: msg };
  }
}

function handleFederationDisconnect(body: { host: string; port: number }): { ok: boolean; error?: string } {
  if (!FEDERATION_ENABLED) {
    return { ok: false, error: "Federation is not enabled" };
  }

  const key = `${body.host}:${body.port}`;
  if (!remoteMachines.has(key)) {
    return { ok: false, error: `Not connected to ${key}` };
  }

  const rm = remoteMachines.get(key)!;
  remoteMachines.delete(key);
  federationLog(`Disconnected from ${rm.hostname} at ${key}`);
  return { ok: true };
}

async function handleFederationSendToRemote(body: {
  to_id: string; from_id: string; text: string;
  type?: string; metadata?: Record<string, unknown>; reply_to?: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!FEDERATION_ENABLED) {
    return { ok: false, error: "Federation is not enabled" };
  }

  const { to_id, from_id, text, type, metadata, reply_to } = body;

  // to_id should be "hostname:peer_id" — find which remote machine owns it
  const colonIdx = to_id.indexOf(":");
  if (colonIdx === -1) {
    return { ok: false, error: `Invalid remote peer ID "${to_id}" — expected "hostname:peer_id" format` };
  }

  const targetHostname = to_id.slice(0, colonIdx);

  // Find the remote machine by hostname
  let targetMachine: RemoteMachine | undefined;
  for (const rm of remoteMachines.values()) {
    if (rm.hostname === targetHostname) {
      targetMachine = rm;
      break;
    }
  }

  if (!targetMachine) {
    return { ok: false, error: `No federation connection to machine "${targetHostname}"` };
  }

  // Build relay request with HMAC signature
  const relayBody: Record<string, unknown> = {
    from_id: `${federationHostname}:${from_id}`,
    from_machine: federationHostname,
    to_id: to_id.slice(colonIdx + 1), // strip hostname prefix for the remote
    text,
    type: type ?? "text",
    metadata: metadata ?? null,
    reply_to: reply_to ?? null,
  };

  // Sign the body (excluding the signature field itself)
  const signature = signMessage(relayBody, currentToken);

  try {
    // Use curl workaround for self-signed TLS certs
    const resp = await federationFetch<{ ok?: boolean; error?: string }>(
      `https://${targetMachine.host}:${targetMachine.port}/federation/relay`,
      { ...relayBody, signature },
      currentToken,
    );

    if (!resp.ok) {
      const errMsg = resp.data?.error ?? "unknown";
      return { ok: false, error: `Relay failed (${resp.status}): ${errMsg}` };
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Relay to ${targetMachine.hostname} failed: ${msg}` };
  }
}

// --- Federation periodic peer sync (US-009) ---

async function syncRemotePeers(): Promise<void> {
  if (!FEDERATION_ENABLED || remoteMachines.size === 0) return;

  const now = Date.now();

  for (const [key, remote] of remoteMachines) {
    try {
      // Use curl workaround for self-signed TLS certs
      const resp = await federationFetch<FederationPeersResponse>(
        `https://${remote.host}:${remote.port}/federation/peers`,
        {},
        currentToken,
      );

      if (!resp.ok) {
        federationLog(`Sync warning: ${remote.hostname} (${key}) returned ${resp.status}`);
        continue;
      }

      const data = resp.data;
      remote.peers = data.peers.map((p: Peer) => ({
        id: `${remote.hostname}:${p.id}`,
        machine: remote.hostname,
        cwd: p.cwd,
        git_root: p.git_root,
        session_name: p.session_name,
        summary: p.summary,
        last_seen: p.last_seen,
      }));
      remote.last_sync = new Date().toISOString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      federationLog(`Sync warning: failed to reach ${remote.hostname} (${key}): ${msg}`);
    }
  }

  // Evict stale remotes whose last_sync exceeds the stale timeout
  for (const [key, remote] of remoteMachines) {
    const lastSyncAge = now - new Date(remote.last_sync).getTime();
    if (lastSyncAge > FEDERATION_STALE_TIMEOUT_MS) {
      federationLog(`Evicting stale remote ${remote.hostname} (${key}) — last sync ${Math.round(lastSyncAge / 1000)}s ago`);
      remoteMachines.delete(key);
    }
  }
}

// --- Federation TLS server (US-003, US-004, US-006) ---

async function handleFederationRequest(req: Request, server: any): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // US-004: Subnet restriction — use Bun's server.requestIP() for the real socket address.
  // SECURITY: Never trust X-Forwarded-For — an attacker can inject it to bypass subnet checks.
  const socketAddr = server.requestIP(req);
  const remoteIp = socketAddr?.address ?? "0.0.0.0";

  // Strip IPv6-mapped IPv4 prefix if present (e.g., "::ffff:192.168.1.5" -> "192.168.1.5")
  const cleanIp = remoteIp.startsWith("::ffff:") ? remoteIp.slice(7) : remoteIp;

  if (!ipInSubnet(cleanIp, federationSubnet)) {
    federationLog(`Rejected connection from ${cleanIp} — outside subnet ${federationSubnet}`);
    return Response.json(
      { error: "Connection rejected: outside allowed subnet" },
      { status: 403 }
    );
  }

  // Health check — no auth required
  if (path === "/health") {
    return Response.json({ status: "ok", federation: true, hostname: federationHostname });
  }

  if (req.method !== "POST") {
    return new Response("claude-peers federation agent", { status: 200 });
  }

  // PSK validation for all POST federation endpoints
  const psk = req.headers.get("x-claude-peers-psk");
  if (!psk || !isValidToken(psk, currentToken)) {
    federationLog(`PSK mismatch from ${cleanIp}`);
    return Response.json({ error: "PSK mismatch" }, { status: 403 });
  }

  try {
    const body = await req.json();

    switch (path) {
      case "/federation/handshake": {
        const hsReq = body as FederationHandshakeRequest;
        // Validate PSK in body as well (belt-and-suspenders)
        if (!hsReq.psk || !isValidToken(hsReq.psk, currentToken)) {
          return Response.json({ error: "PSK mismatch" }, { status: 403 });
        }
        federationLog(`Handshake from ${hsReq.hostname} (v${hsReq.version}) at ${cleanIp}`);
        return Response.json({ hostname: federationHostname, version: "1.0.0" });
      }

      case "/federation/peers": {
        // Return all local peers (reuse existing handler)
        const localPeers = handleListPeers({ scope: "machine", cwd: "", git_root: null });
        const resp: FederationPeersResponse = {
          hostname: federationHostname,
          peers: localPeers,
        };
        return Response.json(resp);
      }

      case "/federation/relay": {
        const relayReq = body as FederationRelayRequest;

        // Validate HMAC signature — strip signature from body for verification
        const { signature, ...bodyWithoutSig } = relayReq;
        if (!signature || !verifySignature(bodyWithoutSig as Record<string, unknown>, signature, currentToken)) {
          federationLog(`Invalid HMAC signature on relay from ${relayReq.from_machine}`);
          return Response.json({ error: "Invalid HMAC signature" }, { status: 403 });
        }

        // Validate target exists locally
        const target = db.query("SELECT id, pid FROM peers WHERE id = ?").get(relayReq.to_id) as { id: string; pid: number } | null;
        if (!target) {
          return Response.json({ ok: false, error: `Peer ${relayReq.to_id} not found locally` }, { status: 404 });
        }

        // For remote from_ids (containing ":"), bypass PID liveness check
        // because the sender is on another machine — no local PID to check
        const isRemoteFrom = relayReq.from_id.includes(":");

        if (!isRemoteFrom) {
          // Shouldn't happen for federation relay, but validate just in case
          try { process.kill(target.pid, 0); } catch {
            deletePeer.run(target.id);
            return Response.json({ ok: false, error: `Peer ${relayReq.to_id} is not running` }, { status: 410 });
          }
        }

        // Insert the relayed message
        const msgType = relayReq.type ?? "text";
        const metadataStr = relayReq.metadata ? JSON.stringify(relayReq.metadata) : null;
        const result = insertMessage.run(
          relayReq.from_id, relayReq.to_id, relayReq.text,
          msgType, metadataStr, relayReq.reply_to ?? null, new Date().toISOString()
        );

        federationLog(`Relayed message from ${relayReq.from_id} to ${relayReq.to_id} (msg_id=${result.lastInsertRowid})`);
        return Response.json({ ok: true, message_id: Number(result.lastInsertRowid) });
      }

      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    federationLog(`Error handling federation request: ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// Start federation TLS server if enabled
if (FEDERATION_ENABLED) {
  (async () => {
    try {
      // Resolve hostname
      federationHostname = getMachineHostname();

      // US-004: Detect or use configured subnet (env var > config file > auto-detect)
      const configuredSubnet =
        process.env.CLAUDE_PEERS_FEDERATION_SUBNET ||
        persistentConfig.federation?.subnet;
      if (configuredSubnet) {
        federationSubnet = configuredSubnet;
        const source = process.env.CLAUDE_PEERS_FEDERATION_SUBNET ? "env var" : "config file";
        federationLog(`Subnet restriction (${source}): ${federationSubnet}`);
      } else {
        federationSubnet = await detectSubnet();
        federationLog(`Subnet restriction (auto-detected): ${federationSubnet}`);
      }

      // Generate/load TLS certificate
      const { certPath, keyPath } = await ensureTlsCert();

      // Start federation TLS server on 0.0.0.0 (LAN-facing)
      Bun.serve({
        port: FEDERATION_PORT,
        hostname: "0.0.0.0",
        tls: {
          cert: Bun.file(certPath),
          key: Bun.file(keyPath),
        },
        fetch(req, server) { return handleFederationRequest(req, server); },
      });

      federationLog(`Listening on 0.0.0.0:${FEDERATION_PORT} (TLS) — hostname: ${federationHostname}`);

      // US-009: Start periodic peer sync with connected remotes
      const federationSyncTimer = setInterval(async () => {
        try {
          await syncRemotePeers();
        } catch (err) {
          federationLog(`Sync error (non-fatal): ${err}`);
        }
      }, FEDERATION_SYNC_INTERVAL_MS);

      // Prevent the timer from keeping the process alive if broker is shutting down
      if (federationSyncTimer.unref) federationSyncTimer.unref();
    } catch (err) {
      // CRITICAL: Federation failure must not crash the broker
      const msg = err instanceof Error ? err.message : String(err);
      federationLog(`Federation startup FAILED (broker continues without federation): ${msg}`);
    }
  })();
} else {
  brokerLog("Federation disabled (set CLAUDE_PEERS_FEDERATION_ENABLED=true to enable)");
}
