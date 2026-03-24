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
  scope: "machine" | "directory" | "repo";
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
  scope: "machine" | "directory" | "repo";
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
