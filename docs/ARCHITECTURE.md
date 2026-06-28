# Architecture

mandor is a single long-lived process — a Bun HTTP server backed by SQLite — that turns AI coding agents into a dispatchable, always-on crew. It owns the execution environment (your cloned repos, git/GitHub credentials, and agent API keys) so your devices only need to send tasks and read progress.

> This document covers the **internals**: how a task flows through the system and how each piece is built. For the host/devices/network deployment model, see [Getting Started](GETTING_STARTED.md); for the HTTP surface, see the [API Reference](API.md).

## System context

```
Devices (phone/laptop) ──HTTP/SSE──► mandor server (always-on host) ──git push + PR──► GitHub
                                              │
                                              ├── cloned repos (local_path)
                                              ├── per-task git worktrees (.worktrees/<id>, beside each repo)
                                              └── agent adapters (Claude SDK in-process · others as subprocess CLIs)
```

mandor is **stack-agnostic**: it knows nothing about your language, framework, or build system. It maps a task description to an isolated worktree, lets the agent work, and converts the result into a reviewable PR.

## Request lifecycle

A task flows through the orchestrator like this (`src/orchestrator/index.ts`):

```
POST /tasks ──► dispatchTask
                 │
                 1. resolve model:  task.model → profile.model → provider default
                 2. preflight:      classify complexity (simple | medium | complex)
                    └─ complex & not confirmed ──► stays pending (await POST /tasks/:id/confirm)
                 3. worktree:       git worktree add → branch agent/<id>-<slug>, path <repo>/../.worktrees/<id>
                 4. prompt:         repo's own workflow (AGENTS.md, CLAUDE.md, …) or mandor's commit/push/PR fallback
                 5. adapter.start() Claude via SDK in-process; others as subprocess
                 6. adapter.stream() ──► broadcast to SSE clients + append to task_logs
                    ├─ capture session_id (enables mid-task resume)
                    ├─ done ──► waitForPR  (poll GitHub every 30s, ≤ 30 min)
                    │            ├─ PR open  ──► status pr_ready  (+ worktree cleanup)
                    │            └─ PR merged──► status merged    (+ deploy targets + cleanup)
                    └─ error ──► status failed  (+ worktree cleanup)
```

Mid-flight, `POST /tasks/:id/reply` resumes the agent session with full context, and `DELETE /tasks/:id` kills it and tears down the worktree. Every transition is persisted to `tasks`; every message to `task_logs` — so the conversation can be replayed from any device.

## Agent Adapter Pattern

Every agent CLI is wrapped in a uniform interface at `src/agents/base.ts`:

```typescript
interface AgentAdapter {
  start(task: Task, worktreePath: string): Promise<void>
  resume(sessionId: string, message: string): Promise<void>
  stream(): AsyncIterable<AgentMessage>
  getTokenUsage(): TokenUsage
  kill(): Promise<void>
}
```

Adding a new agent means implementing 5 methods. The `AgentRegistry` at `src/agents/registry.ts` resolves profiles to adapters.

### Claude Code (Native SDK)

Uses `@anthropic-ai/claude-agent-sdk` directly — not a subprocess. This enables session persistence:

- `session_id` captured on first dispatch, stored in the database
- `POST /tasks/:id/reply` resumes via `resume: sessionId` — the agent retains full context

### Other Agents (Subprocess)

OpenCode, Aider, etc. run via `execa` subprocess. Stdout is captured and converted into the shared `AgentMessage` format. Session resume is not supported for these (the Claude SDK is the only agent with native session persistence).

## Git Worktree Isolation

```
main ────── agent/abc123-add-auth ────── worktree at ../.worktrees/abc123
     \────── agent/def456-fix-bug ────── worktree at ../.worktrees/def456
```

Managed by `src/orchestrator/worktree.ts`:

1. **Create** — `git worktree add -b agent/<id>-<slug> <path>`
2. **Commit & Push** — `git add . && git commit && git push origin <branch>`
3. **Open PR** — `gh pr create --head <branch> --title ... --body ...`
4. **Cleanup** — `git worktree remove <path>`, branch deleted locally and remotely

On failure, worktree is cleaned up immediately. Agents never touch `main`.

## Preflight

`src/orchestrator/preflight.ts` calls Claude Haiku with the task description:

```json
{
  "complexity": "simple | medium | complex",
  "estimated_tokens": { "min": 1000, "max": 5000 },
  "reasoning": "Clear requirements, ~3 files affected"
}
```

- **simple / medium** → dispatched immediately
- **complex** → stays `pending`, requires `POST /tasks/:id/confirm`

If the Haiku call fails, it defaults to `medium` so tasks aren't blocked.

## Task → Thread

Every user message and agent response is stored in `task_logs` with a `role` field (`'user' | 'agent'`). This creates a persistent conversation thread that can be replayed from any device.

For Claude Code, the `session_id` on the task enables resume with full context — the agent remembers files it read, changes it made, and decisions it took.

## Project Structure

```
mandor/
├── src/
│   ├── api/
│   │   ├── routes/
│   │   │   ├── tasks.ts        ← Task CRUD + SSE + reply + confirm
│   │   │   ├── projects.ts     ← Project CRUD
│   │   │   ├── agents.ts       ← Agent profile CRUD
│   │   │   └── tokens.ts       ← Token usage summary
│   │   └── server.ts           ← Bun HTTP server, request routing
│   ├── agents/
│   │   ├── base.ts             ← AgentAdapter interface, types
│   │   ├── claude.ts           ← @anthropic-ai/claude-agent-sdk
│   │   ├── opencode.ts         ← execa subprocess adapter
│   │   ├── aider.ts            ← execa subprocess adapter
│   │   └── registry.ts         ← Profile → adapter resolver
│   ├── orchestrator/
│   │   ├── index.ts            ← Task lifecycle, SSE broadcast
│   │   ├── worktree.ts         ← git worktree create/commit/PR/cleanup
│   │   ├── preflight.ts        ← Haiku complexity classification
│   │   └── tokens.ts           ← Per-task token usage tracking
│   ├── db/
│   │   ├── schema.ts           ← SQLite DDL
│   │   └── index.ts            ← Database wrapper
│   └── index.ts                ← Entry point
├── docs/
│   ├── GETTING_STARTED.md
│   ├── API.md
│   ├── ARCHITECTURE.md
│   └── DEPLOYMENT.md
├── package.json
├── tsconfig.json
├── bunfig.toml
└── .gitignore
```

## Data Model

```sql
-- Agent CLI configurations with encrypted credentials
agent_profiles (
  id, name, agent_type, cli_path,
  credentials_encrypted, created_at
)

-- Git repos the orchestrator manages
projects (
  id, name, repo_url, local_path,
  agent_profile_id, deploy_config, created_at
)

-- Individual task dispatches
tasks (
  id, project_id, agent_profile_id, description,
  status, worktree_path, branch_name, pr_url,
  session_id, complexity, token_usage, confirmed,
  created_at, updated_at
)

-- Streaming log of user messages + agent responses
task_logs (
  id, task_id, role, chunk, timestamp
)
```

## SSE Streaming

`GET /tasks/:id/logs` returns a `ReadableStream` with `Content-Type: text/event-stream`:

- **Existing logs** are sent immediately on connect
- **New messages** are broadcast via the orchestrator's pub/sub to all connected SSE clients
- **Connection close** is detected via `req.signal.addEventListener('abort', ...)`
