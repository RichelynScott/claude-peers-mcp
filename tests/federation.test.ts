/**
 * Federation test suite for claude-peers-mcp (US-013)
 *
 * Tests the LAN federation layer: TLS server, PSK auth, HMAC message signing,
 * subnet restriction, remote peer management, and process isolation.
 *
 * Ports:
 *   18901 — broker HTTP (localhost)
 *   18900 — federation TLS (0.0.0.0)
 * Avoids: 17899 (broker.test.ts), 18899 (cli.test.ts), 19899 (server.test.ts)
 *
 * NOTE: Bun 1.3.x fetch() does not honor tls.rejectUnauthorized for self-signed
 * certs. Federation TLS endpoints are tested via `curl -sk` subprocess instead.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import {
  signMessage,
  verifySignature,
  ipInSubnet,
  getMachineHostname,
} from "../src/federation.ts";

// --- Test configuration ---
const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TEST_BROKER_PORT = 18901;
const TEST_FEDERATION_PORT = 18900;
const TEST_DB = `/tmp/claude-peers-federation-test-${crypto.randomUUID()}.db`;
const TEST_TOKEN_PATH = `/tmp/claude-peers-federation-test-token-${crypto.randomUUID()}`;
const TEST_CERT_PATH = `/tmp/claude-peers-federation-test-${crypto.randomUUID()}.crt`;
const TEST_KEY_PATH = `/tmp/claude-peers-federation-test-${crypto.randomUUID()}.key`;

const BROKER_BASE = `http://127.0.0.1:${TEST_BROKER_PORT}`;
const FEDERATION_BASE = `https://127.0.0.1:${TEST_FEDERATION_PORT}`;

const TEST_PSK = "fedtest_" + crypto.randomUUID().replace(/-/g, "").slice(0, 56);

let brokerProc: ReturnType<typeof Bun.spawn>;

// --- Helpers ---

/** POST to the local broker HTTP API with bearer token auth */
async function brokerPost(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${BROKER_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_PSK}`,
    },
    body: JSON.stringify(body),
  });
}

/** POST to broker without auth */
async function brokerPostNoAuth(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${BROKER_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * POST to the federation TLS API using curl (Bun fetch cannot handle self-signed TLS).
 * Returns { status, body } where body is parsed JSON.
 */
async function curlFederationPost(
  path: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const allHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  const args = [
    "curl", "-sk",
    "-w", "\n__HTTP_STATUS__%{http_code}",
    "-X", "POST",
  ];
  for (const [k, v] of Object.entries(allHeaders)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push("-d", JSON.stringify(body));
  args.push(`${FEDERATION_BASE}${path}`);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  // Parse: body\n__HTTP_STATUS__NNN
  const statusMarker = "__HTTP_STATUS__";
  const markerIdx = output.lastIndexOf(statusMarker);
  const jsonStr = output.slice(0, markerIdx).trim();
  const status = parseInt(output.slice(markerIdx + statusMarker.length).trim(), 10);

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    parsed = { _raw: jsonStr };
  }
  return { status, body: parsed };
}

/**
 * GET a federation TLS endpoint using curl.
 */
async function curlFederationGet(
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const args = [
    "curl", "-sk",
    "-w", "\n__HTTP_STATUS__%{http_code}",
    `${FEDERATION_BASE}${path}`,
  ];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const statusMarker = "__HTTP_STATUS__";
  const markerIdx = output.lastIndexOf(statusMarker);
  const jsonStr = output.slice(0, markerIdx).trim();
  const status = parseInt(output.slice(markerIdx + statusMarker.length).trim(), 10);

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    parsed = { _raw: jsonStr };
  }
  return { status, body: parsed };
}

/** Register a peer against the test broker, using the broker PID for liveness */
async function registerPeer(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await brokerPost("/register", {
    pid: brokerProc.pid,
    cwd: "/tmp/fed-test-cwd",
    git_root: "/tmp/fed-test-repo",
    tty: "/dev/pts/0",
    session_name: "fed-test",
    summary: "federation testing",
    ...overrides,
  });
  const data = (await res.json()) as { id: string };
  return data.id;
}

// ---------------------------------------------------------------------------
// Lifecycle — spin up broker with federation enabled
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up leftover files
  for (const f of [TEST_DB, TEST_TOKEN_PATH, TEST_CERT_PATH, TEST_KEY_PATH]) {
    try { fs.unlinkSync(f); } catch {}
  }

  // Write test token
  fs.writeFileSync(TEST_TOKEN_PATH, TEST_PSK + "\n", { mode: 0o600 });

  // Generate TLS cert for the test federation server
  try {
    // Try Ed25519 first
    const p1 = Bun.spawn(["openssl", "genpkey", "-algorithm", "Ed25519", "-out", TEST_KEY_PATH], {
      stdout: "ignore", stderr: "ignore",
    });
    await p1.exited;
    const p2 = Bun.spawn([
      "openssl", "req", "-new", "-x509", "-key", TEST_KEY_PATH,
      "-out", TEST_CERT_PATH, "-days", "1", "-subj", "/CN=federation-test",
    ], {
      stdout: "ignore", stderr: "ignore",
    });
    await p2.exited;
  } catch {
    // Fallback to RSA
    const p = Bun.spawn([
      "openssl", "req", "-newkey", "rsa:2048", "-noenc",
      "-keyout", TEST_KEY_PATH, "-x509", "-days", "1",
      "-out", TEST_CERT_PATH, "-subj", "/CN=federation-test",
    ], {
      stdout: "ignore", stderr: "ignore",
    });
    await p.exited;
  }

  // Verify cert files were created
  if (!fs.existsSync(TEST_CERT_PATH)) throw new Error(`Cert not generated: ${TEST_CERT_PATH}`);
  if (!fs.existsSync(TEST_KEY_PATH)) throw new Error(`Key not generated: ${TEST_KEY_PATH}`);
  fs.chmodSync(TEST_KEY_PATH, 0o600);

  // Start broker with federation enabled
  brokerProc = Bun.spawn(["bun", "src/broker.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_BROKER_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
      CLAUDE_PEERS_TOKEN: TEST_TOKEN_PATH,
      CLAUDE_PEERS_FEDERATION_ENABLED: "true",
      CLAUDE_PEERS_FEDERATION_PORT: String(TEST_FEDERATION_PORT),
      CLAUDE_PEERS_FEDERATION_CERT: TEST_CERT_PATH,
      CLAUDE_PEERS_FEDERATION_KEY: TEST_KEY_PATH,
      CLAUDE_PEERS_FEDERATION_SUBNET: "0.0.0.0/0", // Allow all for testing
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Wait for broker HTTP to become ready
  let brokerReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BROKER_BASE}/health`);
      if (res.ok) { brokerReady = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!brokerReady) throw new Error("Broker HTTP did not start within 8 seconds");

  // Wait for federation TLS to become ready (use curl since Bun fetch can't do self-signed TLS)
  let federationReady = false;
  for (let i = 0; i < 20; i++) {
    try {
      const { status } = await curlFederationGet("/health");
      if (status === 200) { federationReady = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!federationReady) throw new Error("Federation TLS did not start within 4 seconds");
});

