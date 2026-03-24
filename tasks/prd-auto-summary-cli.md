# PRD: Deterministic Auto-Summary CLI Command

## Introduction

Add a new `auto-summary` command to `cli.ts` that generates a deterministic (no LLM) summary string from the current environment and sets it on a registered peer via the broker's `/set-summary` endpoint. This command replaces the non-deterministic OpenAI-powered auto-summary that currently runs on MCP server startup in `server.ts`. It is designed to be called by a SessionStart hook (separate PRD) so that every Claude Code session gets an immediate, reliable peer summary without requiring an API key or network call to OpenAI.

## Goals

- Provide a zero-dependency, deterministic summary generation CLI command that requires no API keys
- Produce a human-readable summary string from git context and optional TaskMaster state
- Integrate cleanly into the existing `cli.ts` command structure (switch/case pattern, `brokerFetch` helper)
- Support graceful degradation: non-git directories work, missing TaskMaster works, broker-down is handled
- Maintain the existing test patterns from `broker.test.ts` (real broker on test port, integration tests)
- Be callable as `bun cli.ts auto-summary <peer-id>` with clear exit codes for hook consumers

## User Stories

### US-001: Generate deterministic summary from git context

**Description:** As a Claude Code SessionStart hook, I want to call `bun cli.ts auto-summary <peer-id>` so that my peer's summary is set immediately on startup without waiting for an LLM API call.

**Acceptance Criteria:**
- [ ] Running `bun cli.ts auto-summary <peer-id>` with a valid peer ID in a git repo sets a summary on the broker
- [ ] Summary format for a git directory: `[<repo-name>:<branch>] Working in <cwd>`
- [ ] Repo name is derived from the basename of the git root (e.g., `/home/riche/MCPs/claude-peers-mcp` produces `claude-peers-mcp`)
- [ ] Branch name comes from `git rev-parse --abbrev-ref HEAD`
- [ ] Command prints the generated summary to stdout on success
- [ ] Command exits with code 0 on success

### US-002: Graceful handling of non-git directories

**Description:** As a SessionStart hook running in a directory without git, I want `auto-summary` to still produce a useful summary so that peers can see my working directory.

**Acceptance Criteria:**
- [ ] In a non-git directory, summary format is: `Working in <cwd>`
- [ ] No repo/branch prefix when git info is unavailable
- [ ] Command still exits with code 0 (summary is valid, just less detailed)

### US-003: Include TaskMaster state when available

**Description:** As a developer using TaskMaster for project management, I want the auto-summary to reflect my in-progress tasks so that peers know what I am working on.

**Acceptance Criteria:**
- [ ] If `task-master` CLI is installed and the current directory has TaskMaster data, the summary includes task count: `[<repo>:<branch>] 3 in-progress tasks`
- [ ] If `task-master` is not installed (command not found), the summary falls back to the basic format without error
- [ ] If `task-master list` returns an error or empty result, the summary falls back to the basic format without error
- [ ] TaskMaster check has a 2-second timeout to prevent hanging on a stuck process

### US-004: Handle broker unavailability

**Description:** As a hook caller, I need the command to fail gracefully when the broker is not running so that session startup is not blocked.

**Acceptance Criteria:**
- [ ] If the broker is not reachable at `BROKER_URL`, the command prints an error message to stderr
- [ ] Exit code is 1 when the broker is unreachable
- [ ] The error message is actionable: `Error: Broker not reachable at <url>. Is it running?`

### US-005: Handle invalid peer ID

**Description:** As a hook caller, I need clear error feedback when the peer ID does not exist on the broker.

**Acceptance Criteria:**
- [ ] If the broker returns an error for the `/set-summary` call (e.g., peer not found), print the error to stderr
- [ ] Exit code is 1 on any broker error
- [ ] The generated summary is still printed to stdout (useful for debugging even if the set failed)

### US-006: Missing peer-id argument

**Description:** As a CLI user, I need a clear usage message when I forget the required argument.

**Acceptance Criteria:**
- [ ] Running `bun cli.ts auto-summary` without a peer ID prints: `Usage: bun cli.ts auto-summary <peer-id>`
- [ ] Exit code is 1

## Functional Requirements

- **FR-1**: Add `auto-summary` case to the `switch (cmd)` block in `cli.ts` (line 38)
- **FR-2**: Implement `getGitRepoName(cwd: string): Promise<string | null>` — runs `git rev-parse --show-toplevel`, returns `path.basename()` of the result, or null if not a git repo
- **FR-3**: Implement `getGitBranchName(cwd: string): Promise<string | null>` — runs `git rev-parse --abbrev-ref HEAD`, returns trimmed output or null
- **FR-4**: Implement `getTaskMasterInProgress(cwd: string): Promise<number | null>` — runs `task-master list --status=in_progress` with a 2s timeout, parses and counts tasks, returns count or null on any failure
- **FR-5**: Implement `buildSummary(opts: { repoName: string | null; branch: string | null; cwd: string; taskCount: number | null }): string` — pure function that assembles the summary string deterministically
- **FR-6**: The `auto-summary` command orchestrates: gather context (FR-2 through FR-4), build summary (FR-5), POST to broker `/set-summary` endpoint using existing `brokerFetch` helper
- **FR-7**: Summary format rules (in `buildSummary`):
  - Git repo + branch + tasks: `[<repo>:<branch>] <N> in-progress tasks`
  - Git repo + branch, no tasks: `[<repo>:<branch>] Working in <cwd>`
  - No git context: `Working in <cwd>`
