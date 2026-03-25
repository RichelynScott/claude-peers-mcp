/**
 * Integration test suite for the claude-peers MCP server.
 *
 * Spins up a real broker on a test port, connects an MCP client to
 * a real server.ts over stdio, and exercises every MCP tool handler
 * through the full MCP protocol.
 *
 * Port: 19899 (avoids broker.test.ts on 17899, cli.test.ts on 18899)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

const TEST_PORT = 19899;
const TEST_DB = `/tmp/claude-peers-server-test-${Date.now()}.db`;
const TEST_TOKEN_PATH = `/tmp/claude-peers-server-test-token-${Date.now()}`;
const TEST_TOKEN = crypto.randomBytes(32).toString("hex");
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let brokerProcess: ReturnType<typeof Bun.spawn>;
let client: Client;
let transport: StdioClientTransport;
let sleepProcess: ReturnType<typeof Bun.spawn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Authenticated POST to the broker HTTP API (bypass MCP). */
async function post(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

/** Register a helper peer directly via broker API. Uses process.pid by default. */
async function registerHelperPeer(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data } = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/helper-peer",
    git_root: null,
    tty: null,
    session_name: "helper",
    summary: "test helper",
    ...overrides,
  });
  return (data as { id: string }).id;
}

/** Extract the text content from an MCP tool result. */
function resultText(result: Awaited<ReturnType<typeof client.callTool>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join("\n");
}

/**
 * Discover the MCP server's own peer ID by listing all peers via broker
 * HTTP API and finding the one whose cwd matches PROJECT_DIR.
 */
async function getServerPeerId(): Promise<string> {
  const { data } = await post("/list-peers", {
    scope: "machine",
    cwd: "/tmp",
    git_root: null,
  });
  const peers = data as unknown as Array<{ id: string; cwd: string }>;
  const serverPeer = peers.find((p) => p.cwd === PROJECT_DIR);
  if (!serverPeer) throw new Error("MCP server peer not found in broker");
  return serverPeer.id;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Write test token file
  fs.writeFileSync(TEST_TOKEN_PATH, TEST_TOKEN, { mode: 0o600 });

  // 2. Start broker on test port
  brokerProcess = Bun.spawn(["bun", "src/broker.ts"], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
      CLAUDE_PEERS_TOKEN: TEST_TOKEN_PATH,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  // 3. Wait for broker health (up to 6s)
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  // 4. Spawn a long-lived sleep process for a second distinct PID
  sleepProcess = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });

  // 5. Create MCP client connected to server.ts via stdio
  transport = new StdioClientTransport({
    command: "bun",
    args: ["src/server.ts"],
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_TOKEN: TEST_TOKEN_PATH,
    },
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);

  // 6. Wait for server's main() to register with the broker
  //    (includes up to 3s summary generation race + registration)
  await new Promise((r) => setTimeout(r, 4000));
}, 30_000);

afterAll(async () => {
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  try { brokerProcess?.kill(); } catch {}
  try { sleepProcess?.kill(); } catch {}
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_TOKEN_PATH); } catch {}
});

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

describe("Tool Registration", () => {
  test("listTools returns all 6 tools with correct schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "broadcast_message",
      "check_messages",
      "list_peers",
      "send_message",
      "set_name",
      "set_summary",
    ]);

    // Every tool has a description and inputSchema
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }

    // send_message has optional type, metadata, reply_to
    const sendMsg = tools.find((t) => t.name === "send_message")!;
    const sendProps = sendMsg.inputSchema.properties as Record<string, unknown>;
    expect(sendProps.type).toBeDefined();
    expect(sendProps.metadata).toBeDefined();
    expect(sendProps.reply_to).toBeDefined();

    // broadcast_message has required message and scope
    const broadcast = tools.find((t) => t.name === "broadcast_message")!;
    const bcastProps = broadcast.inputSchema.properties as Record<string, unknown>;
    expect(bcastProps.message).toBeDefined();
    expect(bcastProps.scope).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// list_peers
// ---------------------------------------------------------------------------

