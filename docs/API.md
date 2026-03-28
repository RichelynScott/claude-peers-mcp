# API Reference

Complete HTTP endpoint reference for the claude-peers broker daemon.

The broker exposes two servers:

- **Broker HTTP server** on `localhost:7899` -- local peer management and messaging.
- **Federation TLS server** on `0.0.0.0:7900` -- cross-machine peer sync and message relay.

## Authentication

| Server | Auth Mechanism | Header |
|--------|---------------|--------|
| Broker (POST endpoints) | Bearer token | `Authorization: Bearer <token>` |
| Broker (GET endpoints) | None | -- |
| Federation (all POST) | Pre-shared key | `X-Claude-Peers-PSK: <token>` |
| Federation (GET /health) | Subnet check only | -- |

The token is stored at `~/.claude-peers-token` (auto-generated, 64 hex chars, `0o600` permissions).

---

## Broker Endpoints (localhost:7899)

### GET /health

**Auth**: None
**Description**: Health check. Returns broker status, peer count, uptime, and pending message count.

**Response**:

```json
{
  "status": "ok",
  "peers": 3,
  "uptime_ms": 3600000,
  "requests_last_minute": 42,
  "pending_messages": 2
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Always `"ok"` |
| `peers` | number | Count of registered peers (includes stale until next cleanup) |
| `uptime_ms` | number | Milliseconds since broker started |
| `requests_last_minute` | number | Total requests handled in the previous 60-second window |
| `pending_messages` | number | Count of undelivered messages (`delivered = 0`) |

---

### POST /register

**Auth**: Bearer token
**Description**: Register a new peer or re-register an existing one. Handles TTY-based deduplication -- if a peer with the same TTY or PID already exists, the old entry is evicted and its session name/summary are preserved.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pid` | number | yes | OS process ID of the MCP server |
| `cwd` | string | yes | Working directory of the Claude Code session |
| `git_root` | string \| null | yes | Git repository root, or null |
| `tty` | string \| null | yes | Terminal device (e.g., `pts/44`), or null |
| `session_name` | string | no | Human-readable session name |
| `summary` | string | no | Work summary |
| `version` | string | no | CPM version string (e.g., `0.7.0`) |

**Response**:

```json
{
  "id": "a1b2c3d4",
  "session_name": "AUTH_WORKER"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | 8-character peer ID (SHA-256 of TTY, or random if no TTY) |
| `session_name` | string \| undefined | Restored session name if re-registering |

---

### POST /heartbeat

**Auth**: Bearer token
**Description**: Update the `last_seen` timestamp for a peer. Called every 15 seconds by the MCP server.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Peer ID |

**Response**:

```json
{ "ok": true }
```

---

### POST /set-summary

**Auth**: Bearer token
**Description**: Update a peer's work summary, visible to other peers in discovery.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Peer ID |
| `summary` | string | yes | New summary text |

**Response**:

```json
{ "ok": true }
```

---

### POST /set-name

**Auth**: Bearer token
**Description**: Update a peer's session name (e.g., from `/rename`).

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Peer ID |
| `session_name` | string | yes | New session name |

**Response**:

```json
{ "ok": true }
```

---

### POST /set-channel-push

**Auth**: Bearer token
**Description**: Update a peer's channel push status indicator.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Peer ID |
| `status` | string | yes | One of: `"unknown"`, `"unverified"`, `"working"` |

**Response**:

```json
{ "ok": true }
```

---

### POST /list-peers

**Auth**: Bearer token
**Description**: List peers filtered by scope. Dead peers (PID check fails) are automatically cleaned during listing.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scope` | string | yes | `"machine"`, `"directory"`, `"repo"`, or `"lan"` |
| `cwd` | string | yes | Requesting peer's working directory (used for directory/repo filtering) |
| `git_root` | string \| null | no | Requesting peer's git root (used for repo scope) |
| `exclude_id` | string | no | Peer ID to exclude from results (typically the requester) |

**Scope behavior**:

| Scope | Returns |
|-------|---------|
| `machine` | All local peers |
| `directory` | Peers in the same `cwd` |
| `repo` | Peers in the same `git_root` (falls back to `cwd` if no git root) |
| `lan` | All local peers + peers from federated remote machines |

**Response**: Array of `Peer` objects.

```json
[
  {
    "id": "a1b2c3d4",
    "pid": 12345,
    "cwd": "/home/user/project",
    "git_root": "/home/user/project",
    "tty": "pts/44",
    "session_name": "AUTH_WORKER",
    "summary": "[AUTH_WORKER:pts/44] implementing JWT refresh in auth.ts",
    "version": "0.7.0",
    "channel_push": "working",
    "registered_at": "2026-03-27T10:00:00.000Z",
    "last_seen": "2026-03-27T12:30:00.000Z"
  }
]
```

---

### POST /send-message

