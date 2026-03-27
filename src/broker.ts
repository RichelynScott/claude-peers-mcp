#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 *
 * Architecture (post-refactor):
 *   broker.ts     — state ownership, db, timers, server lifecycle, SIGHUP reload
 *   broker-handlers.ts — request handlers in factory closures (hot-reloadable)
 *   shared/types.ts    — BrokerContext interface
 */

import { Database } from "bun:sqlite";
import { timingSafeEqual } from "crypto";
import * as fs from "node:fs";
import type {
  Peer,
  RemoteMachine,
  RemotePeer,
  BrokerContext,
} from "./shared/types.ts";
import {
  ensureTlsCert,
  getMachineHostname,
  detectSubnet,
  federationLog,
  federationFetch,
  isWSL2,
} from "./federation.ts";
import { loadConfig } from "./shared/config.ts";
import {
  createBrokerFetch,
  createFederationFetch,
  handleFederationConnect,
} from "./broker-handlers.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const LOG_DIR = new URL("../cpm-logs", import.meta.url).pathname;
const TOKEN_PATH = process.env.CLAUDE_PEERS_TOKEN ?? `${process.env.HOME}/.claude-peers-token`;

// --- Persistent config file (env vars override config file values) ---
let persistentConfig = loadConfig();

// --- Federation configuration ---
const FEDERATION_ENABLED = (() => {
  const envVal = process.env.CLAUDE_PEERS_FEDERATION_ENABLED;
  if (envVal === "true" || envVal === "1") return true;
  if (envVal === "false" || envVal === "0") return false;
  return persistentConfig.federation?.enabled === true;
})();
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

function rereadToken(): void {
  try {
    if (!fs.existsSync(TOKEN_PATH)) {
      brokerLog(`Warning: Token file missing at ${TOKEN_PATH}, keeping previous token`);
      return;
    }
    const content = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    if (content && content !== currentToken) {
      currentToken = content;
      ctx.token.current = currentToken;
      brokerLog(`Token reloaded from ${TOKEN_PATH}`);
    }
  } catch {
    brokerLog(`Warning: Failed to re-read token file at ${TOKEN_PATH}, keeping previous token`);
  }
}

setInterval(rereadToken, 60_000);

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

try { db.run("ALTER TABLE peers ADD COLUMN session_name TEXT DEFAULT ''"); } catch {}

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

try { db.run("ALTER TABLE peers ADD COLUMN channel_push TEXT DEFAULT 'unknown'"); } catch {}
try { db.run("ALTER TABLE peers ADD COLUMN version TEXT DEFAULT ''"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT NULL"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN reply_to INTEGER DEFAULT NULL"); } catch {}

// --- Prepared statements ---

const stmts = {
  insertPeer: db.prepare(`
    INSERT INTO peers (id, pid, cwd, git_root, tty, session_name, summary, version, registered_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateLastSeen: db.prepare(`UPDATE peers SET last_seen = ? WHERE id = ?`),
  updateSummary: db.prepare(`UPDATE peers SET summary = ? WHERE id = ?`),
  updateName: db.prepare(`UPDATE peers SET session_name = ? WHERE id = ?`),
  updateChannelPush: db.prepare(`UPDATE peers SET channel_push = ? WHERE id = ?`),
  deletePeer: db.prepare(`DELETE FROM peers WHERE id = ?`),
  selectAllPeers: db.prepare(`SELECT * FROM peers`),
  selectPeersByDirectory: db.prepare(`SELECT * FROM peers WHERE cwd = ?`),
  selectPeersByGitRoot: db.prepare(`SELECT * FROM peers WHERE git_root = ?`),
  insertMessage: db.prepare(`
    INSERT INTO messages (from_id, to_id, text, type, metadata, reply_to, sent_at, delivered)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `),
  selectUndelivered: db.prepare(`SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC`),
  selectMessageExists: db.prepare(`SELECT id FROM messages WHERE id = ?`),
  markDelivered: db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?`),
};