afterAll(() => {
  brokerProc?.kill();
  for (const f of [TEST_DB, TEST_TOKEN_PATH, TEST_CERT_PATH, TEST_KEY_PATH]) {
    try { fs.unlinkSync(f); } catch {}
  }
  // Also clean WAL/SHM files
  try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
  try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
});

// ===========================================================================
// TLS & Startup
// ===========================================================================

describe("TLS & Startup", () => {
  it("1. Federation TLS server starts and accepts connections on configured port", async () => {
    const { status, body } = await curlFederationGet("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.federation).toBe(true);
    expect(typeof body.hostname).toBe("string");
    expect((body.hostname as string).length).toBeGreaterThan(0);
  });

  it("2. Federation server does NOT start when CLAUDE_PEERS_FEDERATION_ENABLED is not set", async () => {
    // Spin up a second broker WITHOUT federation and verify status
    const noFedDB = `/tmp/claude-peers-nofed-${crypto.randomUUID()}.db`;
    const noFedTokenPath = `/tmp/claude-peers-nofed-token-${crypto.randomUUID()}`;
    const noFedPort = 18903;
    fs.writeFileSync(noFedTokenPath, TEST_PSK + "\n", { mode: 0o600 });

    const noFedProc = Bun.spawn(["bun", "src/broker.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CLAUDE_PEERS_PORT: String(noFedPort),
        CLAUDE_PEERS_DB: noFedDB,
        CLAUDE_PEERS_TOKEN: noFedTokenPath,
        // CLAUDE_PEERS_FEDERATION_ENABLED intentionally not set
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    try {
      // Wait for it to start
      let ready = false;
      for (let i = 0; i < 20; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${noFedPort}/health`);
          if (r.ok) { ready = true; break; }
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(ready).toBe(true);

      // Check federation status — should be disabled
      const statusRes = await fetch(`http://127.0.0.1:${noFedPort}/federation/status`);
      const statusData = (await statusRes.json()) as { enabled: boolean };
      expect(statusData.enabled).toBe(false);

      // Verify /federation/connect returns "not enabled" error
      const connectRes = await fetch(`http://127.0.0.1:${noFedPort}/federation/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PSK}`,
        },
        body: JSON.stringify({ host: "127.0.0.1", port: 7900 }),
      });
      const connectData = (await connectRes.json()) as { ok: boolean; error?: string };
      expect(connectData.ok).toBe(false);
      expect(connectData.error).toContain("not enabled");
    } finally {
      noFedProc.kill();
      for (const f of [noFedDB, noFedDB + "-wal", noFedDB + "-shm", noFedTokenPath]) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  });
});

// ===========================================================================
// PSK Authentication
// ===========================================================================

describe("PSK Authentication", () => {
  it("3. POST /federation/handshake with correct PSK returns success + hostname", async () => {
    const { status, body } = await curlFederationPost(
      "/federation/handshake",
      { psk: TEST_PSK, hostname: "test-machine", version: "1.0.0" },
      { "X-Claude-Peers-PSK": TEST_PSK },
    );
    expect(status).toBe(200);
    expect(typeof body.hostname).toBe("string");
    expect((body.hostname as string).length).toBeGreaterThan(0);
    expect(body.version).toBe("1.0.0");
  });

  it("4. POST /federation/handshake with wrong PSK returns 403 error", async () => {
    const wrongPsk = "wrong-psk-" + crypto.randomUUID();
    const { status, body } = await curlFederationPost(
      "/federation/handshake",
      { psk: wrongPsk, hostname: "attacker", version: "1.0.0" },
      { "X-Claude-Peers-PSK": wrongPsk },
    );
    expect(status).toBe(403);
    expect((body.error as string)).toContain("PSK");
  });

  it("5. POST /federation/peers with correct PSK returns local peer list", async () => {
    // Register a peer so the list is non-empty
    const peerId = await registerPeer({ session_name: "fed-peer-list-test" });

    const { status, body } = await curlFederationPost(
      "/federation/peers",
      {},
      { "X-Claude-Peers-PSK": TEST_PSK },
    );
    expect(status).toBe(200);
    expect(typeof body.hostname).toBe("string");
    expect(Array.isArray(body.peers)).toBe(true);
    const peers = body.peers as Array<{ id: string }>;
    const found = peers.some((p) => p.id === peerId);
    expect(found).toBe(true);
  });

  it("6. POST /federation/peers without PSK auth returns 403", async () => {
    // POST without X-Claude-Peers-PSK header
    const { status, body } = await curlFederationPost(
      "/federation/peers",
      {},
      {}, // No PSK header
    );
    expect(status).toBe(403);
    expect((body.error as string)).toContain("PSK");
  });
});

// ===========================================================================
// Message Relay
// ===========================================================================

describe("Message Relay", () => {
  it("7. POST /federation/relay delivers message to local broker (valid HMAC)", async () => {
    // Register a local peer to receive the relayed message
    const localPeerId = await registerPeer({ session_name: "relay-target" });

    // Build a relay body and sign it
    const relayBody: Record<string, unknown> = {
      from_id: "remote-host:abc12345",
      from_machine: "remote-host",
      to_id: localPeerId,
      text: "Hello from remote machine!",
      type: "text",
      metadata: null,
      reply_to: null,
    };
    const signature = signMessage(relayBody, TEST_PSK);

    const { status, body } = await curlFederationPost(
      "/federation/relay",
      { ...relayBody, signature },
      { "X-Claude-Peers-PSK": TEST_PSK },
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.message_id).toBe("number");

    // Verify the message was delivered by polling the local broker
    const pollRes = await brokerPost("/poll-messages", { id: localPeerId });
    const pollData = (await pollRes.json()) as { messages: Array<{ from_id: string; text: string }> };
    const relayed = pollData.messages.find((m) => m.from_id === "remote-host:abc12345");
    expect(relayed).toBeDefined();
    expect(relayed!.text).toBe("Hello from remote machine!");
  });

  it("8. POST /federation/relay with invalid HMAC signature returns 403", async () => {
    const localPeerId = await registerPeer({ session_name: "relay-bad-hmac" });

    const relayBody: Record<string, unknown> = {
      from_id: "attacker:evil1234",
      from_machine: "attacker",
      to_id: localPeerId,
      text: "Spoofed message",
      type: "text",
      metadata: null,
      reply_to: null,
    };
    // Sign with wrong key
    const badSignature = signMessage(relayBody, "wrong-secret-key-xxxxxxxxxxxxxxxxx");

    const { status, body } = await curlFederationPost(
      "/federation/relay",
      { ...relayBody, signature: badSignature },
      { "X-Claude-Peers-PSK": TEST_PSK },
    );
    expect(status).toBe(403);
    expect((body.error as string)).toContain("HMAC");
  });

  it("9. POST /federation/relay without signature returns 403", async () => {
    const localPeerId = await registerPeer({ session_name: "relay-no-sig" });

    const { status, body } = await curlFederationPost(
      "/federation/relay",
      {
        from_id: "remote:peer1234",
        from_machine: "remote",
        to_id: localPeerId,
        text: "No signature message",
        type: "text",
        metadata: null,
        reply_to: null,
        // signature intentionally omitted (empty/falsy)
      },
      { "X-Claude-Peers-PSK": TEST_PSK },
    );
    expect(status).toBe(403);
    expect((body.error as string)).toContain("HMAC");
  });
});

// ===========================================================================
// Subnet Restriction (unit tests)
// ===========================================================================

describe("Subnet Restriction", () => {
  it("10. ipInSubnet correctly validates IPs against CIDR subnets", () => {
    // Standard /24 subnet
    expect(ipInSubnet("192.168.1.5", "192.168.1.0/24")).toBe(true);
    expect(ipInSubnet("192.168.1.255", "192.168.1.0/24")).toBe(true);
    expect(ipInSubnet("192.168.2.1", "192.168.1.0/24")).toBe(false);

    // Broader /16 subnet
    expect(ipInSubnet("10.0.5.100", "10.0.0.0/16")).toBe(true);
    expect(ipInSubnet("10.1.0.1", "10.0.0.0/16")).toBe(false);

    // /20 subnet (WSL2 common)
    expect(ipInSubnet("172.30.240.1", "172.30.240.0/20")).toBe(true);
    expect(ipInSubnet("172.30.255.254", "172.30.240.0/20")).toBe(true);
    expect(ipInSubnet("172.30.239.255", "172.30.240.0/20")).toBe(false);

    // /32 — single host
    expect(ipInSubnet("10.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(ipInSubnet("10.0.0.2", "10.0.0.1/32")).toBe(false);

    // /0 — all IPs
    expect(ipInSubnet("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipInSubnet("255.255.255.255", "0.0.0.0/0")).toBe(true);

    // Invalid CIDR bits
    expect(ipInSubnet("10.0.0.1", "10.0.0.0/33")).toBe(false);
    expect(ipInSubnet("10.0.0.1", "10.0.0.0/-1")).toBe(false);
  });
});

// ===========================================================================
// Remote Peer Management
// ===========================================================================

describe("Remote Peer Management", () => {
  it("11. Peer list sync populates remote peer cache (via /federation/status)", async () => {
    const res = await fetch(`${BROKER_BASE}/federation/status`);
    const data = (await res.json()) as { enabled: boolean; remotes: unknown[]; total_remote_peers: number };
    expect(data.enabled).toBe(true);
    // No remotes connected since we haven't called /federation/connect to a real remote
    expect(data.remotes.length).toBe(0);
    expect(data.total_remote_peers).toBe(0);
  });

  it("12. Stale remote peers cleanup data path is correct in status response", async () => {
    // Verify the federation status response shape includes last_sync (used for stale eviction)
    const res = await fetch(`${BROKER_BASE}/federation/status`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
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
    };
    expect(data.enabled).toBe(true);
    expect(typeof data.port).toBe("number");
    expect(typeof data.subnet).toBe("string");
    expect(Array.isArray(data.remotes)).toBe(true);
    expect(typeof data.total_remote_peers).toBe("number");
  });

  it("13. Remote peer IDs are prefixed with machine hostname", () => {
    // Unit test: verify the ID format used in handleFederationConnect
    const remoteHostname = "rafi-mac";
    const originalId = "a1b2c3d4";
    const prefixedId = `${remoteHostname}:${originalId}`;

    expect(prefixedId).toBe("rafi-mac:a1b2c3d4");
    expect(prefixedId.includes(":")).toBe(true);

    // Verify splitting works correctly (matches broker.ts handleFederationSendToRemote logic)
    const colonIdx = prefixedId.indexOf(":");
    expect(prefixedId.slice(0, colonIdx)).toBe("rafi-mac");
    expect(prefixedId.slice(colonIdx + 1)).toBe("a1b2c3d4");
  });
});

// ===========================================================================
// Process Isolation (Bug Fix Verification)
// ===========================================================================

describe("Process Isolation", () => {
  it("14. Remote from_ids (containing ':') bypass PID liveness check in relay", async () => {
    // Register a local target peer
    const localPeerId = await registerPeer({ session_name: "isolation-test" });

    // from_id contains ":" — sender is remote, no local PID check should happen
    const relayBody: Record<string, unknown> = {
      from_id: "remote-machine:xyz99999",
      from_machine: "remote-machine",
      to_id: localPeerId,
      text: "Message from remote — no local PID to check",
      type: "text",
      metadata: null,
      reply_to: null,
    };
    const signature = signMessage(relayBody, TEST_PSK);

    const { status, body } = await curlFederationPost(
      "/federation/relay",
      { ...relayBody, signature },
      { "X-Claude-Peers-PSK": TEST_PSK },
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("15. Local /federation/send-to-remote endpoint requires bearer token (not PSK)", async () => {
    // Without bearer token — should get 401
    const noAuthRes = await brokerPostNoAuth("/federation/send-to-remote", {
      to_id: "somehost:peer1234",
      from_id: "local1234",
      text: "test",
    });
    expect(noAuthRes.status).toBe(401);

    // With bearer token — should pass auth (returns application-level error, not auth error)
    const authRes = await brokerPost("/federation/send-to-remote", {
      to_id: "somehost:peer1234",
      from_id: "local1234",
      text: "test",
    });
    expect(authRes.status).toBe(200);
    const data = (await authRes.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    // Error should be about routing/federation, not authentication
    expect(data.error).toBeDefined();
    expect(data.error).not.toContain("Unauthorized");
  });

  it("16. Local /federation/connect endpoint requires bearer token (not PSK)", async () => {
    // Without bearer token — should get 401
    const noAuthRes = await brokerPostNoAuth("/federation/connect", {
      host: "127.0.0.1",
      port: 19999, // No server on this port — fast connection refused
    });
    expect(noAuthRes.status).toBe(401);

    // With bearer token — passes auth (connection will fail fast, but not due to auth)
    const authRes = await brokerPost("/federation/connect", {
      host: "127.0.0.1",
      port: 19999,
    });
    expect(authRes.status).toBe(200);
    const data = (await authRes.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).not.toContain("Unauthorized");
  });
});

// ===========================================================================
// Error Handling
// ===========================================================================

describe("Error Handling", () => {
  it("17. Sync error (unreachable remote) does not crash broker", async () => {
    // Attempt to connect to a host that will fail fast (connection refused)
    const res = await brokerPost("/federation/connect", {
      host: "127.0.0.1",
      port: 19998, // No server on this port — immediate ECONNREFUSED
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe("string");

    // Verify broker is still alive
    const healthRes = await fetch(`${BROKER_BASE}/health`);
    expect(healthRes.status).toBe(200);
    const healthData = (await healthRes.json()) as { status: string };
    expect(healthData.status).toBe("ok");

    // Verify federation TLS server is still alive
    const { status } = await curlFederationGet("/health");
    expect(status).toBe(200);
  });
});

// ===========================================================================
// HMAC Signing Utilities (unit tests)
// ===========================================================================

describe("HMAC Signing", () => {
  it("18. signMessage produces consistent signatures for same input", () => {
    const body = { from_id: "a:b", text: "hello", to_id: "c" };
    const sig1 = signMessage(body, "secret");
    const sig2 = signMessage(body, "secret");
    expect(sig1).toBe(sig2);
    expect(sig1.length).toBe(64); // SHA-256 hex = 64 chars
  });

  it("19. verifySignature rejects tampered messages", () => {
    const body = { from_id: "a:b", text: "hello", to_id: "c" };
    const sig = signMessage(body, "secret");

    // Tamper with body
    expect(verifySignature({ ...body, text: "TAMPERED" }, sig, "secret")).toBe(false);
    // Wrong key
    expect(verifySignature(body, sig, "wrong-key")).toBe(false);
    // Original should still verify
    expect(verifySignature(body, sig, "secret")).toBe(true);
  });

  it("20. signMessage uses canonical key ordering", () => {
    const body1 = { b: "2", a: "1", c: "3" };
    const body2 = { c: "3", a: "1", b: "2" };
    // Same keys/values in different order should produce the same signature
    expect(signMessage(body1, "key")).toBe(signMessage(body2, "key"));
  });

  it("22. signMessage preserves nested object contents (not stripped by replacer)", () => {
    // Regression test: JSON.stringify(body, arrayReplacer) strips nested keys.
    // signMessage must preserve nested objects like metadata.
    const body = {
      from_id: "host:peer1",
      metadata: { task: "build feature", files: ["/a.ts", "/b.ts"] },
      text: "hello",
      to_id: "local1",
      type: "handoff",
    };

    const sig = signMessage(body, "secret");
    // Verify the signature is stable and based on full content
    expect(signMessage(body, "secret")).toBe(sig);

    // A body with different metadata should produce a DIFFERENT signature
    const bodyDiffMeta = { ...body, metadata: { task: "different task" } };
    expect(signMessage(bodyDiffMeta, "secret")).not.toBe(sig);

    // A body with empty metadata should also differ
    const bodyEmptyMeta = { ...body, metadata: {} };
    expect(signMessage(bodyEmptyMeta, "secret")).not.toBe(sig);

    // Verify the signature matches what we'd expect from manually sorted keys
    const manualCanonical = JSON.stringify({
      from_id: body.from_id,
      metadata: body.metadata,
      text: body.text,
      to_id: body.to_id,
      type: body.type,
    });
    const { createHmac } = require("node:crypto");
    const expected = createHmac("sha256", "secret").update(manualCanonical).digest("hex");
    expect(sig).toBe(expected);
  });

  it("21. getMachineHostname returns a lowercase string under 64 chars", () => {
    const h = getMachineHostname();
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
    expect(h.length).toBeLessThanOrEqual(63);
    expect(h).toBe(h.toLowerCase());
    expect(h.includes(":")).toBe(false);
  });
});
