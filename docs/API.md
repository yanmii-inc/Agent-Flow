# API Reference

## Base URL

All endpoints are served from `http://<host>:<port>`. Default: `http://0.0.0.0:3000`.

## Models

### Discover Available Models

```
GET /models
```

Returns the selectable models per provider. Only models in this catalog are accepted; an invalid `model` returns a 400 with the allowed list.

Returns `200`:

```json
{
  "claude": [
    { "id": "claude-sonnet-4-5-20250929", "label": "Claude Sonnet 4.5" },
    { "id": "claude-opus-4-20250514", "label": "Claude Opus 4" },
    { "id": "claude-3-5-haiku-20241022", "label": "Claude 3.5 Haiku" }
  ],
  "gemini": [
    { "id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash" },
    { "id": "gemini-1.5-pro", "label": "Gemini 1.5 Pro" },
    { "id": "gemini-1.5-flash", "label": "Gemini 1.5 Flash" }
  ],
  "glm": [
    { "id": "glm-5", "label": "GLM-5" },
    { "id": "glm-4.7", "label": "GLM-4.7" },
    { "id": "glm-4.7-flash", "label": "GLM-4.7 Flash" }
  ]
}
```

## Projects

### Create a Project

```
POST /projects
```

```json
{
  "name": "my-app",
  "repo_url": "https://github.com/you/my-app.git",
  "local_path": "/home/ubuntu/my-app",
  "agent_profile_id": "optional-uuid",
  "targets": [
    {
      "name": "production",
      "path": "/var/www/app",
      "deploy_command": "npm run build && pm2 restart app"
    }
  ]
}
```

Returns `201` with the created project (including any targets).

### Scan Workspace Roots

```
POST /projects/scan
```

Scans directories for `.mandor.json` sign files. Upserts discovered projects (keyed by `local_path`) and deletes stale scan-sourced projects whose sign file was removed.

The roots to scan are resolved in this order:

1. `roots` field in the request body (optional)
2. `WORKSPACE_ROOTS` env var (JSON array or comma-separated)
3. `~/.mandor/config.json` → `workspaceRoots`
4. Server's current working directory (`process.cwd()`)

Request body (optional):

```json
{
  "roots": ["~/code", "~/work"]
}
```

Returns `200`:

```json
{
  "created": 2,
  "updated": 1,
  "deleted": 0,
  "projects": [
    {
      "id": "uuid",
      "name": "my-app",
      "repo_url": "https://github.com/you/my-app.git",
      "local_path": "/home/you/code/my-app",
      "agent_profile_id": null,
      "source": "scan",
      "created_at": "2026-06-21 10:11:16"
    }
  ]
}
```

### List Projects

```
GET /projects
```

Returns `200` with an array of projects. Each project now includes a `source` field:

| `source` | Meaning |
|---|---|
| `manual` | Created via `POST /projects` — never auto-deleted |
| `scan` | Discovered from a `.mandor.json` sign file — auto-deleted when the file is removed |

### Deploy Targets

#### Create a Deploy Target

```
POST /projects/:id/targets
```

```json
{
  "name": "staging",
  "path": "/var/www/staging",
  "deploy_command": "docker compose up -d --build"
}
```

Returns `201`.

#### List Deploy Targets

```
GET /projects/:id/targets
```

Returns `200` with an array of deploy targets.

#### Update a Deploy Target

```
PUT /projects/:id/targets/:targetId
```

```json
{
  "deploy_command": "npm run build && pm2 restart app"
}
```

Returns `200`.

#### Delete a Deploy Target

```
DELETE /projects/:id/targets/:targetId
```

Returns `204`.

## Agent Profiles

### Create an Agent Profile

```
POST /agent-profiles
```

```json
{
  "name": "my-claude",
  "agent_type": "claude",
  "credentials_encrypted": "sk-ant-v0...",
  "model": "claude-sonnet-4-5-20250929"
}
```

`agent_type` must be one of: `claude`, `gemini`, `glm`, `opencode`, `aider`, `cline`, `copilot`.

| Provider | API Key Source | Default Model |
|---|---|---|
| `claude` | `credentials_encrypted` or `ANTHROPIC_API_KEY` env | `claude-sonnet-4-5-20250929` |
| `gemini` | `credentials_encrypted` or `GEMINI_API_KEY` env | `gemini-2.0-flash` |
| `glm` | `credentials_encrypted` or `GLM_API_KEY` env | `glm-5` |

The `model` field is optional. When omitted, the provider's default model is used.

Returns `201` with the created profile.

### List Agent Profiles

```
GET /agent-profiles
```

Returns `200` with an array of profiles.

### Get Agent Profile

```
GET /agent-profiles/:id
```

Returns `200` with the profile, or `404`.

### Update Agent Profile

```
PATCH /agent-profiles/:id
```

```json
{
  "name": "renamed-profile",
  "model": "claude-opus-4-20250514"
}
```

Only provided fields are updated. Set `model` to `null` to clear the profile default (reverts to provider default).

Returns `200` with the updated profile.

## Tasks

### Model Resolution

When dispatching a task, the effective model is resolved in this order:

```
task.model → profile.model → provider default (from catalog)
```

If the task or profile doesn't specify a model, the provider's default is used.

### Dispatch a Task

```
POST /tasks
```

```json
{
  "project_id": "uuid",
  "description": "Fix the failing test",
  "agent_profile_id": "optional-uuid",
  "model": "claude-opus-4-20250514"
}
```

Triggers a preflight complexity check. Returns `201` with the task.

- `agent_profile_id` — overrides the project's default profile for this task
- `model` — overrides the profile's default model for this task (validated against the resolved provider)

If the preflight returns `complex` and the task is not pre-confirmed, it stays `pending` until confirmed.

### List Tasks