const deleteDeliveredMessages = db.prepare(`
  DELETE FROM messages WHERE delivered = 1 AND sent_at < datetime('now', '-7 days')
`);

// --- Stale peer cleanup ---

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid, session_name FROM peers").all() as { id: string; pid: number; session_name: string }[];
  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      const orphanedMsgs = db.query(
        "SELECT id, from_id, text FROM messages WHERE to_id = ? AND delivered = 0"
      ).all(peer.id) as { id: number; from_id: string; text: string }[];

      if (orphanedMsgs.length > 0) {
        const peerLabel = peer.session_name || peer.id;
        const now = new Date().toISOString();
        for (const msg of orphanedMsgs) {
          const sender = db.query("SELECT id, pid FROM peers WHERE id = ?").get(msg.from_id) as { id: string; pid: number } | null;
          if (sender) {
            try { process.kill(sender.pid, 0); } catch { continue; }
            const preview = msg.text.slice(0, 100) + (msg.text.length > 100 ? "..." : "");
            const bounceText = `\u26a0 Message #${msg.id} to ${peerLabel} could not be delivered \u2014 peer has disconnected.\n> ${preview}`;
            stmts.insertMessage.run("system", msg.from_id, bounceText, "text", null, msg.id, now);
            brokerLog(`Bounced msg#${msg.id} back to ${msg.from_id} (target ${peerLabel} is dead)`);
          }
        }
      }

      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

function cleanOrphanedMessages() {
  const orphaned = db.query(`
    SELECT m.id, m.from_id, m.to_id, m.text FROM messages m
    LEFT JOIN peers p ON m.to_id = p.id
    WHERE m.delivered = 0 AND p.id IS NULL AND m.from_id != 'system'
  `).all() as { id: number; from_id: string; to_id: string; text: string }[];

  if (orphaned.length === 0) return;

  const now = new Date().toISOString();
  for (const msg of orphaned) {
    const sender = db.query("SELECT id, pid FROM peers WHERE id = ?").get(msg.from_id) as { id: string; pid: number } | null;
    if (sender) {
      try {
        process.kill(sender.pid, 0);
        const preview = msg.text.slice(0, 100) + (msg.text.length > 100 ? "..." : "");
        const bounceText = `\u26a0 Message #${msg.id} to ${msg.to_id} could not be delivered \u2014 peer has disconnected.\n> ${preview}`;
        stmts.insertMessage.run("system", msg.from_id, bounceText, "text", null, msg.id, now);
        brokerLog(`Bounced orphaned msg#${msg.id} back to ${msg.from_id}`);
      } catch {
        // Sender also dead
      }
    }
  }

  const orphanedIds = orphaned.map(m => m.id);
  db.run(`DELETE FROM messages WHERE id IN (${orphanedIds.join(",")})`);
  brokerLog(`Cleaned ${orphaned.length} orphaned message(s)`);
}

setInterval(cleanOrphanedMessages, 30_000);
setInterval(cleanStalePeers, 30_000);

function cleanDeliveredMessages() {
  const result = deleteDeliveredMessages.run();
  if (result.changes > 0) {
    brokerLog(`cleaned ${result.changes} delivered messages older than 7 days`);
  }
}

cleanDeliveredMessages();
setInterval(cleanDeliveredMessages, 60_000);
cleanOrphanedMessages();

// --- Request counting + uptime ---

const BROKER_START_TIME = Date.now();
const counters = { requestsThisMinute: 0, requestsLastMinute: 0 };

setInterval(() => {
  counters.requestsLastMinute = counters.requestsThisMinute;
  counters.requestsThisMinute = 0;
}, 60_000);

// --- Rate limit cleanup ---

const rateLimits = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimits) {
    if (now >= limit.resetAt) rateLimits.delete(ip);
  }
}, 60_000);

// --- Federation state ---

