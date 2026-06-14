export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_profiles (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  agent_type    TEXT NOT NULL CHECK(agent_type IN ('claude','opencode','aider','cline','copilot')),
  cli_path      TEXT,
  credentials_encrypted TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  repo_url        TEXT NOT NULL,
  local_path      TEXT NOT NULL,
  agent_profile_id TEXT REFERENCES agent_profiles(id),
  deploy_config   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  agent_profile_id TEXT REFERENCES agent_profiles(id),
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','pr_ready','merged','failed')),
  worktree_path    TEXT,
  branch_name      TEXT,
  pr_url           TEXT,
  session_id       TEXT,
  complexity       TEXT CHECK(complexity IN ('simple','medium','complex')),
  token_usage      TEXT,
  confirmed        INTEGER NOT NULL DEFAULT 0,
  has_own_workflow INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL REFERENCES tasks(id),
  role      TEXT NOT NULL CHECK(role IN ('user','agent')),
  chunk     TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
`;

export const MIGRATIONS = [
  {
    version: 1,
    sql: SCHEMA_SQL,
  },
];
