// ── Data Types ──────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  repo_url: string;
  local_path: string;
  agent_profile_id: string | null;
  source: 'manual' | 'scan';
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
  model: string | null;
  created_at: string;
}

export type AgentType = 'claude' | 'opencode' | 'aider' | 'cline' | 'copilot' | 'gemini' | 'glm';

/**
 * Agent types that support session resume, and therefore can back a multi-turn
 * thread. Claude resumes natively; gemini/glm rebuild from stored history.
 * opencode/aider/cline/copilot have no resume support yet.
 */
export const RESUMABLE_AGENT_TYPES: AgentType[] = ['claude', 'gemini', 'glm'];

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
  model: string | null;
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

/**
 * A Thread is a non-PR agent conversation (brainstorm / insights / "how does X
 * work?"). Unlike a Task it has no status machine, worktree, branch, or PR — it
 * just persists `session_id` so the conversation can be resumed turn after turn.
 */
export interface Thread {
  id: string;
  project_id: string;
  agent_profile_id: string | null;
  title: string | null;
  session_id: string | null;
  model: string | null;
  token_usage: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThreadMessage {
  id: number;
  thread_id: string;
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
  source?: 'manual' | 'scan';
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
  model?: string;
}

export interface CreateTaskInput {
  project_id: string;
  agent_profile_id?: string;
  description: string;
  model?: string;
}

export interface CreateThreadInput {
  project_id: string;
  agent_profile_id?: string;
  /** First user turn of the conversation. */
  message: string;
  title?: string;
  model?: string;
}

// ── Agent Interface ─────────────────────────────────────────

export interface AgentMessage {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'done';
  content: string;
  timestamp: Date;
}

/**
 * Claude Code permission modes (kept SDK-free here). Threads run in `'plan'`
 * (read-only reasoning) so they need no worktree — the agent can read the repo
 * but cannot mutate it.
 */
export type PermissionModeValue = 'default' | 'acceptEdits' | 'plan';

export interface AgentStartOptions {
  /** Defaults to `'acceptEdits'` (current task behavior) when omitted. */
  permissionMode?: PermissionModeValue;
}

export interface AgentResumeOptions {
  /** Explicit credentials so `resume` works on a freshly-resolved adapter. */
  apiKey?: string;
  model?: string;
  permissionMode?: PermissionModeValue;
  /** Working directory for the resumed turn (freshly-resolved adapters have none). */
  cwd?: string;
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
  /**
   * Start a new agent session. If `prompt` is provided it is used instead of `task.description`.
   * `model` is the resolved model id (task override → profile default → provider default);
   * CLI-based adapters that manage models themselves may ignore it.
   */
  start(task: Task, worktreePath: string, prompt?: string, model?: string, opts?: AgentStartOptions): Promise<void>;
  resume(sessionId: string, message: string, opts?: AgentResumeOptions): Promise<void>;
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