**Auth**: Bearer token
**Rate Limited**: 60 requests/minute per IP
**Description**: Send a message to a specific peer. Validates the target peer exists and is alive (PID check). Returns the message ID for tracking.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from_id` | string | yes | Sender peer ID |
| `to_id` | string | yes | Recipient peer ID |
| `text` | string | yes | Message content |
| `type` | string | no | Message type: `"text"` (default), `"query"`, `"response"`, `"handoff"`, `"broadcast"` |
| `metadata` | object | no | JSON object with structured data (max 10KB combined with text) |
| `reply_to` | number | no | Message ID to reply to (must exist) |

**Validation rules**:

- `type` must be one of: `text`, `query`, `response`, `handoff`, `broadcast`
- `metadata` must be a plain object (not an array)
- Combined size of `text` + serialized `metadata` must be <= 10KB
- `reply_to` message must exist in the database
- Target peer must exist and have a live PID

**Response (success)**:

```json
{
  "ok": true,
  "message_id": 42
}
```

**Response (error)**:

```json
{
  "ok": false,
  "error": "Peer abc123de not found. Run list_peers to see available peers, or the peer may have disconnected."
}
```

---

### POST /broadcast

**Auth**: Bearer token
**Rate Limited**: 60 requests/minute per IP
**Description**: Send a message to all peers in a scope (excluding the sender). Handles both local and remote (federated) peers.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from_id` | string | yes | Sender peer ID |
| `text` | string | yes | Message content |
| `type` | string | no | Message type (default: `"broadcast"`) |
| `metadata` | object | no | JSON metadata object |
| `scope` | string | yes | `"machine"`, `"directory"`, `"repo"`, or `"lan"` |
| `cwd` | string | yes | Sender's working directory |
| `git_root` | string \| null | yes | Sender's git root |

**Response**:

```json
{
  "ok": true,
  "recipients": 4,
  "message_ids": [43, 44, 45, -1]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Whether the broadcast was processed |
| `recipients` | number | Total recipients (local + remote) |
| `message_ids` | number[] | IDs of inserted messages. `-1` for remote relays. |
| `error` | string \| undefined | Error message if broadcast failed |

---

### POST /poll-messages

**Auth**: Bearer token
**Description**: Retrieve all undelivered messages for a peer, ordered by `sent_at` ascending.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Peer ID to poll messages for |

**Response**:

```json
{
  "messages": [
    {
      "id": 42,
      "from_id": "a1b2c3d4",
      "to_id": "e5f6g7h8",
      "text": "Hello from session A",
      "type": "text",
      "metadata": null,
      "reply_to": null,
      "sent_at": "2026-03-27T12:00:00.000Z",
      "delivered": 0
    }
  ]
}
```

---

### POST /ack-messages

**Auth**: Bearer token
**Description**: Mark messages as delivered. Scoped by `to_id` -- peers can only acknowledge their own messages.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Peer ID (must match `to_id` on messages) |
| `message_ids` | number[] | yes | Array of message IDs to acknowledge |

**Response**:

```json
{ "ok": true }
```

---

### POST /message-status

**Auth**: Bearer token
**Description**: Check the delivery status of a specific message.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message_id` | number | yes | Message ID to check |

**Response (found)**:

```json
{
  "id": 42,
  "from_id": "a1b2c3d4",
  "to_id": "e5f6g7h8",
  "delivered": true,
  "sent_at": "2026-03-27T12:00:00.000Z"
}
```

**Response (not found)**: `404` with `{"error": "not found"}`

---

### POST /unregister

**Auth**: Bearer token
**Description**: Remove a peer from the registry.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Peer ID to unregister |

**Response**:

```json
{ "ok": true }
```

---

### GET /federation/status

**Auth**: None
**Description**: Returns the current federation state including connected remotes and total remote peer count.

**Response (federation disabled)**:

```json
{
  "enabled": false,
  "port": 7900,
  "subnet": "",
  "remotes": [],
  "total_remote_peers": 0
}
```

**Response (federation enabled)**:

```json
{
  "enabled": true,
  "port": 7900,
  "subnet": "192.168.1.0/24",
  "remotes": [
    {
      "host": "192.168.1.42",
      "port": 7900,
      "hostname": "rafi-macbook",
      "peer_count": 2,
      "connected_at": "2026-03-27T10:00:00.000Z",
      "last_sync": "2026-03-27T12:29:30.000Z"
    }
  ],
  "total_remote_peers": 2
}
```

---

### POST /federation/connect

**Auth**: Bearer token
**Description**: Initiate a federation connection to a remote broker. Performs TLS handshake with PSK, fetches remote peers, and persists the connection to the config file.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Remote host IP or hostname |
| `port` | number | yes | Remote federation port (typically 7900) |

**Response (success)**:

```json
{
  "ok": true,
  "hostname": "rafi-macbook"
}
```

**Response (error)**:

```json
{
  "ok": false,
  "error": "Handshake failed (403): PSK mismatch"
}
```

---

### POST /federation/disconnect

**Auth**: Bearer token
**Description**: Disconnect from a remote broker and remove it from the config file.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Remote host IP or hostname |
| `port` | number | yes | Remote federation port |

**Response**:

```json
{ "ok": true }
```

---

### POST /federation/send-to-remote

