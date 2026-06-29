// NOTE: This is the v1 baseline schema. It is migration version 1 and runs first on every
// database (fresh or existing). Subsequent schema changes are expressed as deltas in MIGRATIONS
// below — do NOT edit the columns/constraints here, or fresh-DB migrations will collide with
// the v2/v3 deltas (duplicate column, mismatched rebuild, etc.).
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
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  agent_profile_id TEXT REFERENCES agent_profiles(id),
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','pr_ready','merged','deploying','deployed','deploy_failed','failed')),
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

CREATE TABLE IF NOT EXISTS deploy_targets (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  name            TEXT NOT NULL,
  path            TEXT NOT NULL,
  deploy_command  TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_deploy_targets_project_id ON deploy_targets(project_id);
`;

export const MIGRATIONS = [
  {
    version: 1,
    sql: SCHEMA_SQL,
  },
  {
    version: 2,
    // Widen the agent_type CHECK to include gemini and glm.
    // SQLite can't ALTER a column constraint, so we recreate the table.
    sql: `
CREATE TABLE IF NOT EXISTS agent_profiles_v2 (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  agent_type    TEXT NOT NULL CHECK(agent_type IN ('claude','opencode','aider','cline','copilot','gemini','glm')),
  cli_path      TEXT,
  credentials_encrypted TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO agent_profiles_v2 (id, name, agent_type, cli_path, credentials_encrypted, created_at)
  SELECT id, name, agent_type, cli_path, credentials_encrypted, created_at FROM agent_profiles;
DROP TABLE agent_profiles;
ALTER TABLE agent_profiles_v2 RENAME TO agent_profiles;
`,
  },
  {
    version: 3,
    // Add per-profile default model and per-task model override.
    sql: `
ALTER TABLE agent_profiles ADD COLUMN model TEXT;
ALTER TABLE tasks ADD COLUMN model TEXT;
`,
  },
  {
    version: 4,
    // Add source column to track how projects were created (manual vs scan).
    sql: `
ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'scan'));
`,
  },
  {
    version: 5,
    // Threads: first-class, non-PR agent conversations (brainstorm / insights).
    // Mirrors tasks/task_logs but drops the PR-lifecycle columns — a thread has
    // no status, worktree, or PR; it just persists session_id for resume.
    sql: `
CREATE TABLE IF NOT EXISTS threads (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  agent_profile_id TEXT REFERENCES agent_profiles(id),
  title            TEXT,
  session_id       TEXT,
  model            TEXT,
  token_usage      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS thread_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  role       TEXT NOT NULL CHECK(role IN ('user','agent')),
  chunk      TEXT NOT NULL,
  timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id ON thread_messages(thread_id);
`,
  },
];
