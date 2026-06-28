# Getting Started

This guide assumes you've never heard of mandor. By the end you'll have a server running on an always-on host, reachable from your phone, dispatching a coding task that ends in a Pull Request.

---

## The mental model: host, devices, network

mandor is a **server**. Servers run *somewhere* and are reached *from elsewhere*. With mandor there are three pieces:

```
 ┌──────────────────────────┐        network         ┌─────────────────────────┐
 │  YOUR DEVICES (clients)  │  ◄──── HTTP/SSE ────►  │  THE HOST (mandor)      │
 │  phone · laptop · tablet │   Tailscale or proxy   │  repos · agents · keys  │
 └──────────────────────────┘                         └─────────────────────────┘
                                                                │
                                                                │  git push + PR
                                                                ▼
                                                          ┌──────────┐
                                                          │  GitHub  │
                                                          └──────────┘
```

- **The host** is an always-on machine you control (a cloud VM, a home server, a Mac mini, even an old laptop that stays plugged in). It holds the things the agents need: your **cloned repos**, your **git + GitHub credentials**, your **agent API keys**, and the **agent runtimes**. mandor runs here as a single binary.
- **Your devices** are *thin clients*. They do nothing but send HTTP requests (`POST /tasks`) and read live progress (SSE). A phone has no git, no agents, no keys — it just talks to the host.
- **The network** is how your devices reach the host. The easiest, safest default is a private mesh VPN like [Tailscale](https://tailscale.com) (no port forwarding, end-to-end encrypted). For public access you'd put mandor behind a reverse proxy with TLS and auth.

> **Key idea:** agents run **on the host**, never on your phone. Your phone only sends the order and watches the result.

---

## Prerequisites

### Infrastructure

| Requirement | Why | Notes |
|---|---|---|
| **An always-on host** | Agents run here; tasks take minutes to hours and your phone won't be the one working | A $5/mo cloud VM (DigitalOcean/Hetzner/AWS), a home server, or any machine that stays on. 1 vCPU / 1 GB RAM is enough to start. |
| **Network path to the host** | So your phone/laptop can reach mandor's HTTP port | **Tailscale** (recommended — install on host + device, done) **or** a public domain + reverse proxy (Caddy/nginx) with TLS. |
| **A GitHub account + repo access** | mandor pushes branches and opens PRs on your behalf | The host must be able to push to your repos and create PRs (see below). |

### Software (installed on the host)

- **Git** ≥ 2.20 — mandor creates `git worktree`s per task.
- **[GitHub CLI](https://cli.github.com) (`gh`)**, authenticated (`gh auth login`) — the agent uses it to push branches and open PRs. Your git must also be able to push (SSH key or HTTPS credential helper).
- **An agent runtime + API key:**
  - **Claude (default, recommended)** — works out of the box: the SDK is bundled in the binary. You only need an `ANTHROPIC_API_KEY`.
  - **Other agents** (OpenCode, Aider, Cline, Copilot CLI) — install their CLI on the host and reference it via the profile's `cli_path`. They run as subprocesses.
- *(Optional)* **[Bun](https://bun.sh)** — only if you build from source or run from source instead of using the pre-built binary.

> Nothing is installed on your phone/laptop/tablet except a way to reach the host (e.g. the Tailscale app) and any HTTP client (a browser, `curl`, or a small script).

---

## Step 1 — Set up the host

SSH into your always-on host and install mandor.

### Install the binary (no toolchain needed)

```bash
# Linux x64
curl -L https://github.com/yanmii-inc/Mandor/releases/latest/download/mandor-linux-x64 -o /usr/local/bin/mandor && chmod +x /usr/local/bin/mandor

# macOS Apple Silicon
curl -L https://github.com/yanmii-inc/Mandor/releases/latest/download/mandor-darwin-arm64 -o /usr/local/bin/mandor && chmod +x /usr/local/bin/mandor

# macOS Intel
curl -L https://github.com/yanmii-inc/Mandor/releases/latest/download/mandor-darwin-x64 -o /usr/local/bin/mandor && chmod +x /usr/local/bin/mandor
```

<details>
<summary>Build from source instead (requires Bun)</summary>

```bash
git clone https://github.com/yanmii-inc/Mandor.git
cd mandor && bun install && bun run build
cp mandor /usr/local/bin/
```

Or run directly from source without a global install: `bun run start` (server) / `bun run init`.

</details>

### Authenticate git + GitHub on the host

The agent will commit, push, and open PRs *as you* from this machine, so set up credentials once:

```bash
gh auth login          # authenticates gh AND configures git credentials
ssh-keygen ...         # (if your repos use SSH) add the key to GitHub
ssh -T git@github.com  # verify push access
```

### Clone the repos you want to manage

mandor runs agents inside **local clones** — so every repo you want to work on must be cloned onto the host:

```bash
mkdir -p ~/code && cd ~/code
git clone git@github.com:you/my-app.git
git clone git@github.com:you/another-repo.git
```

### Set your agent API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # for Claude (also usable for preflight)
# Optionally, for other providers:
# export GEMINI_API_KEY=...
# export GLM_API_KEY=...
# export GITHUB_TOKEN=ghp_...           # used to poll PR state
```

(Put these in a `.env` or your service definition so they persist — see [Deployment](DEPLOYMENT.md).)

---

## Step 2 — Make the host reachable from your devices

You have two good options. **Tailscale is the recommended default** — it's private, encrypted, and needs no port forwarding.

### Option A — Tailscale (recommended, private)

1. Install Tailscale on the **host** and on your **device** (phone/laptop): follow [tailscale.com/download](https://tailscale.com/download).
2. Sign both into the same tailnet.
3. The host now has a stable private address — either its Tailscale IP (`100.x.y.z`) or a [MagicDNS](https://tailscale.com/kb/1081/magicdns) name. Your device reaches mandor at, e.g.:

   ```
   http://mandor-host:3000      # or  http://100.x.y.z:3000
   ```

That's it — your phone can now talk to mandor over an encrypted link, and nobody else on the internet can.

### Option B — Public reverse proxy (if you need a public URL)

Put mandor behind a TLS-terminating proxy with an auth layer. **The mandor API has no built-in authentication**, so do **not** expose `:3000` directly to the public internet. A minimal [Caddy](https://caddyserver.com) example:

```caddyfile
mandor.example.com {
    basicauth /* {
        your-user $2a$14$...bcrypt-hash...
    }
    reverse_proxy localhost:3000
}
```

Now your devices use `https://mandor.example.com`. (See [Deployment](DEPLOYMENT.md) for the full proxy + security notes.)

---

## Step 3 — Register your projects

Stamp each cloned repo so the server can discover it:

```bash
cd ~/code/my-app
mandor init                 # creates a .mandor.json sign file (name from the dir)
mandor init custom-name     # ...or override the name
```

The sign file:

```json
{
  "name": "my-app",
  "repo_url": "git@github.com:you/my-app.git"
}
```

Tell mandor **where** to look for these files. Set workspace roots via env, a config file, or just run it from the parent directory:

```bash
export WORKSPACE_ROOTS='["~/code", "~/work"]'     # JSON array or comma-separated
# or create ~/.mandor/config.json: { "workspaceRoots": ["~/code"] }
```

---

## Step 4 — Start the server

```bash
mandor                      # starts on http://0.0.0.0:3000
```

On startup it scans your workspace roots and registers every repo that has a `.mandor.json`. For a production setup (auto-restart, on-boot) run it under systemd — see [Deployment](DEPLOYMENT.md).

You can also re-scan without restarting:

```bash
curl -X POST http://localhost:3000/projects/scan
```

---

## Step 5 — Create an agent profile

A profile binds a name to an agent type (and optionally an API key / model). From the host:

```bash
curl -X POST http://localhost:3000/agent-profiles \
  -H 'Content-Type: application/json' \
  -d '{"name":"claude-dev","agent_type":"claude"}'
```

Valid `agent_type`: `claude`, `gemini`, `glm`, `opencode`, `aider`, `cline`, `copilot`.
The API key is read from the profile's `credentials_encrypted` or the matching env var (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GLM_API_KEY`).

Grab a project id and (optionally) set it as the project's default profile:

```bash
curl http://localhost:3000/projects
```

---

## Step 6 — Dispatch your first task

### From the host (sanity check)

```bash
curl -X POST http://localhost:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "project_id":"<project-id>",
    "description":"Add JWT-based authentication"
  }'
```

### From your phone 📱

This is the whole point. With the host reachable (Step 2), fire the same request from *anywhere* — your phone's browser, a shortcut, a script:

```bash
curl -X POST http://mandor-host:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"project_id":"<project-id>","description":"Fix the flaky checkout test"}'
```

You'll get back a `task_id`. A fast model first classifies the task's complexity — anything `complex` stays `pending` until you confirm it (a guardrail against runaway work).

---

## Step 7 — Watch it work, then review

**Watch live** (SSE stream — open from any device):

```bash
curl -N http://mandor-host:3000/tasks/<task-id>/logs
```

You'll see the agent's reasoning and tool calls in real time. Other things you can do mid-flight:

```bash
# Send a follow-up — the agent continues with full context (Claude sessions)
curl -X POST http://mandor-host:3000/tasks/<task-id>/reply \
  -H 'Content-Type: application/json' -d '{"message":"Also add rate limiting"}'

# Approve a task that preflight flagged as complex
curl -X POST http://mandor-host:3000/tasks/<task-id>/confirm

# Cancel a running task (kills the agent, cleans up its worktree)
curl -X DELETE http://mandor-host:3000/tasks/<task-id>
```

When the agent finishes, it commits, pushes a branch, and opens a **Pull Request**. The task moves to `pr_ready`, then `merged` once you merge it on GitHub.

```
pending ──► running ──► pr_ready ──► merged
                │                  │
                └──► failed        └──► failed
```

Review and merge the PR from anywhere — your phone included. 🎉

---

## Where to go next

- **[API Reference](API.md)** — every endpoint (projects, tasks, agents, tokens, models).
- **[Architecture](ARCHITECTURE.md)** — agent adapter pattern, worktree isolation, preflight, data model.
- **[Deployment](DEPLOYMENT.md)** — systemd unit, env vars, networking, and security hardening.
