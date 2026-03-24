# Workflow Pattern: Backlog-to-Ralph Pipeline

## Overview

A repeatable workflow for converting a project backlog into autonomous Ralph-compatible PRDs. Combines PAL MCP strategic planning with the /prd skill's structured output and Ralph's prd.json format for unattended execution.

## When to Use

- Project has an accumulated backlog (FYI.md, issue tracker, etc.)
- Multiple features need PRDs created systematically
- Features vary in size and some need autonomous execution (Ralph)
- Dependency ordering matters

## Pipeline Steps

```
[Backlog]
    |
    v
[1. PAL Planner — Strategic Analysis]
    | - Feed full backlog + codebase context to PAL (recommended: Grok 4.20 or Gemini 3.1 Pro)
    | - Ask: tiering (Ralph vs direct), dependency graph, bundling opportunities, risks
    | - Output: Prioritized execution plan with phases
    |
    v
[2. Tiering Decision]
    | - Ralph-worthy: Medium+ complexity, multiple files, tests needed
    | - Direct subagent: Small (<80 lines), single-file, no tests
    | - Manual: Cross-directory concerns, different project scope
    | - Bundle: Related small items that form a logical unit
    |
    v
[3. Dependency Graph]
    | - Map blocking relationships between backlog items
    | - Identify parallel opportunities (no dependencies = parallel PRD creation)
    | - Flag cross-cutting concerns (e.g., auth changes affect all subsequent PRDs)
    |
    v
[4. Phased PRD Creation]
    | - Phase 1: Create independent PRDs in parallel (subagents)
    | - Phase 2+: Create dependent PRDs sequentially, feeding prior API designs
    | - Each PRD follows /prd skill template
    | - Each PRD includes Ralph-readiness criteria (see below)
    |
    v
[5. Ralph Conversion]
    | - Convert each PRD to prd.json via /ralph skill
    | - Validate prd.json is self-contained for autonomous execution
    |
    v
[6. Execution]
    - Run ralph.sh per prd.json, respecting dependency order
    - PAL codereview on each completed feature
```

## Ralph-Readiness Criteria for PRDs

Every PRD destined for Ralph must include:

1. **Self-contained user stories** — no external knowledge required
2. **Exact file paths** — every file to create/modify is named
3. **Verifiable acceptance criteria** — testable by `bun test`, type checking, or specific assertions
4. **Test requirements** — what tests to write, patterns to follow (reference existing test files)
5. **Non-goals** — explicit scope boundaries to prevent autonomous scope creep
6. **Dependency context** — what must exist before this PRD executes (e.g., "assumes broker auth is implemented per PRD #3")
7. **Definition of done** — clear exit criteria the Ralph loop can verify

## PAL Planner Prompt Template

```
CONTEXT: [Project description, tech stack, current state]

TASK: Create Ralph-compatible PRDs for the entire backlog by priority.

BACKLOG: [Full backlog with priority labels]

QUESTIONS:
1. Which items are too small for Ralph and should be bundled or done directly?
2. What is the dependency graph?
3. Are there cross-cutting concerns that affect PRD ordering?
4. Any architectural risks in the backlog ordering?
5. [Project-specific questions]
```

## Tiering Decision Matrix

| Complexity | Files Touched | Tests Needed | Execution |
|-----------|--------------|-------------|-----------|
| <50 lines | 1 file | No | Direct subagent |
| 50-80 lines | 1-2 files | Maybe | Direct subagent or bundle |
| 80-200 lines | 2-4 files | Yes | Ralph PRD |
| 200+ lines | 4+ files | Yes | Ralph PRD |
| Cross-directory | Any | Any | Manual or separate Ralph |

## Example: claude-peers-mcp Backlog Application

Applied this pipeline to 8 backlog items. Result:
- 6 PRDs created (4 Ralph, 1 manual, 1 bundled two items)
- 2 items classified as direct subagent tasks (too small for Ralph)
- 5 execution phases identified based on dependency graph
- Key insight: server.test.ts deferred until after auth + message protocol to avoid testing a moving API

## Skills Used

| Skill | Role in Pipeline |
|-------|-----------------|
| /prd | PRD generation template and structure |
| /ralph | PRD-to-prd.json conversion |
| /cook or /agent-orchestration | Parallel subagent deployment for independent PRDs |
| /research-methodologies | PAL MCP consultation pattern |
| /development-workflows | Overall task workflow structure |

## Notes

- PAL continuation_id should be preserved across pipeline steps for context continuity
- Subagents cannot use MCP tools (claude-peers, PAL, etc.) — parent must relay
- Cross-directory PRDs (e.g., hooks in ~/.claude/) need separate execution context
- Always validate dependency graph with PAL before creating PRDs — wrong ordering wastes Ralph iterations
