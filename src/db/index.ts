import { Database } from 'bun:sqlite';
import { SCHEMA_SQL } from './schema';
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

  constructor(path: string = 'agentflow.db') {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
  }

  // ── Projects ──────────────────────────────────────────────

  createProject(input: CreateProjectInput): Project {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(
      `INSERT INTO projects (id, name, repo_url, local_path, agent_profile_id)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(id, input.name, input.repo_url, input.local_path, input.agent_profile_id ?? null);

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

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[];
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
      `INSERT INTO agent_profiles (id, name, agent_type, cli_path, credentials_encrypted)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(id, input.name, input.agent_type, input.cli_path ?? null, input.credentials_encrypted ?? null);
    return this.getAgentProfile(id)!;
  }

  getAgentProfile(id: string): AgentProfile | undefined {
    return this.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as AgentProfile | undefined;
  }

  listAgentProfiles(): AgentProfile[] {
    return this.db.prepare('SELECT * FROM agent_profiles ORDER BY created_at DESC').all() as AgentProfile[];
  }

  // ── Tasks ─────────────────────────────────────────────────

  createTask(input: CreateTaskInput): Task {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, project_id, agent_profile_id, description)
       VALUES (?, ?, ?, ?)`
    );
    stmt.run(id, input.project_id, input.agent_profile_id ?? null, input.description);
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