const remoteMachines = new Map<string, RemoteMachine>();
let federationSubnet = "0.0.0.0/0";
let federationHostname = "";

// ---------------------------------------------------------------------------
// BrokerContext — the shared state object passed to handler factories
// ---------------------------------------------------------------------------

const ctx: BrokerContext = {
  db,
  stmts,
  token: { current: currentToken },
  remoteMachines,
  rateLimits,
  counters,
  startTime: BROKER_START_TIME,
  federationEnabled: FEDERATION_ENABLED,
  federationPort: FEDERATION_PORT,
  federationHostname: { current: federationHostname },
  federationSubnet: { current: federationSubnet },
  port: PORT,
  brokerLog,
  isValidToken,
};

// ---------------------------------------------------------------------------
// HTTP Server — uses handler factory from broker-handlers.ts
// ---------------------------------------------------------------------------

const brokerServer = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: createBrokerFetch(ctx),
});

brokerLog(`listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);

// --- SIGHUP handler: hot-reload token + config + handler code ---

process.on("SIGHUP", async () => {
  brokerLog("Received SIGHUP — hot-reloading config, token, and handler code");
  rereadToken();

  // Re-read persistent config
  persistentConfig = loadConfig();
  brokerLog(`Config reloaded: federation=${persistentConfig.federation?.enabled ?? false}, remotes=${persistentConfig.federation?.remotes?.length ?? 0}`);

  // Hot-reload handler code from disk
  try {
    const fresh = await import(`./broker-handlers.ts?v=${Date.now()}`);
    brokerServer.reload({ fetch: fresh.createBrokerFetch(ctx) });
    brokerLog("Handler code hot-reloaded successfully");
  } catch (e) {
    brokerLog(`Handler reload FAILED (keeping previous handlers): ${e instanceof Error ? e.message : String(e)}`);
  }

  brokerLog("Hot-reload complete");
});

// --- Federation auto-reconnect ---

const MAX_AUTO_RECONNECT_ATTEMPTS = 20;

function autoReconnectRemote(host: string, port: number, label?: string) {
  const key = `${host}:${port}`;
  const delays = [0, 5000, 15000, 45000];
  let attemptNum = 0;

  async function attempt() {
    if (remoteMachines.has(key)) {
      federationLog(`Auto-reconnect to ${key}: already connected`);
      return;
    }

    try {
      const result = await handleFederationConnect(ctx, { host, port });
      if (result.ok) {
        federationLog(`Auto-reconnected to ${key} (${result.hostname ?? label ?? "unknown"}) on attempt ${attemptNum + 1}`);
        return;
      }
      federationLog(`Auto-reconnect to ${key} attempt ${attemptNum + 1}/${MAX_AUTO_RECONNECT_ATTEMPTS} failed: ${result.error}`);
    } catch (e) {
      federationLog(`Auto-reconnect to ${key} attempt ${attemptNum + 1}/${MAX_AUTO_RECONNECT_ATTEMPTS} error: ${e instanceof Error ? e.message : String(e)}`);
    }

    attemptNum++;
    if (attemptNum >= MAX_AUTO_RECONNECT_ATTEMPTS) {
      federationLog(`Auto-reconnect to ${key}: giving up after ${MAX_AUTO_RECONNECT_ATTEMPTS} attempts`);
      return;
    }

    const nextDelay = attemptNum < delays.length ? delays[attemptNum] : 60000;
    setTimeout(attempt, nextDelay);
  }

  attempt();
}

// --- Federation periodic peer sync ---

async function syncRemotePeers(): Promise<void> {
  if (!FEDERATION_ENABLED || remoteMachines.size === 0) return;

  const now = Date.now();

  for (const [key, remote] of remoteMachines) {
    try {
      const resp = await federationFetch<{ hostname: string; peers: Peer[] }>(
        `https://${remote.host}:${remote.port}/federation/peers`,
        {},
        ctx.token.current,
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

  for (const [key, remote] of remoteMachines) {
    const lastSyncAge = now - new Date(remote.last_sync).getTime();
    if (lastSyncAge > FEDERATION_STALE_TIMEOUT_MS) {
      federationLog(`Evicting stale remote ${remote.hostname} (${key}) — last sync ${Math.round(lastSyncAge / 1000)}s ago`);
      remoteMachines.delete(key);
    }
  }
}

