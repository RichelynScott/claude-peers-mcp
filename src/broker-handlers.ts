/**
 * Broker request handlers — separated from state for hot-reload support.
 *
 * broker.ts owns all state (db, prepared statements, config, runtime maps).
 * This file exports factory functions that create fetch handlers from that state.
 * On SIGHUP, broker.ts re-imports this file and calls server.reload() to swap
 * the fetch handler without dropping connections or losing state.
 */

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
  MessageType,
  RemoteMachine,
  RemotePeer,
  FederationHandshakeRequest,
  FederationRelayRequest,
  FederationPeersResponse,
  FederationConnectRequest,
  FederationStatusResponse,
  BrokerContext,
} from "./shared/types.ts";
import {
  signMessage,
  verifySignature,
  ipInSubnet,
  federationLog,
  federationFetch,
} from "./federation.ts";
import { addRemoteToConfig, removeRemoteFromConfig } from "./shared/config.ts";

// ---------------------------------------------------------------------------
// Handler functions — pure logic, all state from ctx
// ---------------------------------------------------------------------------

const VALID_MESSAGE_TYPES = new Set<string>(["text", "query", "response", "handoff", "broadcast"]);

function generateRandomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateId(tty: string | null): string {
  if (tty) {
    const hash = require("crypto").createHash("sha256").update(tty).digest("hex");
    return hash.slice(0, 8);
  }
  return generateRandomId();
}

function handleRegister(ctx: BrokerContext, body: RegisterRequest): RegisterResponse {
  const id = generateId(body.tty ?? null);
  const now = new Date().toISOString();

  let sessionName = body.session_name ?? "";
  let summary = body.summary ?? "";

  const existingById = ctx.db.query("SELECT id, session_name, summary FROM peers WHERE id = ?").get(id) as { id: string; session_name: string; summary: string } | null;
  if (existingById) {
    if (!sessionName && existingById.session_name) sessionName = existingById.session_name;
    if (!summary && existingById.summary) summary = existingById.summary;
    ctx.stmts.deletePeer.run(existingById.id);
    ctx.brokerLog(`Re-registering peer ${id} (same TTY ${body.tty}, PID ${body.pid})`);
  }

  const existingByPid = ctx.db.query("SELECT id, session_name, summary FROM peers WHERE pid = ? AND id != ?").get(body.pid, id) as { id: string; session_name: string; summary: string } | null;
  if (existingByPid) {
    if (!sessionName && existingByPid.session_name) sessionName = existingByPid.session_name;
    if (!summary && existingByPid.summary) summary = existingByPid.summary;
    ctx.stmts.deletePeer.run(existingByPid.id);
  }

  if (body.tty) {
    const existingByTty = ctx.db.query("SELECT id, session_name, summary FROM peers WHERE tty = ? AND pid != ? AND id != ?").all(body.tty, body.pid, id) as Array<{ id: string; session_name: string; summary: string }>;
    for (const stale of existingByTty) {
      if (!sessionName && stale.session_name) sessionName = stale.session_name;
      if (!summary && stale.summary) summary = stale.summary;
      ctx.brokerLog(`Evicting stale peer ${stale.id} (same TTY ${body.tty}, replaced by PID ${body.pid})`);
      ctx.stmts.deletePeer.run(stale.id);
    }
  }

  ctx.stmts.insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, sessionName, summary, now, now);
  return { id, session_name: sessionName || undefined };
}