**Auth**: Bearer token
**Description**: Relay a message to a peer on a remote machine. The broker looks up the federation connection by hostname (extracted from the `to_id` prefix), signs the request with HMAC, and forwards via TLS.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to_id` | string | yes | Remote peer ID in `hostname:peer_id` format |
| `from_id` | string | yes | Local sender peer ID |
| `text` | string | yes | Message content |
| `type` | string | no | Message type (default: `"text"`) |
| `metadata` | object | no | JSON metadata |
| `reply_to` | number | no | Message ID for threading |

**Response**:

```json
{ "ok": true }
```

---

## Federation Endpoints (0.0.0.0:7900, TLS)

These endpoints are served by the federation TLS server, accessible from the LAN. All requests are subject to **subnet filtering** -- connections from outside the configured CIDR range are rejected with 403.

### GET /health

**Auth**: Subnet check (no PSK)
**Description**: Federation health check.

**Response**:

```json
{
  "status": "ok",
  "federation": true,
  "hostname": "riche-wsl2"
}
```

---

### POST /federation/handshake

**Auth**: Subnet + PSK (both header and body)
**Description**: Federation handshake. Verifies PSK match and exchanges hostnames. This is the first step when establishing a federation connection.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `psk` | string | yes | Pre-shared key (must match local token) |
| `hostname` | string | yes | Requesting machine's hostname |
| `version` | string | yes | Protocol version (currently `"1.0.0"`) |

**Response (success)**:

```json
{
  "hostname": "riche-wsl2",
  "version": "1.0.0"
}
```

**Response (PSK mismatch)**: `403` with `{"error": "PSK mismatch -- ensure both machines share the same ~/.claude-peers-token file"}`

---

### POST /federation/peers

**Auth**: Subnet + PSK
**Description**: Returns all local peers for the requesting machine to cache. Called during initial connection and periodically (every 30s) for peer sync.

**Request Body**: `{}` (empty object)

**Response**:

```json
{
  "hostname": "riche-wsl2",
  "peers": [
    {
      "id": "a1b2c3d4",
      "pid": 12345,
      "cwd": "/home/user/project",
      "git_root": "/home/user/project",
      "tty": "pts/44",
      "session_name": "AUTH_WORKER",
      "summary": "[AUTH_WORKER:pts/44] working on auth module",
      "registered_at": "2026-03-27T10:00:00.000Z",
      "last_seen": "2026-03-27T12:30:00.000Z"
    }
  ]
}
```

---

### POST /federation/relay

**Auth**: Subnet + PSK + HMAC signature
**Description**: Relay a message from a remote machine to a local peer. Validates the HMAC signature over the canonicalized request body, verifies the target peer exists locally, and inserts the message into SQLite for delivery.

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from_id` | string | yes | Sender ID in `hostname:peer_id` format |
| `from_machine` | string | yes | Sender's machine hostname |
| `to_id` | string | yes | Local recipient peer ID (without hostname prefix) |
| `text` | string | yes | Message content |
| `type` | string | no | Message type (default: `"text"`) |
| `metadata` | object | no | JSON metadata (must be plain object, not array) |
| `reply_to` | number | no | Message ID for threading |
| `signature` | string | yes | HMAC-SHA256 hex digest of canonicalized body |

**Validation rules** (same as local `/send-message`):

- `metadata` must be a plain object if provided
- Combined `text` + `metadata` size <= 10KB
- `type` validated against allowed set

**Response (success)**:

```json
{
  "ok": true,
  "message_id": 99
}
```

**Response (target not found)**: `404` with `{"ok": false, "error": "Peer abc123de not found locally"}`
**Response (target dead)**: `410` with `{"ok": false, "error": "Peer abc123de is not running"}`
**Response (bad signature)**: `403` with `{"error": "Invalid HMAC signature"}`

---

## Error Responses

All endpoints return errors in a consistent format:

| HTTP Status | Meaning | Example |
|-------------|---------|---------|
| `401` | Missing or invalid bearer token | `{"error": "Unauthorized"}` |
| `403` | PSK mismatch or subnet violation | `{"error": "PSK mismatch -- ensure both machines share the same ~/.claude-peers-token file"}` |
| `404` | Endpoint or resource not found | `{"error": "not found"}` |
| `410` | Target peer is dead (PID check failed) | `{"ok": false, "error": "Peer abc123de is not running"}` |
| `429` | Rate limited (>60 req/min per IP) | `{"error": "Rate limited"}` |
| `500` | Internal server error | `{"error": "<exception message>"}` |

## Rate Limiting

Rate limiting applies to `/send-message` and `/broadcast` endpoints only:

- **Limit**: 60 requests per minute per source IP.
- **Scope**: Since the broker binds to localhost, all local sessions share one rate limit bucket.
- **Reset**: Rate limit window resets 60 seconds after the first request in the window.
- **Exempt endpoints**: `/health`, `/register`, `/heartbeat`, `/poll-messages`, `/ack-messages`, `/list-peers`, `/set-summary`, `/set-name`, `/set-channel-push`, `/unregister`, all `/federation/*`.
