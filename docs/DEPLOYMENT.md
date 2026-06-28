# Deployment

mandor runs as a single long-lived process on an **always-on host**. This page covers what the host needs, how to run it as a service, how to make it reachable from your devices, and how to lock it down.

---

## Host requirements

The host is where the agents actually run, so it needs everything an agent needs:

| Requirement | Detail |
|---|---|
| **Always-on machine** | A cloud VM, home server, or always-plugged-in machine. Agents run for minutes-to-hours; the host must stay up. ~1 vCPU / 1 GB RAM to start. |
| **Git ≥ 2.20** | mandor creates a `git worktree` per task. |
| **GitHub CLI (`gh`), authenticated** | The agent pushes branches and opens PRs via `gh`. Run `gh auth login` on the host. Git must also have push credentials (SSH key or HTTPS). |
| **Agent runtime + key** | Claude (default) needs only `ANTHROPIC_API_KEY` — its SDK is bundled. Other agents (OpenCode, Aider, …) need their CLI installed on the host. |
| **Repos cloned locally** | mandor runs agents inside local clones; clone every repo you want to manage onto the host. |
| **Disk** | Each task adds a worktree (a working copy of the repo) under `<repo>/.worktrees/`. Size them like extra checkouts; they're cleaned up after the PR is merged/cancelled. |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `MANDOR_DB_PATH` | `mandor.db` | SQLite database path |
| `ANTHROPIC_API_KEY` | — | API key for Claude (preflight + agent); can be overridden per profile |
| `GEMINI_API_KEY` | — | API key for Gemini agent profiles |
| `GLM_API_KEY` | — | API key for GLM agent profiles |
| `GITHUB_TOKEN` | — | Used to poll PR state (open/merged). Optional but recommended. |
| `WORKSPACE_ROOTS` | cwd | Where to scan for `.mandor.json` sign files (JSON array or comma-separated) |

## Run as a system service (Linux)

For auto-restart and on-boot startup, run mandor under systemd.

Create `/etc/systemd/system/mandor.service`:

```ini
[Unit]
Description=mandor — AI agent orchestrator
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/mandor
ExecStart=/usr/local/bin/mandor
Environment=PORT=3000
Environment=HOST=0.0.0.0
Environment=MANDOR_DB_PATH=/opt/mandor/data/mandor.db
Environment=WORKSPACE_ROOTS=["/home/ubuntu/code"]
Environment=ANTHROPIC_API_KEY=sk-ant-...
Environment=GITHUB_TOKEN=ghp_...
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mandor
journalctl -u mandor -f     # tail logs
```

## Single binary

```bash
bun build src/index.ts --compile --target=bun --outfile=mandor
```

This produces a self-contained executable at `./mandor`. Copy it to your host and run `./mandor`.

---

## Networking — reaching mandor from your devices

mandor listens on plain HTTP. How your phone/laptop reach it depends on your setup.

### Option A — Tailscale (recommended, private mesh)

The simplest secure option. No port forwarding, end-to-end encrypted, your devices get a stable private address for the host.

1. Install Tailscale on the **host** and on each **device**; sign them into the same tailnet.
2. Reach mandor at the host's Tailscale IP (`100.x.y.z:3000`) or [MagicDNS](https://tailscale.com/kb/1081/magicdns) name (`http://mandor-host:3000`).

Because the link is private and encrypted, this is safe to use as-is — no extra auth strictly required (only your tailnet members can reach it).

### Option B — Public reverse proxy with TLS + auth

If you need a public URL, terminate TLS and add authentication **in front of** mandor. A [Caddy](https://caddyserver.com) example:

```caddyfile
mandor.example.com {
    basicauth /* {
        admin $2a$14$...bcrypt-hash...
    }
    reverse_proxy localhost:3000
}
```

Then bind mandor to localhost only (`HOST=127.0.0.1`) so it's unreachable except through the proxy.

> ⚠️ **Never expose `:3000` directly to the public internet.** The mandor HTTP API has **no built-in authentication or rate limiting**. Anyone who can reach it can dispatch tasks (spending your API budget), read your repos, and push to your GitHub. Use Tailscale, or a proxy with auth + TLS.

---

## Security

- **No built-in API auth.** mandor trusts the network in front of it. Expose it only over Tailscale or behind an authenticated reverse proxy (see above).
- **API keys are encrypted at rest** in SQLite via `credentials_encrypted`; credentials are never returned through the API.
- **Isolated execution** — each task runs in its own `git worktree` on a throwaway branch; agents never touch `main`.
- **Preflight guardrail** — a fast model classifies complexity before spend; `complex` tasks wait for `POST /tasks/:id/confirm`.
- **Auto-accept edits** — Claude runs with `permissionMode: 'acceptEdits'` so it can write files unattended in automated mode.
- **Secrets in env, not code** — keep keys in your service environment / `.env`, not committed to the repo.