function handleListPeers(ctx: BrokerContext, body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = ctx.stmts.selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = ctx.stmts.selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = ctx.stmts.selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        peers = ctx.stmts.selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    case "lan":
      peers = ctx.stmts.selectAllPeers.all() as Peer[];
      break;
    default:
      peers = ctx.stmts.selectAllPeers.all() as Peer[];
  }

  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  peers = peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      ctx.stmts.deletePeer.run(p.id);
      return false;
    }
  });

  if (body.scope === "lan" && ctx.federationEnabled) {
    for (const remote of ctx.remoteMachines.values()) {
      for (const rp of remote.peers) {
        const asPeer: Peer = {
          id: rp.id,
          pid: 0,
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

function handleSendMessage(ctx: BrokerContext, body: SendMessageRequest): { ok: boolean; error?: string; message_id?: number } {
  const type: MessageType = (body.type ?? "text") as MessageType;
  if (!VALID_MESSAGE_TYPES.has(type)) {
    return { ok: false, error: `Invalid message type: "${body.type}". Valid types: text, query, response, handoff, broadcast` };
  }

  let metadataStr: string | null = null;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
      return { ok: false, error: "metadata must be a JSON object" };
    }
    metadataStr = JSON.stringify(body.metadata);
  }

  const totalSize = body.text.length + (metadataStr?.length ?? 0);
  if (totalSize > 10240) {
    return { ok: false, error: "Message too large (text + metadata max 10KB)" };
  }

  if (body.reply_to !== undefined && body.reply_to !== null) {
    const referenced = ctx.stmts.selectMessageExists.get(body.reply_to) as { id: number } | null;
    if (!referenced) {
      return { ok: false, error: `Referenced message ${body.reply_to} not found` };
    }
  }

  const target = ctx.db.query("SELECT id, pid FROM peers WHERE id = ?").get(body.to_id) as { id: string; pid: number } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found. Run list_peers to see available peers, or the peer may have disconnected.` };
  }

  try {
    process.kill(target.pid, 0);
  } catch {
    ctx.stmts.deletePeer.run(target.id);
    return { ok: false, error: `Peer ${body.to_id} is not running (PID ${target.pid} dead)` };
  }

  const result = ctx.stmts.insertMessage.run(
    body.from_id, body.to_id, body.text, type,
    metadataStr, body.reply_to ?? null, new Date().toISOString()
  );
  return { ok: true, message_id: Number(result.lastInsertRowid) };
}

async function handleFederationSendToRemote(ctx: BrokerContext, body: {
  to_id: string; from_id: string; text: string;
  type?: string; metadata?: Record<string, unknown>; reply_to?: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.federationEnabled) {
    return { ok: false, error: "Federation is not enabled. Enable with: CLAUDE_PEERS_FEDERATION_ENABLED=true or run `bun src/cli.ts federation init`" };
  }

  const { to_id, from_id, text, type, metadata, reply_to } = body;
  const colonIdx = to_id.indexOf(":");
  if (colonIdx === -1) {
    return { ok: false, error: `Invalid remote peer ID "${to_id}" — expected "hostname:peer_id" format` };
  }

  const targetHostname = to_id.slice(0, colonIdx);
  let targetMachine: RemoteMachine | undefined;
  for (const rm of ctx.remoteMachines.values()) {
    if (rm.hostname === targetHostname) {
      targetMachine = rm;
      break;
    }
  }

  if (!targetMachine) {
    return { ok: false, error: `No federation connection to machine "${targetHostname}"` };
  }

  const relayBody: Record<string, unknown> = {
    from_id: `${ctx.federationHostname.current}:${from_id}`,
    from_machine: ctx.federationHostname.current,
    to_id: to_id.slice(colonIdx + 1),
    text,
    type: type ?? "text",
    metadata: metadata ?? null,
    reply_to: reply_to ?? null,
  };

  const signature = signMessage(relayBody, ctx.token.current);

  try {
    const resp = await federationFetch<{ ok?: boolean; error?: string }>(
      `https://${targetMachine.host}:${targetMachine.port}/federation/relay`,
      { ...relayBody, signature },
      ctx.token.current,
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

async function handleBroadcast(ctx: BrokerContext, body: BroadcastRequest): Promise<BroadcastResponse> {
  const type: MessageType = (body.type ?? "broadcast") as MessageType;
  if (!VALID_MESSAGE_TYPES.has(type)) {
    return { ok: false, recipients: 0, message_ids: [], error: `Invalid message type: ${body.type}` };
  }

  let metadataStr: string | null = null;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
      return { ok: false, recipients: 0, message_ids: [], error: "metadata must be a JSON object" };
    }
    metadataStr = JSON.stringify(body.metadata);
  }

  const totalSize = body.text.length + (metadataStr?.length ?? 0);
  if (totalSize > 10240) {
    return { ok: false, recipients: 0, message_ids: [], error: "Message too large (text + metadata max 10KB)" };
  }

  const peers = handleListPeers(ctx, {
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

  const localPeers = peers.filter((p) => !p.id.includes(":"));
  const remotePeers = peers.filter((p) => p.id.includes(":"));

  if (localPeers.length > 0) {
    const insertAll = ctx.db.transaction(() => {
      for (const peer of localPeers) {
        const result = ctx.stmts.insertMessage.run(
          body.from_id, peer.id, body.text, type,
          metadataStr, null, now
        );
        messageIds.push(Number(result.lastInsertRowid));
      }
    });
    insertAll();
  }

  if (remotePeers.length > 0 && ctx.federationEnabled) {
    const relayPromises = remotePeers.map(async (peer) => {
      try {
        const result = await handleFederationSendToRemote(ctx, {
          to_id: peer.id,
          from_id: body.from_id,
          text: body.text,
          type,
          metadata: body.metadata as Record<string, unknown> | undefined,
        });
        if (result.ok) {
          messageIds.push(-1);
        } else {
          ctx.brokerLog(`broadcast relay to ${peer.id} failed: ${result.error}`);
        }
      } catch (err) {
        ctx.brokerLog(`broadcast relay to ${peer.id} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    await Promise.allSettled(relayPromises);
  }

  const totalRecipients = localPeers.length + remotePeers.length;
  ctx.brokerLog(`broadcast from ${body.from_id} to ${totalRecipients} peer(s) in scope ${body.scope} (${localPeers.length} local, ${remotePeers.length} remote)`);
  return { ok: true, recipients: totalRecipients, message_ids: messageIds };
}

function handlePollMessages(ctx: BrokerContext, body: PollMessagesRequest): PollMessagesResponse {
  const rows = ctx.stmts.selectUndelivered.all(body.id) as Array<Record<string, unknown>>;
  const messages: Message[] = rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    reply_to: row.reply_to as number | null,
    type: (row.type as MessageType) ?? "text",
  })) as Message[];
  return { messages };
}

function handleAckMessages(ctx: BrokerContext, body: AckMessagesRequest): void {
  for (const mid of body.message_ids) {
    ctx.stmts.markDelivered.run(mid, body.id);
  }
}

function handleFederationStatus(ctx: BrokerContext): FederationStatusResponse {
  if (!ctx.federationEnabled) {
    return { enabled: false, port: ctx.federationPort, subnet: "", remotes: [], total_remote_peers: 0 };
  }

  const remotes: FederationStatusResponse["remotes"] = [];
  let totalRemotePeers = 0;
  for (const rm of ctx.remoteMachines.values()) {
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
    port: ctx.federationPort,
    subnet: ctx.federationSubnet.current,
    remotes,
    total_remote_peers: totalRemotePeers,
  };
}

export function handleFederationConnect(ctx: BrokerContext, body: FederationConnectRequest): Promise<{ ok: boolean; hostname?: string; error?: string }> {
  return _handleFederationConnect(ctx, body);
}

async function _handleFederationConnect(ctx: BrokerContext, body: FederationConnectRequest): Promise<{ ok: boolean; hostname?: string; error?: string }> {
  if (!ctx.federationEnabled) {
    return { ok: false, error: "Federation is not enabled. Enable with: CLAUDE_PEERS_FEDERATION_ENABLED=true or run `bun src/cli.ts federation init`" };
  }

  const { host, port } = body;
  const key = `${host}:${port}`;

  if (ctx.remoteMachines.has(key)) {
    return { ok: true, hostname: ctx.remoteMachines.get(key)!.hostname };
  }

  try {
    const handshakeResult = await federationFetch<{ hostname: string; version: string; error?: string }>(
      `https://${host}:${port}/federation/handshake`,
      {
        psk: ctx.token.current,
        hostname: ctx.federationHostname.current,
        version: "1.0.0",
      } satisfies FederationHandshakeRequest,
      ctx.token.current,
    );

    if (!handshakeResult.ok) {
      const errMsg = (handshakeResult.data as { error?: string })?.error ?? "unknown";
      return { ok: false, error: `Handshake failed (${handshakeResult.status}): ${errMsg}` };
    }

    const result = handshakeResult.data;

    const peersResult = await federationFetch<FederationPeersResponse>(
      `https://${host}:${port}/federation/peers`,
      {},
      ctx.token.current,
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
    ctx.remoteMachines.set(key, {
      host,
      port,
      hostname: result.hostname,
      peers: remotePeers,
      connected_at: now,
      last_sync: now,
      source: "manual",
    });

    federationLog(`Connected to ${result.hostname} at ${host}:${port} (${remotePeers.length} peers)`);

    try {
      addRemoteToConfig({ host, port, label: result.hostname });
    } catch {}

    return { ok: true, hostname: result.hostname };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    federationLog(`Failed to connect to ${host}:${port}: ${msg}`);
    return { ok: false, error: msg };
  }
}

function handleFederationDisconnect(ctx: BrokerContext, body: { host: string; port: number }): { ok: boolean; error?: string } {
  if (!ctx.federationEnabled) {
    return { ok: false, error: "Federation is not enabled. Enable with: CLAUDE_PEERS_FEDERATION_ENABLED=true or run `bun src/cli.ts federation init`" };
  }

  const key = `${body.host}:${body.port}`;
  if (!ctx.remoteMachines.has(key)) {
    return { ok: false, error: `Not connected to ${key}` };
  }

  const rm = ctx.remoteMachines.get(key)!;
  ctx.remoteMachines.delete(key);
  federationLog(`Disconnected from ${rm.hostname} at ${key}`);

  try {
    removeRemoteFromConfig(body.host, body.port);
  } catch {}

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Factory: create the broker HTTP fetch handler
// ---------------------------------------------------------------------------

export function createBrokerFetch(ctx: BrokerContext): (req: Request) => Response | Promise<Response> {
  return async (req: Request) => {
    ctx.counters.requestsThisMinute++;
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      const pendingCount = (ctx.db.query("SELECT COUNT(*) as cnt FROM messages WHERE delivered = 0").get() as { cnt: number }).cnt;
      return Response.json({
        status: "ok",
        peers: (ctx.stmts.selectAllPeers.all() as Peer[]).length,
        uptime_ms: Date.now() - ctx.startTime,
        requests_last_minute: ctx.counters.requestsLastMinute,
        pending_messages: pendingCount,
      });
    }

    if (req.method === "POST") {
      const authHeader = req.headers.get("authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const providedToken = authHeader.slice(7);
      if (!ctx.isValidToken(providedToken, ctx.token.current)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    if ((path === "/send-message" || path === "/broadcast") && req.method === "POST") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";
      const now = Date.now();
      const limit = ctx.rateLimits.get(ip);
      if (limit && now < limit.resetAt) {
        limit.count++;
        if (limit.count > 60) {
          return new Response(JSON.stringify({ error: "Rate limited" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
      } else {
        ctx.rateLimits.set(ip, { count: 1, resetAt: now + 60_000 });
      }
    }

    if (req.method === "GET" && path === "/federation/status") {
      return Response.json(handleFederationStatus(ctx));
    }

    if (req.method !== "POST") {
      return new Response("claude-peers broker", { status: 200 });
    }

    if (path === "/heartbeat" || path === "/poll-messages") {
      await new Promise(r => setTimeout(r, 0));
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(ctx, body as RegisterRequest));
        case "/heartbeat":
          ctx.stmts.updateLastSeen.run(new Date().toISOString(), (body as HeartbeatRequest).id);
          return Response.json({ ok: true });
        case "/set-summary":
          ctx.stmts.updateSummary.run((body as SetSummaryRequest).summary, (body as SetSummaryRequest).id);
          return Response.json({ ok: true });
        case "/set-name":
          ctx.stmts.updateName.run((body as SetNameRequest).session_name, (body as SetNameRequest).id);
          return Response.json({ ok: true });
        case "/set-channel-push": {
          const { id, status } = body as { id: string; status: string };
          if (["unknown", "unverified", "working"].includes(status)) {
            ctx.stmts.updateChannelPush.run(status, id);
          }
          return Response.json({ ok: true });
        }
        case "/list-peers":
          return Response.json(handleListPeers(ctx, body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(ctx, body as SendMessageRequest));
        case "/broadcast":
          return Response.json(await handleBroadcast(ctx, body as BroadcastRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(ctx, body as PollMessagesRequest));
        case "/ack-messages":
          handleAckMessages(ctx, body as AckMessagesRequest);
          return Response.json({ ok: true });
        case "/message-status": {
          const { message_id } = body as { message_id: number };
          const msg = ctx.db.query("SELECT id, from_id, to_id, delivered, sent_at FROM messages WHERE id = ?").get(message_id) as { id: number; from_id: string; to_id: string; delivered: number; sent_at: string } | null;
          if (!msg) return Response.json({ error: "not found" }, { status: 404 });
          return Response.json({ id: msg.id, from_id: msg.from_id, to_id: msg.to_id, delivered: !!msg.delivered, sent_at: msg.sent_at });
        }
        case "/unregister":
          ctx.stmts.deletePeer.run((body as { id: string }).id);
          return Response.json({ ok: true });

        // Federation local-facing endpoints (status is GET-only, handled above)
        case "/federation/connect":
          return Response.json(await handleFederationConnect(ctx, body as FederationConnectRequest));
        case "/federation/disconnect":
          return Response.json(handleFederationDisconnect(ctx, body as { host: string; port: number }));
        case "/federation/send-to-remote":
          return Response.json(await handleFederationSendToRemote(ctx, body as {
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
  };
}

// ---------------------------------------------------------------------------
// Factory: create the federation TLS fetch handler
// ---------------------------------------------------------------------------

export function createFederationFetch(ctx: BrokerContext): (req: Request, server: any) => Response | Promise<Response> {
  return async (req: Request, server: any) => {
    const url = new URL(req.url);
    const path = url.pathname;

    const socketAddr = server.requestIP(req);
    const remoteIp = socketAddr?.address ?? "0.0.0.0";
    const cleanIp = remoteIp.startsWith("::ffff:") ? remoteIp.slice(7) : remoteIp;

    if (!ipInSubnet(cleanIp, ctx.federationSubnet.current)) {
      federationLog(`Rejected connection from ${cleanIp} — outside subnet ${ctx.federationSubnet.current}`);
      return Response.json({ error: `Connection rejected: ${cleanIp} is outside allowed subnet ${ctx.federationSubnet.current}. Update CLAUDE_PEERS_FEDERATION_SUBNET or config file.` }, { status: 403 });
    }

    if (path === "/health") {
      return Response.json({ status: "ok", federation: true, hostname: ctx.federationHostname.current });
    }

    if (req.method !== "POST") {
      return new Response("claude-peers federation agent", { status: 200 });
    }

    const psk = req.headers.get("x-claude-peers-psk");
    if (!psk || !ctx.isValidToken(psk, ctx.token.current)) {
      federationLog(`PSK mismatch from ${cleanIp}`);
      return Response.json({ error: "PSK mismatch — ensure both machines share the same ~/.claude-peers-token file" }, { status: 403 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/federation/handshake": {
          const hsReq = body as FederationHandshakeRequest;
          if (!hsReq.psk || !ctx.isValidToken(hsReq.psk, ctx.token.current)) {
            return Response.json({ error: "PSK mismatch — ensure both machines share the same ~/.claude-peers-token file" }, { status: 403 });
          }
          federationLog(`Handshake from ${hsReq.hostname} (v${hsReq.version}) at ${cleanIp}`);
          return Response.json({ hostname: ctx.federationHostname.current, version: "1.0.0" });
        }

        case "/federation/peers": {
          const localPeers = handleListPeers(ctx, { scope: "machine", cwd: "", git_root: null });
          const resp: FederationPeersResponse = {
            hostname: ctx.federationHostname.current,
            peers: localPeers,
          };
          return Response.json(resp);
        }

        case "/federation/relay": {
          const relayReq = body as FederationRelayRequest;

          const { signature, ...bodyWithoutSig } = relayReq;
          if (!signature || !verifySignature(bodyWithoutSig as Record<string, unknown>, signature, ctx.token.current)) {
            federationLog(`Invalid HMAC signature on relay from ${relayReq.from_machine}`);
            return Response.json({ error: "Invalid HMAC signature" }, { status: 403 });
          }

          const target = ctx.db.query("SELECT id, pid FROM peers WHERE id = ?").get(relayReq.to_id) as { id: string; pid: number } | null;
          if (!target) {
            return Response.json({ ok: false, error: `Peer ${relayReq.to_id} not found locally` }, { status: 404 });
          }

          const isRemoteFrom = relayReq.from_id.includes(":");
          if (!isRemoteFrom) {
            try { process.kill(target.pid, 0); } catch {
              ctx.stmts.deletePeer.run(target.id);
              return Response.json({ ok: false, error: `Peer ${relayReq.to_id} is not running` }, { status: 410 });
            }
          }

          const msgType = VALID_MESSAGE_TYPES.has(relayReq.type ?? "text") ? (relayReq.type ?? "text") : "text";
          let metadataStr: string | null = null;
          if (relayReq.metadata != null) {
            if (typeof relayReq.metadata !== "object" || Array.isArray(relayReq.metadata)) {
              return Response.json({ ok: false, error: "metadata must be a JSON object" }, { status: 400 });
            }
            metadataStr = JSON.stringify(relayReq.metadata);
          }
          const totalSize = (relayReq.text?.length ?? 0) + (metadataStr?.length ?? 0);
          if (totalSize > 10240) {
            return Response.json({ ok: false, error: "Message too large (text + metadata max 10KB)" }, { status: 400 });
          }
          const result = ctx.stmts.insertMessage.run(
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
  };
}
