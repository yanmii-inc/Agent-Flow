// ── Data Types ──────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  repo_url: string;
  local_path: string;
  agent_profile_id: string | null;
  created_at: string;
}

export interface DeployTarget {
  id: string;
  project_id: string;
  name: string;
  path: string;
  deploy_command: string;
  created_at: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  agent_type: AgentType;
  cli_path: string | null;
  credentials_encrypted: string | null;
  created_at: string;
}

export type AgentType = 'claude' | 'opencode' | 'aider' | 'cline' | 'copilot';

export type TaskStatus = 'pending' | 'running' | 'pr_ready' | 'merged' | 'deploying' | 'deployed' | 'deploy_failed' | 'failed';
export type Complexity = 'simple' | 'medium' | 'complex';

export interface Task {
  id: string;
  project_id: string;
  agent_profile_id: string | null;
  description: string;
  status: TaskStatus;
  worktree_path: string | null;
  branch_name: string | null;
  pr_url: string | null;
  session_id: string | null;
  complexity: Complexity | null;
  token_usage: string | null;
  confirmed: number;
  has_own_workflow: number;
  created_at: string;
  updated_at: string;
}

export interface TaskLog {
  id: number;
  task_id: string;
  role: 'user' | 'agent';
  chunk: string;
  timestamp: string;
}

// ── Input Types ─────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  repo_url: string;
  local_path: string;
  agent_profile_id?: string;
  targets?: { name: string; path: string; deploy_command: string }[];
}

export interface CreateDeployTargetInput {
  name: string;
  path: string;
  deploy_command: string;
}

export interface CreateAgentProfileInput {
  name: string;
  agent_type: AgentType;
  cli_path?: string;
  credentials_encrypted?: string;
}

export interface CreateTaskInput {
  project_id: string;
  agent_profile_id?: string;
  description: string;
}

// ── Agent Interface ─────────────────────────────────────────

export interface AgentMessage {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'done';
  content: string;
  timestamp: Date;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface PreflightResult {
  complexity: Complexity;
  estimated_tokens: { min: number; max: number };
  reasoning: string;
}

export interface AgentAdapter {
  /** Start a new agent session. If `prompt` is provided it is used instead of `task.description`. */
  start(task: Task, worktreePath: string, prompt?: string): Promise<void>;
  resume(sessionId: string, message: string): Promise<void>;
  stream(): AsyncIterable<AgentMessage>;
  getTokenUsage(): TokenUsage;
  kill(): Promise<void>;
}

// ── SSE Types ───────────────────────────────────────────────

export interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
}

// ── Helpers ─────────────────────────────────────────────────

export function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return { [Symbol.asyncIterator]: async function* () {} };
}