describe("list_peers", () => {
  test("returns no peers when server is alone", async () => {
    const result = await client.callTool({
      name: "list_peers",
      arguments: { scope: "machine" },
    });
    const text = resultText(result);
    expect(text).toContain("No other Claude Code instances found");
  });

  test("returns a registered helper peer", async () => {
    const helperId = await registerHelperPeer();

    const result = await client.callTool({
      name: "list_peers",
      arguments: { scope: "machine" },
    });
    const text = resultText(result);
    expect(text).toContain("Found");
    expect(text).toContain("peer(s)");
    expect(text).toContain(helperId);
    expect(text).toContain("/tmp/helper-peer");
  });

  test("scope 'directory' excludes peers in other directories", async () => {
    // Register a peer in a different directory using the sleepProcess PID
    await registerHelperPeer({ pid: sleepProcess.pid, cwd: "/tmp/other-dir" });

    // list_peers with scope "directory" — the server's cwd is PROJECT_DIR,
    // so neither helper (in /tmp/) should appear
    const result = await client.callTool({
      name: "list_peers",
      arguments: { scope: "directory" },
    });
    const text = resultText(result);
    expect(text).toContain("No other Claude Code instances found");
  });
});

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

describe("send_message", () => {
  let helperId: string;

  beforeAll(async () => {
    helperId = await registerHelperPeer();
  });

  test("sends message to a registered peer successfully", async () => {
    const result = await client.callTool({
      name: "send_message",
      arguments: { to_id: helperId, message: "Hello from MCP test!" },
    });
    const text = resultText(result);
    expect(text).toContain("Message sent to peer");
    expect(text).toContain(helperId);
    expect(text).toContain("msg#");
    expect(text).toContain("Preview:");

    // Clean up: poll and ack
    const { data } = await post("/poll-messages", { id: helperId });
    const msgs = (data as { messages: Array<{ id: number }> }).messages;
    if (msgs.length > 0) {
      await post("/ack-messages", { id: helperId, message_ids: msgs.map((m) => m.id) });
    }
  });

  test("returns error for nonexistent peer ID", async () => {
    const result = await client.callTool({
      name: "send_message",
      arguments: { to_id: "zzzzzzzz", message: "Should fail" },
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("not found");
  });

  test("sends structured message with type and metadata", async () => {
    const result = await client.callTool({
      name: "send_message",
      arguments: {
        to_id: helperId,
        message: "What are you working on?",
        type: "query",
        metadata: { topic: "status check" },
      },
    });
    const text = resultText(result);
    expect(text).toContain("Message sent to peer");

    // Verify via broker API
    const { data } = await post("/poll-messages", { id: helperId });
    const msgs = (data as { messages: Array<{ id: number; type: string; metadata: Record<string, unknown> | null }> }).messages;
    const queryMsg = msgs.find((m) => m.type === "query");
    expect(queryMsg).toBeDefined();
    expect(queryMsg!.metadata).toEqual({ topic: "status check" });

    // Clean up
    if (msgs.length > 0) {
      await post("/ack-messages", { id: helperId, message_ids: msgs.map((m) => m.id) });
    }
  });

  test("sends message with reply_to referencing existing message", async () => {
    // First send a message to create a message ID to reply to
    const sendRes = await post("/send-message", {
      from_id: helperId,
      to_id: helperId, // send to self just to create a message_id
      text: "Original for reply test",
    });
    const originalMsgId = (sendRes.data as { ok: boolean; message_id: number }).message_id;
    expect(originalMsgId).toBeGreaterThan(0);

    // Now send via MCP with reply_to
    const result = await client.callTool({
      name: "send_message",
      arguments: {
        to_id: helperId,
        message: "Replying to your message",
        type: "response",
        reply_to: originalMsgId,
      },
    });
    const text = resultText(result);
    expect(text).toContain("Message sent to peer");

    // Clean up
    const { data } = await post("/poll-messages", { id: helperId });
    const msgs = (data as { messages: Array<{ id: number }> }).messages;
    if (msgs.length > 0) {
      await post("/ack-messages", { id: helperId, message_ids: msgs.map((m) => m.id) });
    }
  });
});

// ---------------------------------------------------------------------------
// set_summary
// ---------------------------------------------------------------------------

describe("set_summary", () => {
  test("updates summary, verifiable via broker API", async () => {
    const result = await client.callTool({
      name: "set_summary",
      arguments: { summary: "Working on server tests" },
    });
    const text = resultText(result);
    expect(text).toContain("Working on server tests");
    expect(text).toContain("Summary updated");

    // Cross-check via broker API
    const serverPeerId = await getServerPeerId();
    const { data } = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    const peers = data as unknown as Array<{ id: string; summary: string }>;
    const serverPeer = peers.find((p) => p.id === serverPeerId);
    expect(serverPeer).toBeDefined();
    expect(serverPeer!.summary).toBe("Working on server tests");
  });
});

// ---------------------------------------------------------------------------
// set_name
// ---------------------------------------------------------------------------

describe("set_name", () => {
  test("updates session name, verifiable via broker API", async () => {
    const result = await client.callTool({
      name: "set_name",
      arguments: { name: "TestSession" },
    });
    const text = resultText(result);
    expect(text).toContain("TestSession");
    expect(text).toContain("Session name set");

    // Cross-check via broker API
    const serverPeerId = await getServerPeerId();
    const { data } = await post("/list-peers", {
      scope: "machine",
      cwd: "/tmp",
      git_root: null,
    });
    const peers = data as unknown as Array<{ id: string; session_name: string }>;
    const serverPeer = peers.find((p) => p.id === serverPeerId);
    expect(serverPeer).toBeDefined();
    expect(serverPeer!.session_name).toBe("TestSession");
  });
});

// ---------------------------------------------------------------------------
// check_messages
// ---------------------------------------------------------------------------

describe("check_messages", () => {
  test("returns 'No new messages' when empty", async () => {
    // First, drain any pending messages from the server's polling loop
    // by calling check_messages until empty (the polling loop may have
    // consumed and acked them already)
    const serverPeerId = await getServerPeerId();

    // Ack any undelivered messages directly
    const { data: pollData } = await post("/poll-messages", { id: serverPeerId });
    const pendingMsgs = (pollData as { messages: Array<{ id: number }> }).messages;
    if (pendingMsgs.length > 0) {
      await post("/ack-messages", { id: serverPeerId, message_ids: pendingMsgs.map((m) => m.id) });
    }

    const result = await client.callTool({
      name: "check_messages",
      arguments: {},
    });
    const text = resultText(result);
    expect(text).toBe("No new messages.");
  });

  test("returns messages after peer sends one via broker API", async () => {
    const serverPeerId = await getServerPeerId();
    const helperId = await registerHelperPeer({ pid: sleepProcess.pid });

    // Send a message TO the server's peer
    await post("/send-message", {
      from_id: helperId,
      to_id: serverPeerId,
      text: "Hello server, this is a test!",
    });

    // Wait briefly for the message to be available (not acked by polling loop yet)
    // The polling loop runs every 1s and acks after push. We call check_messages
    // which polls but does NOT ack, so the message should be available.
    // However, the server's polling loop may grab it first. Retry a few times.
    let text = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      // Send another message each attempt in case the polling loop consumed the previous one
      if (attempt > 0) {
        await post("/send-message", {
          from_id: helperId,
          to_id: serverPeerId,
          text: "Hello server, this is a test!",
        });
      }
      await new Promise((r) => setTimeout(r, 300));
      const result = await client.callTool({
        name: "check_messages",
        arguments: {},
      });
      text = resultText(result);
      if (text.includes("new message")) break;
    }
    expect(text).toContain("new message");
    expect(text).toContain("Hello server, this is a test!");
  }, 15_000);

  test("shows type prefix for non-text messages", async () => {
    const serverPeerId = await getServerPeerId();
    const helperId = await registerHelperPeer({ pid: sleepProcess.pid });

    // Drain existing messages first
    const { data: drain } = await post("/poll-messages", { id: serverPeerId });
    const drainMsgs = (drain as { messages: Array<{ id: number }> }).messages;
    if (drainMsgs.length > 0) {
      await post("/ack-messages", { id: serverPeerId, message_ids: drainMsgs.map((m) => m.id) });
    }

    // Send a QUERY type message
    await post("/send-message", {
      from_id: helperId,
      to_id: serverPeerId,
      text: "What is your status?",
      type: "query",
    });

    // Retry loop: the server's polling loop may race with check_messages
    let text = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await post("/send-message", {
          from_id: helperId,
          to_id: serverPeerId,
          text: "What is your status?",
          type: "query",
        });
      }
      await new Promise((r) => setTimeout(r, 300));
      const result = await client.callTool({
        name: "check_messages",
        arguments: {},
      });
      text = resultText(result);
      if (text.includes("[QUERY]")) break;
    }
    expect(text).toContain("[QUERY]");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// broadcast_message
// ---------------------------------------------------------------------------

describe("broadcast_message", () => {
  test("reports 0 recipients when no other peers exist", async () => {
    // Unregister all helper peers by re-registering with unique CWDs
    // that won't conflict. Actually, we can just test scope "directory"
    // with a directory no one else is in.
    const result = await client.callTool({
      name: "broadcast_message",
      arguments: {
        message: "Anyone there?",
        scope: "directory", // scope=directory, server is in PROJECT_DIR, no helpers there
      },
    });
    const text = resultText(result);
    expect(text).toContain("No peers found");
  });

  test("broadcasts to machine scope and reports recipient count", async () => {
    // Register helper peers
    const helperA = await registerHelperPeer({ cwd: "/tmp/bcast-helper-a" });
    const helperB = await registerHelperPeer({ pid: sleepProcess.pid, cwd: "/tmp/bcast-helper-b" });

    const result = await client.callTool({
      name: "broadcast_message",
      arguments: {
        message: "Broadcast from MCP test!",
        scope: "machine",
      },
    });
    const text = resultText(result);
    expect(text).toContain("Broadcast sent to");
    expect(text).toContain("peer(s)");

    // Verify delivery by polling helpers
    const { data: pollA } = await post("/poll-messages", { id: helperA });
    const msgsA = (pollA as { messages: Array<{ text: string; id: number }> }).messages;
    const bcastA = msgsA.find((m) => m.text === "Broadcast from MCP test!");
    expect(bcastA).toBeDefined();

    const { data: pollB } = await post("/poll-messages", { id: helperB });
    const msgsB = (pollB as { messages: Array<{ text: string; id: number }> }).messages;
    const bcastB = msgsB.find((m) => m.text === "Broadcast from MCP test!");
    expect(bcastB).toBeDefined();

    // Clean up
    if (msgsA.length > 0) await post("/ack-messages", { id: helperA, message_ids: msgsA.map((m) => m.id) });
    if (msgsB.length > 0) await post("/ack-messages", { id: helperB, message_ids: msgsB.map((m) => m.id) });
  });

  test("broadcast messages are pollable by recipients", async () => {
    const helperId = await registerHelperPeer({ pid: sleepProcess.pid, cwd: "/tmp/bcast-poll-test" });

    await client.callTool({
      name: "broadcast_message",
      arguments: {
        message: "Verify delivery test",
        scope: "machine",
      },
    });

    const { data } = await post("/poll-messages", { id: helperId });
    const msgs = (data as { messages: Array<{ text: string; type: string; id: number }> }).messages;
    const bcastMsg = msgs.find((m) => m.text === "Verify delivery test");
    expect(bcastMsg).toBeDefined();
    expect(bcastMsg!.type).toBe("broadcast");

    // Clean up
    if (msgs.length > 0) await post("/ack-messages", { id: helperId, message_ids: msgs.map((m) => m.id) });
  });
});

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

describe("Error Handling", () => {
  test("calling unknown tool name produces an error", async () => {
    try {
      const result = await client.callTool({
        name: "nonexistent_tool",
        arguments: {},
      });
      // If it doesn't throw, the result should have isError or contain error text
      expect(result.isError).toBe(true);
    } catch (e) {
      // MCP SDK throws for unknown tools — this is acceptable
      expect(e).toBeDefined();
    }
  });

  test("send_message without required to_id parameter produces an error", async () => {
    try {
      const result = await client.callTool({
        name: "send_message",
        arguments: { message: "Missing to_id" },
      });
      // Should be an error — either isError or an error in the text
      const text = resultText(result);
      const isErr = result.isError === true || text.toLowerCase().includes("error");
      expect(isErr).toBe(true);
    } catch (e) {
      // MCP SDK may throw for invalid params
      expect(e).toBeDefined();
    }
  });
});