- **FR-8**: Update the CLI usage/help text (the `default` case at line 181) to include the new `auto-summary` command
- **FR-9**: Update the doc comment at the top of `cli.ts` (lines 2-13) to list the new command

## Non-Goals (Out of Scope)

- **No `--format` flag**: Custom format templates are a stretch goal for a future iteration, not v1
- **No LLM fallback**: This command is purely deterministic. The existing OpenAI-based summary in `server.ts` is not modified or removed
- **No auto-detection of peer ID**: The caller must provide the peer ID. The SessionStart hook knows its own ID
- **No broker auto-start**: Unlike `server.ts`, the CLI does not call `ensureBroker()`. The broker must already be running
- **No modifications to `server.ts`**: The existing LLM-based auto-summary on startup remains. The hook (separate PRD) will supersede it by calling `auto-summary` after registration
- **No modifications to `broker.ts`**: The existing `/set-summary` endpoint is sufficient
- **No modifications to `shared/types.ts`**: No new types needed; `SetSummaryRequest` already exists
- **No modifications to `shared/summarize.ts`**: The new helpers live in `cli.ts` (they are CLI-specific, not shared)
- **No integration with the SessionStart hook**: That is a separate PRD that lives in `~/.claude/hooks/`

## Technical Considerations

### File Paths (All Changes)

| File | Change Type | Description |
|------|-------------|-------------|
| `/home/riche/MCPs/claude-peers-mcp/cli.ts` | Modify | Add `auto-summary` case, helper functions, update help text |
| `/home/riche/MCPs/claude-peers-mcp/cli.test.ts` | Create | New test file for auto-summary logic (unit tests for `buildSummary`, integration tests for the full command) |

### Dependencies

- **Bun runtime**: All subprocess spawning uses `Bun.spawn()` / `Bun.spawnSync()` (consistent with existing codebase)
- **git**: Must be installed (universally true on dev machines; already a dependency of `shared/summarize.ts`)
- **task-master**: Optional. Detected via `Bun.spawnSync(["which", "task-master"])` or caught error on spawn
- **Existing `brokerFetch` helper**: Reuse the one already in `cli.ts` (line 18-34). No duplication needed

### Subprocess Execution

- Use `Bun.spawnSync()` for git commands (fast, <50ms) — consistent with `cli.ts`'s existing `kill-broker` case which uses `Bun.spawnSync`
- Use `Bun.spawn()` with timeout for `task-master list` (may be slow or hang)
- All subprocesses: `stderr: "ignore"` to avoid noise, `stdout: "pipe"` to capture output

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Summary generated and set successfully |
| 1 | Missing argument, broker unreachable, or broker returned error |

### Testing Strategy

Create `/home/riche/MCPs/claude-peers-mcp/cli.test.ts` following `broker.test.ts` patterns:

1. **Unit tests for `buildSummary`** (pure function, no broker needed):
   - Git repo + branch + tasks produces expected format
   - Git repo + branch, no tasks produces expected format
   - No git info produces expected format
   - Null values handled correctly

2. **Integration tests for `auto-summary` command** (requires running test broker):
   - Register a peer on test broker, run `auto-summary` via `Bun.spawn(["bun", "cli.ts", "auto-summary", peerId])`, verify summary was set via `/list-peers`
   - Run with missing peer-id argument, verify exit code 1 and usage message on stderr
   - Run with invalid peer-id, verify exit code 1

3. **Test lifecycle**: Spin up broker on `TEST_PORT` (17899) with temp DB, same as `broker.test.ts`

To make `buildSummary` testable, export it from `cli.ts`. Since `cli.ts` is both an entry point and now a module, the switch block must be guarded with `if (import.meta.main)` or the helpers must be extracted. Preferred approach: **export the helper functions** at the module level, wrap the CLI switch block in an `if (Bun.main === import.meta.path)` guard (Bun's equivalent of `if __name__ == "__main__"`). This is a minor refactor that preserves all existing behavior.

### Pattern: Existing CLI Command for Reference

The `set-name` command (line 137-158) is the closest analog to `auto-summary`:
- Takes a peer ID argument
- POSTs to a broker endpoint
- Handles success/error with appropriate messages
- Simple, linear flow

## Success Metrics

| Metric | Target |
|--------|--------|
| Command execution time | <500ms in a git repo without TaskMaster |
| Tests passing | All new tests in `cli.test.ts` pass via `bun test cli.test.ts` |
| Existing tests unbroken | All 19 tests in `broker.test.ts` still pass |
| Determinism | Same inputs always produce same summary string (no randomness, no LLM) |
| Zero external dependencies | No API keys, no network calls beyond localhost broker |

## Open Questions

1. **TaskMaster output format**: The `task-master list --status=in_progress` output format needs to be verified at implementation time. The implementer should run the command and parse accordingly. If the output is JSON, parse it; if plain text, count the lines. If the command interface has changed, adapt gracefully.

2. **`buildSummary` export strategy**: The preferred approach is wrapping the CLI switch in `if (Bun.main === import.meta.path)`. If Bun's `Bun.main` API is unavailable or behaves unexpectedly, an alternative is to extract helpers into a separate `cli-helpers.ts` file (but this adds file count and is less preferred).

3. **Session name in summary**: Should the summary include the session name (if set) in addition to the repo/branch info? Current design says no -- the session name is a separate field on the peer record. But if a hook sets both `set-name` and `auto-summary`, the summary could optionally reference it. Decision: **No** for v1, keep them independent.
