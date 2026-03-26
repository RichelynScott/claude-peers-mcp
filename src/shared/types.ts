// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

// Message type enum for semantic routing
export type MessageType = "text" | "query" | "response" | "handoff" | "broadcast";

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  session_name: string;
  summary: string;
  channel_push?: "unknown" | "unverified" | "working";
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  type: MessageType;
  metadata: Record<string, unknown> | null;
  reply_to: number | null;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  session_name: string;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface SetNameRequest {
  id: PeerId;
  session_name: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo" | "lan";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  type?: MessageType;
  metadata?: Record<string, unknown>;
  reply_to?: number;
}

export interface BroadcastRequest {
  from_id: PeerId;
  text: string;
  type?: MessageType;
  metadata?: Record<string, unknown>;
  scope: "machine" | "directory" | "repo" | "lan";
  cwd: string;
  git_root: string | null;
}

export interface BroadcastResponse {
  ok: boolean;
  recipients: number;
  message_ids: number[];
  error?: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface AckMessagesRequest {
  id: PeerId;
  message_ids: number[];
}

// --- Federation Types (Phase A: Manual LAN Federation) ---

export interface FederationConfig {
  enabled: boolean;
  port: number;
  subnet: string; // CIDR notation, e.g., "192.168.1.0/24"
  certPath: string;
  keyPath: string;
}

export interface RemotePeer {
  id: string;           // hostname:original_id
  machine: string;      // hostname or IP
  cwd: string;
  git_root: string | null;
  session_name: string;
  summary: string;
  last_seen: string;    // ISO timestamp
}

export interface RemoteMachine {
  host: string;
  port: number;
  hostname: string;
  peers: RemotePeer[];
  connected_at: string; // ISO timestamp
  last_sync: string;    // ISO timestamp
  source: "manual" | "mdns";
}

export interface MdnsStatus {
  state: "active" | "disabled";
  reason?: string;
  discovered_services: number;
  auto_connections: number;
}

export interface FederationHandshakeRequest {
  psk: string;
  hostname: string;
  version: string;
}

export interface FederationRelayRequest {
  from_id: string;      // hostname:peer_id
  from_machine: string;
  to_id: string;        // local peer_id or "*" for broadcast
  text: string;
  type?: string;
  metadata?: Record<string, unknown>;
  reply_to?: number;
  signature: string;    // HMAC-SHA256
}

export interface FederationPeersResponse {
  hostname: string;
  peers: Peer[];
}

export interface FederationConnectRequest {
  host: string;
  port: number;
}

export interface FederationStatusResponse {
  enabled: boolean;
  port: number;
  subnet: string;
  remotes: Array<{
    host: string;
    port: number;
    hostname: string;
    peer_count: number;
    connected_at: string;
    last_sync: string;
  }>;
  total_remote_peers: number;
}

// --- Broker Context (for hot-reload handler separation) ---

/**
 * All prepared statements used by broker handlers.
 * Owned by broker.ts, passed to handlers via BrokerContext.
 */
export interface BrokerStatements {
  insertPeer: import("bun:sqlite").Statement;
  updateLastSeen: import("bun:sqlite").Statement;
  updateSummary: import("bun:sqlite").Statement;
  updateName: import("bun:sqlite").Statement;
  updateChannelPush: import("bun:sqlite").Statement;
  deletePeer: import("bun:sqlite").Statement;
  selectAllPeers: import("bun:sqlite").Statement;
  selectPeersByDirectory: import("bun:sqlite").Statement;
  selectPeersByGitRoot: import("bun:sqlite").Statement;
  insertMessage: import("bun:sqlite").Statement;
  selectUndelivered: import("bun:sqlite").Statement;
  selectMessageExists: import("bun:sqlite").Statement;
  markDelivered: import("bun:sqlite").Statement;
}

/**
 * Shared broker state — owned by broker.ts, passed by reference to handler factories.
 * Mutable scalars are wrapped in objects for pass-by-reference semantics.
 * Maps and db survive handler reloads because they're the same object reference.
 */
export interface BrokerContext {
  db: import("bun:sqlite").Database;
  stmts: BrokerStatements;
  /** Mutable token ref — re-read on SIGHUP */
  token: { current: string };
  /** Federation remote machines — in-memory, auto-reconnects from config */
  remoteMachines: Map<string, RemoteMachine>;
  /** Per-IP rate limit state */
  rateLimits: Map<string, { count: number; resetAt: number }>;
  /** Request counters for /health endpoint */
  counters: { requestsThisMinute: number; requestsLastMinute: number };
  /** Broker start time (epoch ms) for uptime calculation */
  startTime: number;
  // --- Config (read from context, not import-time frozen) ---
  federationEnabled: boolean;
  federationPort: number;
  /** Mutable — updated on SIGHUP config reload */
  federationHostname: { current: string };
  /** Mutable — updated on SIGHUP config reload */
  federationSubnet: { current: string };
  port: number;
  // --- Utility functions ---
  brokerLog: (msg: string) => void;
  isValidToken: (provided: string, expected: string) => boolean;
}