// --- Federation TLS server startup ---

if (FEDERATION_ENABLED) {
  (async () => {
    try {
      federationHostname = getMachineHostname();
      ctx.federationHostname.current = federationHostname;

      const configuredSubnet =
        process.env.CLAUDE_PEERS_FEDERATION_SUBNET ||
        persistentConfig.federation?.subnet;
      if (configuredSubnet) {
        federationSubnet = configuredSubnet;
        ctx.federationSubnet.current = federationSubnet;
        const source = process.env.CLAUDE_PEERS_FEDERATION_SUBNET ? "env var" : "config file";
        federationLog(`Subnet restriction (${source}): ${federationSubnet}`);
        if (isWSL2() && configuredSubnet !== "0.0.0.0/0") {
          federationLog(`WARNING: Subnet restriction "${configuredSubnet}" on WSL2 may not work — Windows port forwarding rewrites source IPs. Consider using 0.0.0.0/0 and relying on PSK + TLS for security.`);
        }
      } else {
        federationSubnet = await detectSubnet();
        ctx.federationSubnet.current = federationSubnet;
        federationLog(`Subnet restriction (auto-detected): ${federationSubnet}`);
      }

      const { certPath, keyPath } = await ensureTlsCert();

      const federationServer = Bun.serve({
        port: FEDERATION_PORT,
        hostname: "0.0.0.0",
        tls: {
          cert: Bun.file(certPath),
          key: Bun.file(keyPath),
        },
        fetch: createFederationFetch(ctx),
      });

      federationLog(`Listening on 0.0.0.0:${FEDERATION_PORT} (TLS) — hostname: ${federationHostname}`);

      const federationSyncTimer = setInterval(async () => {
        try {
          await syncRemotePeers();
        } catch (err) {
          federationLog(`Sync error (non-fatal): ${err}`);
        }
      }, FEDERATION_SYNC_INTERVAL_MS);

      if (federationSyncTimer.unref) federationSyncTimer.unref();

      const savedRemotes = persistentConfig.federation?.remotes ?? [];
      if (savedRemotes.length > 0) {
        federationLog(`Auto-reconnecting to ${savedRemotes.length} saved remote(s)...`);
        for (const remote of savedRemotes) {
          autoReconnectRemote(remote.host, remote.port, remote.label);
        }
      }

      // mDNS auto-discovery
      const mdnsEnabled = process.env.CLAUDE_PEERS_MDNS_ENABLED !== "false" &&
        persistentConfig.federation?.mdns?.enabled !== false;
      if (mdnsEnabled) {
        try {
          const { MdnsManager } = await import("./mdns.ts");
          const mdnsManager = new MdnsManager({
            federationPort: FEDERATION_PORT,
            pskToken: ctx.token.current,
            localHostname: federationHostname,
            onPeerDiscovered: (host: string, port: number) => handleFederationConnect(ctx, { host, port }),
            remoteMachines,
          });
          const started = await mdnsManager.start();
          if (started) {
            process.on("SIGINT", () => mdnsManager.stop());
            process.on("SIGTERM", () => mdnsManager.stop());
          }
        } catch (e) {
          federationLog(`mDNS init failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        federationLog("mDNS: disabled via config or env var");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      federationLog(`Federation startup FAILED (broker continues without federation): ${msg}`);
    }
  })();
} else {
  brokerLog("Federation disabled (set CLAUDE_PEERS_FEDERATION_ENABLED=true to enable)");
}
