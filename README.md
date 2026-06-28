<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/mandor-v0.1.0-6C5CE7?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIxOCIgc3Ryb2tlPSIjNkM1Q0U3IiBzdHJva2Utd2lkdGg9IjIiLz48cGF0aCBkPSJNMTIgMjBsNiA2IDEwLTEwIiBzdHJva2U9IiM2QzVDRTciIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PC9zdmc+">
  <img alt="mandor" src="https://img.shields.io/badge/mandor-v0.1.0-6C5CE7?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIxOCIgc3Ryb2tlPSIjNkM1Q0U3IiBzdHJva2Utd2lkdGg9IjIiLz48cGF0aCBkPSJNMTIgMjBsNiA2IDEwLTEwIiBzdHJva2U9IiM2QzVDRTciIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PC9zdmc+">
</picture>

<h1 align="center">mandor</h1>

<p align="center">
  <em>Self-hosted remote AI coding agent orchestrator.</em><br>
  Dispatch tasks from any device → agents implement them → review as PRs.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-000?style=flat-square&logo=bun">
  <img src="https://img.shields.io/badge/lang-TypeScript-3178C6?style=flat-square&logo=typescript">
  <img src="https://img.shields.io/badge/db-SQLite-003B57?style=flat-square&logo=sqlite">
</p>

---

```mermaid
flowchart TD
    subgraph Devices["Your Devices"]
        direction TB
        Phone["Your Phones"]
        Laptop["Your Laptops"]
        Tablet["Your Tablets"]
    end
    subgraph CS["mandor VM"]
        direction LR
        W1["Worktree 1"]
        W2["Worktree 2"]
    end
    subgraph PRs[" "]
        direction TB
        PR1["PR #1"]
        PR2["PR #2"]
    end
    Devices -- "POST /tasks" --> AF
    AF -- "SSE event stream" --> Devices
    W1 --> PR1
    W2 --> PR2
```

---

## Features

- **Agent-agnostic** — Claude Code (native SDK), OpenCode, Aider, Cline, Copilot CLI
- **Isolated execution** — each task in its own `git worktree`
- **Real-time SSE streaming** — watch agents work from any browser
- **Resumable sessions** — send follow-ups from any device via `session_id`
- **Preflight checks** — Haiku classifies complexity; complex tasks need approval
- **Auto PRs** — agent commits, pushes, opens a GitHub PR when done
- **Single binary** — `bun build --compile`
- **Auto-discovery** — `mandor init` stamps any repo with a `.mandor.json` sign file; the server auto-discovers projects by scanning workspace roots

## Docs

- [Getting Started](docs/GETTING_STARTED.md) — install, configure, first task
- [API Reference](docs/API.md) — all endpoints with examples
- [Architecture](docs/ARCHITECTURE.md) — agent adapter, worktree isolation, data model
- [Deployment](docs/DEPLOYMENT.md) — system service, environment variables

## Quick Start

```bash
# One-liner install (macOS ARM) — no toolchain required
curl -L https://github.com/yanmii-inc/Mandor/releases/latest/download/mandor-darwin-arm64 \
  -o /usr/local/bin/mandor && chmod +x /usr/local/bin/mandor

# Stamp any repo
mandor init

# Scan the current directory for projects
mandor scan

# Start the server
mandor
```

Or build from source: `git clone git@github.com:yanmii-inc/Mandor.git && cd mandor && bun install && bun run build`

Full guide → [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)

## Philosophy

mandor is **pure infrastructure**. It knows nothing about your project's stack. It takes a task description, spawns an agent in an isolated worktree, streams the output, and opens a PR. You bring the projects, agents, and review process.
