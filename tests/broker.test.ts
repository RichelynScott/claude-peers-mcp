/**
 * Comprehensive test suite for the claude-peers broker.
 *
 * Spins up a real broker process on an alternate port with a temp DB,
 * exercises every HTTP endpoint, then tears it down.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";

const TEST_PORT = 17899;
const TEST_DB = "/tmp/claude-peers-test.db";
const TEST_TOKEN_PATH = `/tmp/claude-peers-test-token-${crypto.randomUUID()}`;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let brokerProc: ReturnType<typeof Bun.spawn>;
let testToken: string;

// Helper: POST JSON to a broker endpoint (with auth token)
async function post(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${testToken}`,
    },
    body: JSON.stringify(body),
  });
}

// Helper: POST without auth header (for auth tests)
async function postNoAuth(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Helper: POST with a specific token (for auth tests)
async function postWithToken(path: string, token: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// Helper: register a peer using a real PID so liveness checks pass
async function registerPeer(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await post("/register", {
    pid: brokerProc.pid,
    cwd: "/tmp/test-cwd",
    git_root: "/tmp/test-repo",
    tty: "/dev/pts/0",
    session_name: "test-session",
    summary: "running tests",
    ...overrides,
  });
  const data = (await res.json()) as { id: string };
  return data.id;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up leftover test DB
  try {
    fs.unlinkSync(TEST_DB);
  } catch {}

  // Generate a random test token and write to temp file
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  testToken = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  fs.writeFileSync(TEST_TOKEN_PATH, testToken + "\n", { mode: 0o600 });

  brokerProc = Bun.spawn(["bun", "src/broker.ts"], {
    cwd: "/home/riche/MCPs/claude-peers-mcp",
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
      CLAUDE_PEERS_TOKEN: TEST_TOKEN_PATH,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Wait for broker to become responsive (up to 6s)
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    throw new Error("Broker did not start within 6 seconds");
  }
});

afterAll(() => {
  brokerProc?.kill();
  try {
    fs.unlinkSync(TEST_DB);
  } catch {}
  try {
    fs.unlinkSync(TEST_TOKEN_PATH);
  } catch {}
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe("Health", () => {
  test("GET /health returns status ok with peer count", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; peers: number };
    expect(data.status).toBe("ok");
    expect(typeof data.peers).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("Authentication", () => {
  test("POST /register without Authorization returns 401", async () => {
    const res = await postNoAuth("/register", {
      pid: process.pid,
      cwd: "/tmp/auth-test",
      git_root: null,
      tty: null,
      session_name: "",
      summary: "",
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Unauthorized");
  });

  test("POST /register with wrong token returns 401", async () => {
    const res = await postWithToken("/register", "deadbeef".repeat(8), {
      pid: process.pid,
      cwd: "/tmp/auth-test",
      git_root: null,
      tty: null,
      session_name: "",
      summary: "",
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Unauthorized");
  });

  test("POST /register with correct token returns 200", async () => {
    const res = await post("/register", {
      pid: process.pid,
      cwd: "/tmp/auth-test",
      git_root: null,
      tty: null,
      session_name: "",
      summary: "",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string };
    expect(data.id).toMatch(/^[a-z0-9]{8}$/);
  });

  test("GET /health without Authorization returns 200", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("ok");
  });

  test("POST /send-message without Authorization returns 401", async () => {
    const res = await postNoAuth("/send-message", {
      from_id: "test",
      to_id: "test",
      text: "hello",
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Unauthorized");
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("Registration", () => {
  test("POST /register returns an 8-char alphanumeric ID", async () => {
    const res = await post("/register", {
      pid: brokerProc.pid,
      cwd: "/tmp/reg-test",
      git_root: null,
      tty: null,
      session_name: "",
      summary: "",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string };
    expect(data.id).toMatch(/^[a-z0-9]{8}$/);
  });

  test("Re-registering same PID replaces the old registration", async () => {
    const id1 = await registerPeer({ cwd: "/tmp/first" });
    const id2 = await registerPeer({ cwd: "/tmp/second" });

    // IDs should differ (old one was replaced)
    expect(id1).not.toBe(id2);

    // Listing peers should only show the latest registration for this PID
    const res = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    const peers = (await res.json()) as Array<{ id: string; pid: number }>;
    const matchingPids = peers.filter((p) => p.pid === brokerProc.pid);
    expect(matchingPids.length).toBe(1);
    expect(matchingPids[0].id).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Peer Management
// ---------------------------------------------------------------------------

describe("Peer Management", () => {
  let peerId: string;

  beforeAll(async () => {
    peerId = await registerPeer();
  });

  test("POST /heartbeat updates last_seen", async () => {
    // Record the current last_seen via list-peers
    const before = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    const peersBefore = (await before.json()) as Array<{ id: string; last_seen: string }>;
    const peerBefore = peersBefore.find((p) => p.id === peerId);

    // Small delay so timestamp differs
    await new Promise((r) => setTimeout(r, 50));

    const res = await post("/heartbeat", { id: peerId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify last_seen changed
    const after = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    const peersAfter = (await after.json()) as Array<{ id: string; last_seen: string }>;
    const peerAfter = peersAfter.find((p) => p.id === peerId);

    expect(peerAfter).toBeDefined();
    if (peerBefore && peerAfter) {
      expect(new Date(peerAfter.last_seen).getTime()).toBeGreaterThanOrEqual(
        new Date(peerBefore.last_seen).getTime()
      );
    }
  });

  test("POST /set-summary updates summary", async () => {
    const res = await post("/set-summary", { id: peerId, summary: "updated summary" });
    expect(res.status).toBe(200);

    const listRes = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    const peers = (await listRes.json()) as Array<{ id: string; summary: string }>;
    const peer = peers.find((p) => p.id === peerId);
    expect(peer?.summary).toBe("updated summary");
  });

  test("POST /set-name updates session_name", async () => {
    const res = await post("/set-name", { id: peerId, session_name: "my-cool-session" });
    expect(res.status).toBe(200);

    const listRes = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    const peers = (await listRes.json()) as Array<{ id: string; session_name: string }>;
    const peer = peers.find((p) => p.id === peerId);
    expect(peer?.session_name).toBe("my-cool-session");
  });

  test("POST /list-peers with scope 'machine' returns registered peers", async () => {
    const res = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    expect(res.status).toBe(200);
    const peers = (await res.json()) as Array<{ id: string }>;
    expect(Array.isArray(peers)).toBe(true);
    expect(peers.length).toBeGreaterThanOrEqual(1);
    const ids = peers.map((p) => p.id);
    expect(ids).toContain(peerId);
  });

  test("POST /list-peers with scope 'directory' filters by cwd", async () => {
    const res = await post("/list-peers", {
      scope: "directory",
      cwd: "/tmp/test-cwd",
      git_root: null,
    });
    expect(res.status).toBe(200);
    const peers = (await res.json()) as Array<{ id: string; cwd: string }>;
    for (const p of peers) {
      expect(p.cwd).toBe("/tmp/test-cwd");
    }
  });

  test("POST /list-peers with scope 'repo' filters by git_root", async () => {
    const res = await post("/list-peers", {
      scope: "repo",
      cwd: "/tmp/test-cwd",
      git_root: "/tmp/test-repo",
    });
    expect(res.status).toBe(200);
    const peers = (await res.json()) as Array<{ id: string; git_root: string }>;
    for (const p of peers) {
      expect(p.git_root).toBe("/tmp/test-repo");
    }
  });

  test("POST /list-peers with exclude_id filters out the requester", async () => {
    const res = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
      exclude_id: peerId,
    });
    expect(res.status).toBe(200);
    const peers = (await res.json()) as Array<{ id: string }>;
    const ids = peers.map((p) => p.id);
    expect(ids).not.toContain(peerId);
  });

  test("POST /unregister removes the peer", async () => {
    // Register a new peer specifically for this test
    const tempId = await registerPeer({ cwd: "/tmp/unregister-test" });

    const res = await post("/unregister", { id: tempId });
    expect(res.status).toBe(200);

    const listRes = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    const peers = (await listRes.json()) as Array<{ id: string }>;
    const ids = peers.map((p) => p.id);
    expect(ids).not.toContain(tempId);
  });
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

describe("Messaging", () => {
  let senderId: string;
  let receiverId: string;

  beforeAll(async () => {
    // We need two distinct peers. Since both use the same PID and re-registration
    // replaces, we register sender first, then register receiver with a different
    // PID. We use the current process PID (the test runner) for the second peer.
    senderId = await registerPeer({ cwd: "/tmp/sender" });

    // For the receiver, use the test runner's own PID (also alive)
    const res = await post("/register", {
      pid: process.pid,
      cwd: "/tmp/receiver",
      git_root: null,
      tty: null,
      session_name: "receiver",
      summary: "receiving",
    });
    const data = (await res.json()) as { id: string };
    receiverId = data.id;
  });

  test("POST /send-message creates a message", async () => {
    const res = await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "Hello from sender!",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  test("POST /poll-messages returns undelivered messages (without marking delivered)", async () => {
    // Send a fresh message to ensure there's something to poll
    await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "Poll test message",
    });

    const res = await post("/poll-messages", { id: receiverId });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { messages: Array<{ id: number; from_id: string; text: string }> };
    expect(data.messages.length).toBeGreaterThanOrEqual(1);

    const found = data.messages.find((m) => m.text === "Poll test message");
    expect(found).toBeDefined();
    expect(found?.from_id).toBe(senderId);
  });

  test("Polling again still returns messages until acked (two-phase)", async () => {
    const res = await post("/poll-messages", { id: receiverId });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { messages: Array<{ id: number }> };
    // Messages NOT yet acked — should still be returned
    expect(data.messages.length).toBeGreaterThanOrEqual(1);

    // Now ack them
    const messageIds = data.messages.map((m) => m.id);
    const ackRes = await post("/ack-messages", { id: receiverId, message_ids: messageIds });
    expect(ackRes.status).toBe(200);
    const ackData = (await ackRes.json()) as { ok: boolean };
    expect(ackData.ok).toBe(true);

    // Now polling should return empty
    const res2 = await post("/poll-messages", { id: receiverId });
    const data2 = (await res2.json()) as { messages: Array<unknown> };
    expect(data2.messages.length).toBe(0);
  });

  test("POST /send-message returns message_id", async () => {
    const res = await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "ID test message",
    });
    const data = (await res.json()) as { ok: boolean; message_id: number };
    expect(data.ok).toBe(true);
    expect(typeof data.message_id).toBe("number");
    expect(data.message_id).toBeGreaterThan(0);

    // Clean up: poll and ack
    const poll = await post("/poll-messages", { id: receiverId });
    const pollData = (await poll.json()) as { messages: Array<{ id: number }> };
    if (pollData.messages.length > 0) {
      await post("/ack-messages", { id: receiverId, message_ids: pollData.messages.map((m) => m.id) });
    }
  });

  test("Sending to nonexistent peer returns error", async () => {
    const res = await post("/send-message", {
      from_id: senderId,
      to_id: "zzzzzzzz",
      text: "Should fail",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Structured Messages
// ---------------------------------------------------------------------------

describe("Structured Messages", () => {
  let senderId: string;
  let receiverId: string;

  beforeAll(async () => {
    senderId = await registerPeer({ cwd: "/tmp/struct-sender" });
    const res = await post("/register", {
      pid: process.pid,
      cwd: "/tmp/struct-receiver",
      git_root: null,
      tty: null,
      session_name: "struct-receiver",
      summary: "",
    });
    const data = (await res.json()) as { id: string };
    receiverId = data.id;
  });

  test("Send message with type 'query' stores and returns type correctly", async () => {
    const sendRes = await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "What are you working on?",
      type: "query",
    });
    const sendData = (await sendRes.json()) as { ok: boolean; message_id: number };
    expect(sendData.ok).toBe(true);

    const pollRes = await post("/poll-messages", { id: receiverId });
    const pollData = (await pollRes.json()) as { messages: Array<{ id: number; type: string; text: string }> };
    const msg = pollData.messages.find((m) => m.id === sendData.message_id);
    expect(msg).toBeDefined();
    expect(msg!.type).toBe("query");

    // Clean up
    await post("/ack-messages", { id: receiverId, message_ids: pollData.messages.map((m) => m.id) });
  });

  test("Send message with type 'handoff' and metadata round-trips correctly", async () => {
    const metadata = { task: "review PR", files: ["server.ts"], context: "urgent" };
    const sendRes = await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "Please review this PR",
      type: "handoff",
      metadata,
    });
    const sendData = (await sendRes.json()) as { ok: boolean; message_id: number };
    expect(sendData.ok).toBe(true);

    const pollRes = await post("/poll-messages", { id: receiverId });
    const pollData = (await pollRes.json()) as { messages: Array<{ id: number; type: string; metadata: Record<string, unknown> | null }> };
    const msg = pollData.messages.find((m) => m.id === sendData.message_id);
    expect(msg).toBeDefined();
    expect(msg!.type).toBe("handoff");
    expect(msg!.metadata).toEqual(metadata);
    // Verify metadata is an object, not a string
    expect(typeof msg!.metadata).toBe("object");
    expect(Array.isArray(msg!.metadata)).toBe(false);

    // Clean up
    await post("/ack-messages", { id: receiverId, message_ids: pollData.messages.map((m) => m.id) });
  });

  test("Send message with reply_to referencing existing message succeeds", async () => {
    // Send message A
    const sendA = await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "Original message",
    });
    const dataA = (await sendA.json()) as { ok: boolean; message_id: number };
    expect(dataA.ok).toBe(true);

    // Send message B replying to A
    const sendB = await post("/send-message", {
      from_id: receiverId,
      to_id: senderId,
      text: "Reply to original",
      type: "response",
      reply_to: dataA.message_id,
    });
    const dataB = (await sendB.json()) as { ok: boolean; message_id: number };
    expect(dataB.ok).toBe(true);

    // Poll sender to verify reply_to
    const pollRes = await post("/poll-messages", { id: senderId });
    const pollData = (await pollRes.json()) as { messages: Array<{ id: number; reply_to: number | null; type: string }> };
    const replyMsg = pollData.messages.find((m) => m.id === dataB.message_id);
    expect(replyMsg).toBeDefined();
    expect(replyMsg!.reply_to).toBe(dataA.message_id);
    expect(replyMsg!.type).toBe("response");

    // Clean up
    await post("/ack-messages", { id: senderId, message_ids: pollData.messages.map((m) => m.id) });
    const pollRecv = await post("/poll-messages", { id: receiverId });
    const pollRecvData = (await pollRecv.json()) as { messages: Array<{ id: number }> };
    if (pollRecvData.messages.length > 0) {
      await post("/ack-messages", { id: receiverId, message_ids: pollRecvData.messages.map((m) => m.id) });
    }
  });

  test("Send message with reply_to referencing nonexistent message fails", async () => {
    const res = await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "Reply to nothing",
      reply_to: 999999,
    });
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("not found");
  });

  test("Send message with invalid metadata (non-object) fails", async () => {
    const res = await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "Bad metadata",
      metadata: "not an object" as any,
    });
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("metadata must be a JSON object");
  });

  test("Send message without type field defaults to 'text'", async () => {
    const sendRes = await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "Plain message with no type",
    });
    const sendData = (await sendRes.json()) as { ok: boolean; message_id: number };
    expect(sendData.ok).toBe(true);

    const pollRes = await post("/poll-messages", { id: receiverId });
    const pollData = (await pollRes.json()) as { messages: Array<{ id: number; type: string }> };
    const msg = pollData.messages.find((m) => m.id === sendData.message_id);
    expect(msg).toBeDefined();
    expect(msg!.type).toBe("text");

    // Clean up
    await post("/ack-messages", { id: receiverId, message_ids: pollData.messages.map((m) => m.id) });
  });

  test("Send message with invalid type value fails", async () => {
    const res = await post("/send-message", {
      from_id: senderId,
      to_id: receiverId,
      text: "Invalid type",
      type: "invalid_type",
    });
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid message type");
  });
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

describe("Broadcast", () => {
  let peerA: string;
  let peerB: string;
  let peerC: string;
  let sleepProc: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    // Spawn a sleep process for peer C's PID (so liveness check passes)
    sleepProc = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });

    // Register 3 peers with different PIDs
    peerA = await registerPeer({ cwd: "/tmp/bcast-a", git_root: "/tmp/repo1" });

    const resB = await post("/register", {
      pid: process.pid,
      cwd: "/tmp/bcast-b",
      git_root: "/tmp/repo1",
      tty: null,
      session_name: "peer-b",
      summary: "",
    });
    peerB = ((await resB.json()) as { id: string }).id;

    const resC = await post("/register", {
      pid: sleepProc.pid,
      cwd: "/tmp/bcast-c",
      git_root: "/tmp/repo2",
      tty: null,
      session_name: "peer-c",
      summary: "",
    });
    peerC = ((await resC.json()) as { id: string }).id;
  });

  afterAll(() => {
    try { sleepProc?.kill(); } catch {}
  });

  test("Broadcast to machine scope reaches all peers except sender", async () => {
    const res = await post("/broadcast", {
      from_id: peerA,
      text: "Hello everyone!",
      scope: "machine",
      cwd: "/tmp/bcast-a",
      git_root: "/tmp/repo1",
    });
    const data = (await res.json()) as { ok: boolean; recipients: number; message_ids: number[] };
    expect(data.ok).toBe(true);
    expect(data.recipients).toBeGreaterThanOrEqual(2);

    // Poll B: should have the message
    const pollB = await post("/poll-messages", { id: peerB });
    const pollBData = (await pollB.json()) as { messages: Array<{ text: string; from_id: string }> };
    const msgB = pollBData.messages.find((m) => m.text === "Hello everyone!");
    expect(msgB).toBeDefined();
    expect(msgB!.from_id).toBe(peerA);

    // Poll C: should have the message
    const pollC = await post("/poll-messages", { id: peerC });
    const pollCData = (await pollC.json()) as { messages: Array<{ text: string; from_id: string }> };
    const msgC = pollCData.messages.find((m) => m.text === "Hello everyone!");
    expect(msgC).toBeDefined();

    // Poll A: sender should NOT have a message from broadcast
    const pollA = await post("/poll-messages", { id: peerA });
    const pollAData = (await pollA.json()) as { messages: Array<{ text: string }> };
    const msgA = pollAData.messages.find((m) => m.text === "Hello everyone!");
    expect(msgA).toBeUndefined();

    // Clean up
    if (pollBData.messages.length > 0) await post("/ack-messages", { id: peerB, message_ids: pollBData.messages.map((m: any) => m.id) });
    if (pollCData.messages.length > 0) await post("/ack-messages", { id: peerC, message_ids: pollCData.messages.map((m: any) => m.id) });
    if (pollAData.messages.length > 0) await post("/ack-messages", { id: peerA, message_ids: pollAData.messages.map((m: any) => m.id) });
  });

  test("Broadcast returns correct recipients count and message_ids", async () => {
    const res = await post("/broadcast", {
      from_id: peerA,
      text: "Count test",
      scope: "machine",
      cwd: "/tmp/bcast-a",
      git_root: "/tmp/repo1",
    });
    const data = (await res.json()) as { ok: boolean; recipients: number; message_ids: number[] };
    expect(data.ok).toBe(true);
    expect(data.recipients).toBeGreaterThanOrEqual(2);
    expect(data.message_ids.length).toBe(data.recipients);
    for (const mid of data.message_ids) {
      expect(typeof mid).toBe("number");
      expect(mid).toBeGreaterThan(0);
    }

    // Clean up
    for (const peerId of [peerB, peerC]) {
      const poll = await post("/poll-messages", { id: peerId });
      const pollData = (await poll.json()) as { messages: Array<{ id: number }> };
      if (pollData.messages.length > 0) {
        await post("/ack-messages", { id: peerId, message_ids: pollData.messages.map((m) => m.id) });
      }
    }
  });

  test("Broadcast with scope 'directory' only reaches same-directory peers", async () => {
    // peerA and peerB are in different dirs (/tmp/bcast-a, /tmp/bcast-b)
    // Register a peer D in same dir as A
    const resD = await post("/register", {
      pid: sleepProc.pid, // reuse sleep proc PID (replaces peerC registration)
      cwd: "/tmp/bcast-a",
      git_root: "/tmp/repo1",
      tty: null,
      session_name: "peer-d",
      summary: "",
    });
    const peerD = ((await resD.json()) as { id: string }).id;

    const res = await post("/broadcast", {
      from_id: peerA,
      text: "Directory scoped message",
      scope: "directory",
      cwd: "/tmp/bcast-a",
      git_root: "/tmp/repo1",
    });
    const data = (await res.json()) as { ok: boolean; recipients: number };
    expect(data.ok).toBe(true);

    // Poll D: should have the message (same directory)
    const pollD = await post("/poll-messages", { id: peerD });
    const pollDData = (await pollD.json()) as { messages: Array<{ text: string }> };
    const msgD = pollDData.messages.find((m) => m.text === "Directory scoped message");
    expect(msgD).toBeDefined();

    // Poll B: should NOT have the message (different directory)
    const pollB = await post("/poll-messages", { id: peerB });
    const pollBData = (await pollB.json()) as { messages: Array<{ text: string }> };
    const msgB = pollBData.messages.find((m) => m.text === "Directory scoped message");
    expect(msgB).toBeUndefined();

    // Clean up
    if (pollDData.messages.length > 0) await post("/ack-messages", { id: peerD, message_ids: pollDData.messages.map((m: any) => m.id) });
    if (pollBData.messages.length > 0) await post("/ack-messages", { id: peerB, message_ids: pollBData.messages.map((m: any) => m.id) });

    // Re-register peerC for subsequent tests
    const resC2 = await post("/register", {
      pid: sleepProc.pid,
      cwd: "/tmp/bcast-c",
      git_root: "/tmp/repo2",
      tty: null,
      session_name: "peer-c",
      summary: "",
    });
    peerC = ((await resC2.json()) as { id: string }).id;
  });

  test("Broadcast with scope 'repo' only reaches same-repo peers", async () => {
    // peerA: git_root /tmp/repo1, peerB: git_root /tmp/repo1, peerC: git_root /tmp/repo2
    const res = await post("/broadcast", {
      from_id: peerA,
      text: "Repo scoped message",
      scope: "repo",
      cwd: "/tmp/bcast-a",
      git_root: "/tmp/repo1",
    });
    const data = (await res.json()) as { ok: boolean; recipients: number };
    expect(data.ok).toBe(true);

    // Poll B: should have the message (same git_root)
    const pollB = await post("/poll-messages", { id: peerB });
    const pollBData = (await pollB.json()) as { messages: Array<{ text: string }> };
    const msgB = pollBData.messages.find((m) => m.text === "Repo scoped message");
    expect(msgB).toBeDefined();

    // Poll C: should NOT have the message (different git_root)
    const pollC = await post("/poll-messages", { id: peerC });
    const pollCData = (await pollC.json()) as { messages: Array<{ text: string }> };
    const msgC = pollCData.messages.find((m) => m.text === "Repo scoped message");
    expect(msgC).toBeUndefined();

    // Clean up
    if (pollBData.messages.length > 0) await post("/ack-messages", { id: peerB, message_ids: pollBData.messages.map((m: any) => m.id) });
    if (pollCData.messages.length > 0) await post("/ack-messages", { id: peerC, message_ids: pollCData.messages.map((m: any) => m.id) });
  });

  test("Broadcast to scope with no other peers returns zero recipients", async () => {
    // Register a lonely peer in a unique directory
    const resLonely = await post("/register", {
      pid: sleepProc.pid,
      cwd: "/tmp/lonely-dir-unique",
      git_root: null,
      tty: null,
      session_name: "lonely",
      summary: "",
    });
    const lonelyId = ((await resLonely.json()) as { id: string }).id;

    const res = await post("/broadcast", {
      from_id: lonelyId,
      text: "Anyone there?",
      scope: "directory",
      cwd: "/tmp/lonely-dir-unique",
      git_root: null,
    });
    const data = (await res.json()) as { ok: boolean; recipients: number; message_ids: number[] };
    expect(data.ok).toBe(true);
    expect(data.recipients).toBe(0);
    expect(data.message_ids).toEqual([]);

    // Re-register peerC for subsequent tests
    const resC3 = await post("/register", {
      pid: sleepProc.pid,
      cwd: "/tmp/bcast-c",
      git_root: "/tmp/repo2",
      tty: null,
      session_name: "peer-c",
      summary: "",
    });
    peerC = ((await resC3.json()) as { id: string }).id;
  });

  test("Broadcast respects 10KB message size limit", async () => {
    const bigText = "x".repeat(10241);
    const res = await post("/broadcast", {
      from_id: peerA,
      text: bigText,
      scope: "machine",
      cwd: "/tmp/bcast-a",
      git_root: "/tmp/repo1",
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("too large");
  });

  test("Broadcast sets type to 'broadcast' by default", async () => {
    const res = await post("/broadcast", {
      from_id: peerA,
      text: "Default type test",
      scope: "machine",
      cwd: "/tmp/bcast-a",
      git_root: "/tmp/repo1",
    });
    const data = (await res.json()) as { ok: boolean; recipients: number };
    expect(data.ok).toBe(true);

    // Poll a recipient and check type
    const pollB = await post("/poll-messages", { id: peerB });
    const pollBData = (await pollB.json()) as { messages: Array<{ text: string; type: string }> };
    const msg = pollBData.messages.find((m) => m.text === "Default type test");
    expect(msg).toBeDefined();
    expect(msg!.type).toBe("broadcast");

    // Clean up
    if (pollBData.messages.length > 0) await post("/ack-messages", { id: peerB, message_ids: pollBData.messages.map((m: any) => m.id) });
    const pollC = await post("/poll-messages", { id: peerC });
    const pollCData = (await pollC.json()) as { messages: Array<{ id: number }> };
    if (pollCData.messages.length > 0) await post("/ack-messages", { id: peerC, message_ids: pollCData.messages.map((m) => m.id) });
  });

  test("Broadcast requires auth (401 without token)", async () => {
    const res = await postNoAuth("/broadcast", {
      from_id: peerA,
      text: "No auth",
      scope: "machine",
      cwd: "/tmp/bcast-a",
      git_root: "/tmp/repo1",
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases (must run BEFORE rate-limit test which exhausts the window)
// ---------------------------------------------------------------------------

describe("Edge Cases", () => {
  test("Unknown route returns 404", async () => {
    const res = await post("/nonexistent-route", {});
    expect(res.status).toBe(404);
  });

  test("Non-POST to a broker path returns 200 text", async () => {
    const res = await fetch(`${BASE}/register`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("claude-peers broker");
  });
});

// ---------------------------------------------------------------------------
// Security & Limits (rate-limit test MUST be last — it exhausts the window)
// ---------------------------------------------------------------------------

describe("Security & Limits", () => {
  let peerId: string;

  beforeAll(async () => {
    peerId = await registerPeer({ cwd: "/tmp/security-test" });
  });

  test("Message over 10KB is rejected with error", async () => {
    // Register a target peer (use test runner PID)
    const targetRes = await post("/register", {
      pid: process.pid,
      cwd: "/tmp/target-sec",
      git_root: null,
      tty: null,
      session_name: "",
      summary: "",
    });
    const target = (await targetRes.json()) as { id: string };

    const bigText = "x".repeat(10241); // 10KB + 1 byte
    const res = await post("/send-message", {
      from_id: peerId,
      to_id: target.id,
      text: bigText,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("too large");
  });

  test("Rate limiting on /send-message returns 429 after 60 requests", async () => {
    // Only /send-message is rate-limited (the only abuse vector on localhost).
    // All other endpoints are exempt since per-IP on localhost = one shared bucket.
    const targetRes = await post("/register", {
      pid: process.pid,
      cwd: "/tmp/rate-target",
      git_root: null,
      tty: null,
      session_name: "",
      summary: "",
    });
    const target = (await targetRes.json()) as { id: string };

    let got429 = false;
    const promises: Promise<Response>[] = [];
    for (let i = 0; i < 120; i++) {
      promises.push(post("/send-message", {
        from_id: peerId,
        to_id: target.id,
        text: `rate limit test ${i}`,
      }));
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r.status === 429) {
        got429 = true;
        break;
      }
    }

    expect(got429).toBe(true);
  });
});

// --- Zombie peer eviction tests ---
describe("peer eviction on re-register", () => {
  test("re-registering with same PID evicts old peer and preserves session_name", async () => {
    // Register first peer
    const res1 = await post("/register", {
      pid: brokerProc.pid,
      cwd: "/tmp/test-evict",
      git_root: null,
      tty: "/dev/pts/99",
      session_name: "OriginalSession",
      summary: "doing work",
    });
    const id1 = ((await res1.json()) as { id: string }).id;

    // Re-register with same PID — should evict old peer and inherit session_name
    const res2 = await post("/register", {
      pid: brokerProc.pid,
      cwd: "/tmp/test-evict",
      git_root: null,
      tty: "/dev/pts/99",
      session_name: "",
      summary: "",
    });
    const id2 = ((await res2.json()) as { id: string }).id;

    expect(id2).not.toBe(id1);

    // Old peer should be gone, new peer should have inherited name
    const listRes = await post("/list-peers", { scope: "machine" });
    const peers = (await listRes.json()) as Array<{ id: string; session_name: string }>;
    const oldPeer = peers.find(p => p.id === id1);
    const newPeer = peers.find(p => p.id === id2);
    expect(oldPeer).toBeUndefined();
    expect(newPeer).toBeDefined();
    expect(newPeer!.session_name).toBe("OriginalSession");
  });

  test("re-registering with same TTY but different PID evicts old peer (zombie prevention)", async () => {
    const sharedTty = "/dev/pts/77";

    // Register "old" MCP server on a TTY
    const res1 = await post("/register", {
      pid: brokerProc.pid,
      cwd: "/tmp/test-zombie",
      git_root: null,
      tty: sharedTty,
      session_name: "OldSession",
      summary: "old work",
    });
    const id1 = ((await res1.json()) as { id: string }).id;

    // "New" MCP server registers on the SAME TTY but with a DIFFERENT PID
    // This simulates a session restart — new process, same terminal
    const res2 = await post("/register", {
      pid: process.pid, // Different PID
      cwd: "/tmp/test-zombie",
      git_root: null,
      tty: sharedTty,
      session_name: "",
      summary: "",
    });
    const id2 = ((await res2.json()) as { id: string }).id;

    expect(id2).not.toBe(id1);

    // Old peer should be evicted — only the new one should exist on this TTY
    const listRes = await post("/list-peers", { scope: "machine" });
    const peers = (await listRes.json()) as Array<{ id: string; tty: string }>;
    const ttyPeers = peers.filter(p => p.tty === sharedTty);
    expect(ttyPeers.length).toBe(1);
    expect(ttyPeers[0].id).toBe(id2);
  });

  test("messages to evicted peer are not deliverable", async () => {
    const tty = "/dev/pts/88";

    // Register and then evict by re-registering on same TTY
    const res1 = await post("/register", {
      pid: brokerProc.pid, cwd: "/tmp/test", git_root: null, tty, session_name: "", summary: "",
    });
    const oldId = ((await res1.json()) as { id: string }).id;

    const res2 = await post("/register", {
      pid: process.pid, cwd: "/tmp/test", git_root: null, tty, session_name: "", summary: "",
    });
    const newId = ((await res2.json()) as { id: string }).id;

    // Sending to the old ID should fail
    const sendRes = await post("/send-message", {
      from_id: newId, to_id: oldId, text: "hello ghost",
    });
    expect(sendRes.status).toBeGreaterThanOrEqual(400);
  });
});
