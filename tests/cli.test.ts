/**
 * Test suite for CLI auto-summary feature.
 *
 * Unit tests for buildSummary (pure function, no broker needed).
 * Integration tests spin up a real broker on TEST_PORT with a temp DB,
 * register a peer, run auto-summary via subprocess, and verify the result.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import { buildSummary, getGitRepoName, getGitBranchName } from "../src/cli.ts";

// ---------------------------------------------------------------------------
// Unit Tests: buildSummary (pure function)
// ---------------------------------------------------------------------------

describe("buildSummary", () => {
  test("git repo + branch + tasks produces task count format", () => {
    const result = buildSummary({
      repoName: "my-project",
      branch: "main",
      cwd: "/home/user/my-project",
      taskCount: 3,
    });
    expect(result).toBe("[my-project:main] 3 in-progress tasks");
  });

  test("git repo + branch + 1 task uses singular form", () => {
    const result = buildSummary({
      repoName: "my-project",
      branch: "feat/login",
      cwd: "/home/user/my-project",
      taskCount: 1,
    });
    expect(result).toBe("[my-project:feat/login] 1 in-progress task");
  });

  test("git repo + branch + no tasks produces working-in format", () => {
    const result = buildSummary({
      repoName: "claude-peers-mcp",
      branch: "main",
      cwd: "/home/user/claude-peers-mcp",
      taskCount: null,
    });
    expect(result).toBe("[claude-peers-mcp:main] Working in /home/user/claude-peers-mcp");
  });

  test("git repo + branch + zero tasks produces working-in format", () => {
    const result = buildSummary({
      repoName: "claude-peers-mcp",
      branch: "main",
      cwd: "/home/user/claude-peers-mcp",
      taskCount: 0,
    });
    expect(result).toBe("[claude-peers-mcp:main] Working in /home/user/claude-peers-mcp");
  });

  test("no git context produces working-in format without prefix", () => {
    const result = buildSummary({
      repoName: null,
      branch: null,
      cwd: "/tmp/random-dir",
      taskCount: null,
    });
    expect(result).toBe("Working in /tmp/random-dir");
  });

  test("repo without branch falls back to working-in format without prefix", () => {
    const result = buildSummary({
      repoName: "some-repo",
      branch: null,
      cwd: "/home/user/some-repo",
      taskCount: 5,
    });
    expect(result).toBe("Working in /home/user/some-repo");
  });

  test("branch without repo falls back to working-in format without prefix", () => {
    const result = buildSummary({
      repoName: null,
      branch: "main",
      cwd: "/home/user/some-dir",
      taskCount: null,
    });
    expect(result).toBe("Working in /home/user/some-dir");
  });

  test("no git + tasks still produces working-in format (tasks ignored without git)", () => {
    const result = buildSummary({
      repoName: null,
      branch: null,
      cwd: "/tmp/taskmaster-dir",
      taskCount: 7,
    });
    expect(result).toBe("Working in /tmp/taskmaster-dir");
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: getGitRepoName and getGitBranchName (in a real git repo)
// ---------------------------------------------------------------------------

describe("git helpers", () => {
  const REPO_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

  test("getGitRepoName returns repo basename in a git directory", () => {
    const result = getGitRepoName(REPO_DIR);
    expect(result).toBe("claude-peers-mcp");
  });

  test("getGitBranchName returns a branch name in a git directory", () => {
    const result = getGitBranchName(REPO_DIR);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
  });

  test("getGitRepoName returns null for non-git directory", () => {
    const result = getGitRepoName("/tmp");
    expect(result).toBeNull();
  });

  test("getGitBranchName returns null for non-git directory", () => {
    const result = getGitBranchName("/tmp");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration Tests: auto-summary CLI command (requires broker)
// ---------------------------------------------------------------------------

const TEST_PORT = 18899;
const TEST_DB = "/tmp/claude-peers-cli-test.db";
const TEST_TOKEN_FILE = "/tmp/claude-peers-cli-test-token";
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let brokerProc: ReturnType<typeof Bun.spawn>;
let testToken: string;

// Shared env for all broker and CLI calls in integration tests
function testEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    CLAUDE_PEERS_PORT: String(TEST_PORT),
    CLAUDE_PEERS_DB: TEST_DB,
    CLAUDE_PEERS_TOKEN: TEST_TOKEN_FILE,
  };
}

// Helper: POST JSON to the test broker (with auth)
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

// Helper: register a peer and return its ID
async function registerPeer(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await post("/register", {
    pid: process.pid,
    cwd: "/tmp/cli-test-cwd",
    git_root: "/tmp/cli-test-repo",
    tty: null,
    session_name: "cli-test",
    summary: "",
    ...overrides,
  });
  const data = (await res.json()) as { id: string };
  return data.id;
}

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI_PATH = `${PROJECT_ROOT}/src/cli.ts`;

// Helper: run cli.ts as a subprocess with custom env
async function runCli(
  args: string[],
  opts: { cwd?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    cwd: opts.cwd ?? PROJECT_ROOT,
    env: testEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("auto-summary integration", () => {
  beforeAll(async () => {
    // Clean up leftover test artifacts
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_TOKEN_FILE); } catch {}

    // Pre-create the token file so both broker and CLI can use it
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    testToken = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    fs.writeFileSync(TEST_TOKEN_FILE, testToken + "\n", { mode: 0o600 });

    brokerProc = Bun.spawn(["bun", "src/broker.ts"], {
      cwd: PROJECT_ROOT,
      env: testEnv(),
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
      throw new Error("Test broker did not start within 6 seconds");
    }
  });

  afterAll(() => {
    brokerProc?.kill();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_TOKEN_FILE); } catch {}
  });

  test("auto-summary sets summary on registered peer (git repo)", async () => {
    const peerId = await registerPeer();

    // Run auto-summary from the project directory (which is a git repo)
    const result = await runCli(["auto-summary", peerId]);

    expect(result.exitCode).toBe(0);
    // Should contain the git prefix format [repo:branch]
    expect(result.stdout).toContain("[claude-peers-mcp:");
    expect(result.stdout).toContain("Working in");

    // Verify the summary was actually set on the broker
    const listRes = await post("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const peers = (await listRes.json()) as Array<{ id: string; summary: string }>;
    const peer = peers.find((p) => p.id === peerId);
    expect(peer).toBeDefined();
    expect(peer!.summary).toContain("[claude-peers-mcp:");
  });

  test("auto-summary works in non-git directory", async () => {
    const peerId = await registerPeer();

    // Run from /tmp which is not a git repo
    const result = await runCli(["auto-summary", peerId], { cwd: "/tmp" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Working in /tmp");

    // Verify the summary was set
    const listRes = await post("/list-peers", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    const peers = (await listRes.json()) as Array<{ id: string; summary: string }>;
    const peer = peers.find((p) => p.id === peerId);
    expect(peer!.summary).toBe("Working in /tmp");
  });

  test("auto-summary with missing peer-id prints usage and exits 1", async () => {
    const result = await runCli(["auto-summary"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: bun cli.ts auto-summary <peer-id>");
  });

  test("auto-summary with nonexistent peer-id still succeeds (broker accepts silently)", async () => {
    // The broker's /set-summary endpoint does UPDATE WHERE id = ? and returns
    // { ok: true } even if no rows are affected. This is by design — the CLI
    // can't distinguish a missing peer from a successful set without an extra
    // round-trip. The PRD's US-005 handles broker *errors*, not silent no-ops.
    const result = await runCli(["auto-summary", "zzzzzzzz"]);

    // Summary should be printed to stdout
    expect(result.stdout.length).toBeGreaterThan(0);
    // Broker accepted the call, so exit 0
    expect(result.exitCode).toBe(0);
  });

  test("auto-summary with broker down prints error and exits 1", async () => {
    // Use a port where no broker is running
    const proc = Bun.spawn(["bun", CLI_PATH, "auto-summary", "testpeer"], {
      cwd: PROJECT_ROOT,
      env: {
        ...testEnv(),
        CLAUDE_PEERS_PORT: "19999",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Error:");
    expect(stderr).toContain("Broker not reachable");
    // Summary should still be printed to stdout
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});
