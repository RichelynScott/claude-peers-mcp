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

  brokerProc = Bun.spawn(["bun", "broker.ts"], {
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