```
GET /tasks
GET /tasks?project_id=<uuid>
```

Returns `200` with an array of tasks.

### Get Task Detail

```
GET /tasks/:id
```

Returns `200` with the task object, or `404`.

### Stream Task Logs (SSE)

```
GET /tasks/:id/logs
```

Returns a `text/event-stream` with these event types:

```
event: log
data: {"id":1,"task_id":"...","role":"agent","chunk":"Analyzing...","timestamp":"..."}

event: message
data: {"type":"text","content":"Found the relevant files","timestamp":"..."}

event: done
data: {"taskId":"..."}

event: error
data: {"message":"..."}
```

### Confirm a Complex Task

```
POST /tasks/:id/confirm
```

Marks a complex task as confirmed and dispatches it. Returns `200`.

### Reply to a Running Task

```
POST /tasks/:id/reply
```

```json
{
  "message": "Add rate limiting too"
}
```

Resumes the agent session via `session_id`. Returns `200`.

### Delete / Kill a Task

```
DELETE /tasks/:id
```

Kills the running agent, cleans up the worktree, marks as failed. Returns `204`.

## Threads

A **thread** is a non-PR agent conversation — brainstorming, codebase questions, "how does X work?". Unlike a task, a thread creates no worktree, runs no preflight, never commits/pushes/opens a PR, and never deploys. It runs **read-only** against the project's real repo and persists a `session_id` so the conversation resumes turn after turn.

Threads require an agent that supports resume:

| `agent_type` | Resume mechanism |
|---|---|
| `claude` | Native session resume |
| `gemini`, `glm` | Resume by rebuilding context from stored history |
| `opencode`, `aider`, `cline`, `copilot` | Not supported — rejected with `400` |

Read-only behavior:

- `claude` threads run in Claude's `plan` mode (read, search, reason — no edits).
- `gemini`/`glm` threads expose only `read_file` (no grep/glob/bash in this release).

### Model Resolution

Same as tasks:

```
thread.model → profile.model → provider default (from catalog)
```

### Create a Thread

```
POST /threads
```

```json
{
  "project_id": "uuid",
  "message": "How does the orchestrator decide when a task is done?",
  "agent_profile_id": "optional-uuid",
  "title": "optional title",
  "model": "claude-sonnet-4-5-20250929"
}
```

- `message` — the first user turn (required)
- `agent_profile_id` — overrides the project's default profile; must be a resumable type (`claude`/`gemini`/`glm`)
- `title` — optional; defaults to the first 60 characters of `message`
- `model` — overrides the profile's default model (validated against the resolved provider)

Returns `201` with the created thread. The first turn runs immediately; `session_id` is populated from the stream as the agent responds:

```json
{
  "id": "uuid",
  "project_id": "uuid",
  "agent_profile_id": "uuid",
  "title": "How does the orchestrator decide when a task is done?",
  "session_id": "dc44cfab-...",
  "model": null,
  "token_usage": null,
  "created_at": "2026-06-29 14:02:53",
  "updated_at": "2026-06-29 14:02:53"
}
```

A thread with no `session_id` cannot be replied to (its first turn didn't complete).

### List Threads

```
GET /threads
GET /threads?project_id=<uuid>
```

Returns `200` with an array of threads.

### Get Thread Detail

```
GET /threads/:id
```

Returns `200` with the thread object, or `404`.

### Reply to a Thread

```
POST /threads/:id/reply
```

```json
{
  "message": "Summarize that in one sentence."
}
```

Resumes the conversation via the thread's `session_id` (native for Claude; history-rebuild for gemini/glm). Returns `200`.

Returns `409` if a turn is already in progress for this thread, or `400` if the thread has no `session_id` yet.

### Stream Thread Logs (SSE)

```
GET /threads/:id/logs
```

Returns a `text/event-stream`. Existing messages are replayed first, then live turns are streamed. Unlike `/tasks/:id/logs`, a thread stream **stays open across turns** — it closes only when the client disconnects. A `message` with `type: "done"` signals that a single turn finished, not that the stream ended.

```
event: log
data: {"id":1,"thread_id":"...","role":"user","chunk":"How does...","timestamp":"..."}

event: message
data: {"type":"text","content":"The orchestrator polls GitHub...","timestamp":"..."}

event: error
data: {"message":"..."}
```

### Delete a Thread

```
DELETE /threads/:id
```

Aborts any in-flight turn and deletes the thread and its messages. Returns `204`.

## CLI

### Scan

```
mandor scan [dir...]
```

Runs a workspace scan from the CLI (no server needed). Uses the same `MANDOR_DB_PATH` and root resolution as the API endpoint.

| Args | Behavior |
|---|---|
| _(none)_ | Scans `process.cwd()` |
| `dir...` | Scans the given directories |

```bash
mandor scan
mandor scan ~/code ~/work
```

### Init

```
mandor init [name]
```

Creates a `.mandor.json` sign file in the current directory.

| Args | Behavior |
|---|---|
| _(none)_ | Uses the directory name as the project name |
| `name` | Overrides the project name |

Detects `git remote get-url origin` and writes it as `repo_url` if available.

## Tokens

### Usage Summary

```
GET /tokens
```

Returns `200`:

```json
{
  "total_input": 15000,
  "total_output": 32000,
  "total_tokens": 47000,
  "task_count": 3
}
```

## Task Lifecycle

```
pending ──► running ──► pr_ready ──► merged
                  │                    │
                  └──► failed          └──► failed
```

| Status | Description |
|---|---|
| `pending` | Created, preflight running or waiting for confirmation |
| `running` | Agent actively working in an isolated worktree |
| `pr_ready` | Agent finished, PR created |
| `merged` | PR merged (manual, via GitHub) |
| `failed` | Agent errored or was killed |
