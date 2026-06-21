# Getting Started

## Prerequisites

- [Bun](https://bun.sh) >= 1.2
- Git >= 2.30
- [GitHub CLI](https://cli.github.com) `gh` (for automated PRs)
- An API key for your chosen agent (e.g. `ANTHROPIC_API_KEY` for Claude)

## Install

```bash
git clone <your-repo>/consign.git
cd consign
bun install
```

## Run

```bash
# Development (with watch)
bun run dev

# Production
bun run src/index.ts

# Single binary
bun build --compile
```

The server starts on `http://0.0.0.0:3000`.

## Configure

### Create a Project

```bash
curl -X POST http://localhost:3000/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-app",
    "repo_url": "https://github.com/you/my-app.git",
    "local_path": "/home/ubuntu/my-app"
  }'
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Human-readable project name |
| `repo_url` | yes | Git remote URL |
| `local_path` | yes | Path where the repo is cloned on the VM |
| `agent_profile_id` | no | Default agent profile for this project |
| `deploy_config` | no | JSON string with deployment settings |

### Create an Agent Profile

```bash
curl -X POST http://localhost:3000/agent-profiles \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "claude-dev",
    "agent_type": "claude"
  }'
```

Valid `agent_type` values: `claude`, `opencode`, `aider`, `cline`, `copilot`

## Dispatch Your First Task

```bash
curl -X POST http://localhost:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "project_id": "<project-id>",
    "description": "Add user authentication with JWT tokens"
  }'
```

### Watch It Work

```bash
curl -N http://localhost:3000/tasks/<task-id>/logs
```

This opens an SSE stream — you'll see the agent's output in real-time.

### Send a Follow-Up

```bash
curl -X POST http://localhost:3000/tasks/<task-id>/reply \
  -H 'Content-Type: application/json' \
  -d '{"message": "Add rate limiting too"}'
```

### Approve a Complex Task

If preflight flags a task as `complex`, it stays `pending`. Approve it:

```bash
curl -X POST http://localhost:3000/tasks/<task-id>/confirm
```

### Kill a Running Task

```bash
curl -X DELETE http://localhost:3000/tasks/<task-id>
```
