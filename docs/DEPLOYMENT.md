# Deployment

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server host |
| `MANDOR_DB_PATH` | `mandor.db` | SQLite database path |
| `ANTHROPIC_API_KEY` | — | API key for Claude (preflight + SDK) |

## System Service (Linux)

Create `/etc/systemd/system/mandor.service`:

```ini
[Unit]
Description=mandor
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/mandor
ExecStart=/opt/mandor/mandor
Environment=PORT=3000
Environment=HOST=0.0.0.0
Environment=MANDOR_DB_PATH=/opt/mandor/data/mandor.db
Environment=ANTHROPIC_API_KEY=sk-ant-...
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mandor
```

## Single Binary

```bash
bun build src/index.ts --compile --target=bun --outfile=mandor
```

This produces a self-contained executable at `./mandor`. Copy it to your VM and run:

```bash
./mandor
```

## Security

- API keys are **encrypted at rest** in SQLite via `credentials_encrypted`
- Credentials are **never exposed** through the API
- Tasks run in **isolated git worktrees** — agents can't touch `main`
- The `permissionMode: 'acceptEdits'` option on Claude Code auto-accepts file edits without prompts in automated mode
- Consider running mandor behind a reverse proxy (nginx, Caddy) with TLS and optional auth
