# Contributing to claude-peers-mcp

Thanks for your interest in contributing! This guide covers the process for submitting changes.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/claude-peers-mcp.git
   cd claude-peers-mcp
   ```
3. **Install dependencies** (requires [Bun](https://bun.sh) v1.1+):
   ```bash
   bun install
   ```
4. **Run the test suite** to verify your setup:
   ```bash
   bun test
   ```
   You should see 104+ tests pass with 318+ assertions.

## Architecture Overview

Understanding the process model is essential before making changes:

```
Claude Code Session A          Claude Code Session B
    |                              |
    v                              v
[MCP Server A]                [MCP Server B]       (stdio, one per session)
(src/server.ts)               (src/server.ts)
    |                              |
    +--- HTTP to localhost:7899 ---+
                  |
         [Broker Daemon]                            (singleton, one per machine)
         (src/broker.ts + src/broker-handlers.ts)
         HTTP on 127.0.0.1:7899
         TLS on 0.0.0.0:7900  (Federation)
         SQLite: ~/.claude-peers.db
```

- **`src/broker.ts`** and **`src/server.ts`** are **separate processes**. They communicate via HTTP. Never import broker code into server.ts or vice versa.
- **`src/broker-handlers.ts`** contains request handler factories in closures. These are hot-reloadable via SIGHUP.
- **`src/server.ts`** is the MCP stdio server — one instance per Claude Code session. It spawns the broker if needed.
- **`src/cli.ts`** is the terminal CLI utility. It runs as one-shot commands against the broker's HTTP API.
- **`src/federation.ts`** handles TLS cert generation, HMAC signing, and cross-machine communication.

## Making Changes

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes.** Follow these conventions:
   - **Runtime**: Bun, not Node.js. Use `Bun.serve()`, `bun:sqlite`, `Bun.file`.
   - **TypeScript**: Strict mode. All interfaces in `src/shared/types.ts`.
   - **No new dependencies** unless absolutely necessary. The project is intentionally minimal.
   - **Error handling**: Descriptive messages, no silent failures.
   - **Security**: Never log secrets. Parameterized SQL queries. Validate inputs at boundaries.

3. **Run tests** before committing:
   ```bash
   bun test
   ```
   All 104+ tests must pass. If you added new functionality, add tests for it.

4. **Commit** with descriptive messages:
   ```
   type(scope): description
   ```
   Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`
   Scopes: `broker`, `server`, `cli`, `federation`, `shared`

   Examples:
   ```
   feat(server): add retry logic for broker registration
   fix(broker): prevent duplicate message delivery on reconnect
   test(federation): add TLS handshake timeout test
   ```

## Testing

Tests are in `tests/` and use Bun's built-in test runner.

```bash
bun test                           # All tests
bun test tests/broker.test.ts      # Broker + federation endpoints
bun test tests/server.test.ts      # MCP server integration
bun test tests/federation.test.ts  # Federation TLS/PSK/HMAC
bun test tests/cli.test.ts         # CLI + auto-summary
```

The test suite starts its own broker on port **17899** with a temp database to avoid interfering with any running instance.

If tests fail due to a leftover test broker:
```bash
lsof -ti :17899 | xargs kill -9 2>/dev/null
rm -f /tmp/claude-peers-test.db
bun test
```

## Submitting a Pull Request

1. Push your branch to your fork
2. Open a PR against `main` on the upstream repo
3. Fill out the PR template checklist
4. Ensure CI passes (GitHub Actions runs `bun test` automatically)

## What Makes a Good PR

- **Focused**: One feature or fix per PR. Avoid mixing unrelated changes.
- **Tested**: New functionality has tests. Existing tests still pass.
- **Documented**: Update README, CHANGELOG, or TROUBLESHOOTING.md as needed.
- **No secrets**: No tokens, keys, or credentials anywhere in the diff.

## Questions?

Open an issue or check [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for common problems.
