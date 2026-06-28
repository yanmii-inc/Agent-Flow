import { Database } from 'bun:sqlite';
import { MIGRATIONS } from './schema';
import type {
  Project,
  DeployTarget,
  AgentProfile,
  Task,
  TaskLog,
  CreateProjectInput,
  CreateAgentProfileInput,
  CreateTaskInput,
  CreateDeployTargetInput,
} from '../agents/base';

export class Db {
  private db: Database;

  constructor(path: string = 'mandor.db') {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const appliedVersions = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
        .map(r => r.version),
    );

    for (const migration of MIGRATIONS) {
      if (!appliedVersions.has(migration.version)) {
        this.db.transaction(() => {
          this.db.exec(migration.sql);
          this.db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
        })();
      }
    }
  }

  // ── Projects ──────────────────────────────────────────────

  createProject(input: CreateProjectInput): Project {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(
      `INSERT INTO projects (id, name, repo_url, local_path, agent_profile_id, source)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, input.name, input.repo_url, input.local_path, input.agent_profile_id ?? null, input.source ?? 'manual');

    // Create deploy targets if provided
    if (input.targets) {
      for (const t of input.targets) {
        this.createDeployTarget({ project_id: id, ...t });
      }
    }

    return this.getProject(id)!;
  }

  getProject(id: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  getProjectByLocalPath(localPath: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE local_path = ?').get(localPath) as Project | undefined;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[];
  }

  listAllLocalPaths(): string[] {
    return (this.db.prepare('SELECT local_path FROM projects').all() as Pick<Project, 'local_path'>[])
      .map(r => r.local_path);
  }

  updateProject(
    id: string,
    updates: Partial<Pick<Project, 'name' | 'repo_url' | 'agent_profile_id'>>
  ): Project | undefined {
    const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
    if (fields.length === 0) return this.getProject(id);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (updates as any)[f]);
    this.db.prepare(`UPDATE projects SET ${setClause} WHERE id = ?`).run(...values, id);
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    // Cascade delete related records
    this.db.transaction(() => {
      const taskIds = (this.db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(id) as Pick<Task, 'id'>[])
        .map(r => r.id);
      for (const taskId of taskIds) {
        this.db.prepare('DELETE FROM task_logs WHERE task_id = ?').run(taskId);
        this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      }
      this.db.prepare('DELETE FROM deploy_targets WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    })();
    return true;
  }

  // ── Deploy Targets ────────────────────────────────────────

  createDeployTarget(input: CreateDeployTargetInput & { project_id: string }): DeployTarget {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(
      `INSERT INTO deploy_targets (id, project_id, name, path, deploy_command)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(id, input.project_id, input.name, input.path, input.deploy_command);
    return this.getDeployTarget(id)!;
  }

  getDeployTarget(id: string): DeployTarget | undefined {
    return this.db.prepare('SELECT * FROM deploy_targets WHERE id = ?').get(id) as DeployTarget | undefined;
  }

  getDeployTargets(projectId: string): DeployTarget[] {
    return this.db.prepare(
      'SELECT * FROM deploy_targets WHERE project_id = ? ORDER BY created_at ASC'
    ).all(projectId) as DeployTarget[];
  }

  updateDeployTarget(
    id: string,
    updates: Partial<Pick<DeployTarget, 'name' | 'path' | 'deploy_command'>>
  ): DeployTarget | undefined {
    const fields = Object.keys(updates);
    if (fields.length === 0) return this.getDeployTarget(id);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (updates as any)[f]);
    this.db.prepare(`UPDATE deploy_targets SET ${setClause} WHERE id = ?`).run(...values, id);
    return this.getDeployTarget(id);
  }

  deleteDeployTarget(id: string): boolean {
    const info = this.db.prepare('DELETE FROM deploy_targets WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ── Agent Profiles ────────────────────────────────────────

  createAgentProfile(input: CreateAgentProfileInput): AgentProfile {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(
      `INSERT INTO agent_profiles (id, name, agent_type, cli_path, credentials_encrypted, model)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      id,
      input.name,
      input.agent_type,
      input.cli_path ?? null,
      input.credentials_encrypted ?? null,
      input.model ?? null,
    );
    return this.getAgentProfile(id)!;
  }

  getAgentProfile(id: string): AgentProfile | undefined {
    return this.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as AgentProfile | undefined;
  }

  listAgentProfiles(): AgentProfile[] {
    return this.db.prepare('SELECT * FROM agent_profiles ORDER BY created_at DESC').all() as AgentProfile[];
  }

  updateAgentProfile(
    id: string,
    updates: Partial<Pick<AgentProfile, 'name' | 'cli_path' | 'credentials_encrypted' | 'model'>>
  ): AgentProfile | undefined {
    const fields = Object.keys(updates);
    if (fields.length === 0) return this.getAgentProfile(id);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (updates as any)[f]);
    this.db.prepare(`UPDATE agent_profiles SET ${setClause} WHERE id = ?`).run(...values, id);
    return this.getAgentProfile(id);
  }

  // ── Tasks ─────────────────────────────────────────────────

  createTask(input: CreateTaskInput): Task {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, project_id, agent_profile_id, description, model)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(id, input.project_id, input.agent_profile_id ?? null, input.description, input.model ?? null);
    return this.getTask(id)!;
  }

  getTask(id: string): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  }

  listTasks(projectId?: string): Task[] {
    if (projectId) {
      return this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Task[];
    }
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Task[];
  }

  updateTask(id: string, updates: Partial<Omit<Task, 'id' | 'created_at'>>): Task | undefined {
    const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
    if (fields.length === 0) return this.getTask(id);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (updates as any)[f]);
    this.db.prepare(`UPDATE tasks SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    this.db.prepare('DELETE FROM task_logs WHERE task_id = ?').run(id);
    const info = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ── Task Logs ─────────────────────────────────────────────

  appendLog(taskId: string, role: 'user' | 'agent', chunk: string): TaskLog {
    const stmt = this.db.prepare(
      `INSERT INTO task_logs (task_id, role, chunk) VALUES (?, ?, ?)`
    );
    const info = stmt.run(taskId, role, chunk);
    return {
      id: info.lastInsertRowid as number,
      task_id: taskId,
      role,
      chunk,
      timestamp: new Date().toISOString(),
    };
  }

  getTaskLogs(taskId: string, sinceId?: number): TaskLog[] {
    if (sinceId) {
      return this.db.prepare(
        'SELECT * FROM task_logs WHERE task_id = ? AND id > ? ORDER BY id ASC'
      ).all(taskId, sinceId) as TaskLog[];
    }
    return this.db.prepare(
      'SELECT * FROM task_logs WHERE task_id = ? ORDER BY id ASC'
    ).all(taskId) as TaskLog[];
  }

  // ── Token Usage ───────────────────────────────────────────

  getTokenUsageSummary(): { total_input: number; total_output: number; total_tokens: number; task_count: number } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(json_extract(token_usage, '$.input')), 0) as total_input,
        COALESCE(SUM(json_extract(token_usage, '$.output')), 0) as total_output,
        COALESCE(SUM(json_extract(token_usage, '$.total')), 0) as total_tokens,
        COUNT(*) as task_count
      FROM tasks WHERE token_usage IS NOT NULL
    `).get() as any;
    return row;
  }

  close(): void {
    this.db.close();
  }
}
