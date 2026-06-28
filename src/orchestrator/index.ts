import { existsSync } from 'fs';
import { join } from 'path';
import type { Db } from '../db/index';
import type { AgentAdapter, Task, AgentMessage } from '../agents/base';
import { AgentRegistry } from '../agents/registry';
import { WorktreeManager } from './worktree';
import { runPreflight } from './preflight';
import { getDefaultModel } from '../agents/models';
import { createTokenTracker, updateTokenUsage } from './tokens';
import { deployAffectedTargets } from './deploy';

export interface RunningTask {
  task: Task;
  adapter: AgentAdapter;
  abortController: AbortController;
}

const runningTasks = new Map<string, RunningTask>();
const sseClients = new Map<string, Set<(msg: AgentMessage) => void>>();

/**
 * Files that indicate a repo already has its own AI workflow setup.
 * Priority hierarchy (highest to lowest):
 *   1. Repo's own workflow setup (AGENTS.md, CLAUDE.md, skills, guardrails)
 *   2. mandor fallback instructions (injected only if repo has nothing)
 *   3. Agent's own built-in defaults
 */
const WORKFLOW_INDICATORS = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '.agents/workflow.md',
  '.cursor/rules',
  'guardrails.md',
];

const FALLBACK_INSTRUCTIONS = `No workflow setup was detected in this repo.
When your task is complete:
- Stage and commit all changes with a clear descriptive commit message
- Push the branch to origin
- Open a PR against main with a summary of what was changed and why
Focus only on the task. Do not ask for confirmation before committing.`;

async function detectWorkflow(repoPath: string): Promise<boolean> {
  for (const file of WORKFLOW_INDICATORS) {
    if (existsSync(join(repoPath, file))) return true;
  }
  return false;
}

function buildAgentPrompt(description: string, hasWorkflow: boolean): string {
  if (hasWorkflow) {
    return description;
  }
  return `${FALLBACK_INSTRUCTIONS}\n\n${description}`;
}

function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const cleaned = repoUrl
    .replace(/^git@[^:]+:/, '')
    .replace(/^https:\/\/[^\/]+\//, '')
    .replace(/\.git$/, '')
    .trim();
  const parts = cleaned.split('/');
  return { owner: parts[0], repo: parts[1] ?? '' };
}

async function pollGitHub(
  url: string,
  githubToken?: string,
): Promise<any[] | null> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
    };
    if (githubToken) {
      headers.Authorization = `Bearer ${githubToken}`;
    }
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return await response.json() as any[];
  } catch {
    return null;
  }
}

export class Orchestrator {
  private db: Db;
  private registry: AgentRegistry;

  constructor(db: Db) {
    this.db = db;
    this.registry = new AgentRegistry(db);
  }

  async dispatchTask(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const project = this.db.getProject(task.project_id);
    if (!project) throw new Error(`Project ${task.project_id} not found`);

    const profileId = task.agent_profile_id ?? project.agent_profile_id;
    const profile = profileId ? this.db.getAgentProfile(profileId) : undefined;

    const providerMap: Record<string, 'anthropic' | 'gemini' | 'glm'> = {
      gemini: 'gemini',
      glm: 'glm',
      claude: 'anthropic',
      opencode: 'anthropic',
      aider: 'anthropic',
      cline: 'anthropic',
      copilot: 'anthropic',
    };
    const provider = providerMap[profile?.agent_type ?? 'claude'];
    const apiKey = profile?.credentials_encrypted ?? undefined;

    const preflight = await runPreflight(task.description, apiKey, provider);
    this.db.updateTask(task.id, { complexity: preflight.complexity });

    if (preflight.complexity === 'complex' && !task.confirmed) {
      return;
    }

    const hasWorkflow = await detectWorkflow(project.local_path);
    this.db.updateTask(task.id, { status: 'running', has_own_workflow: hasWorkflow ? 1 : 0 });

    const wt = new WorktreeManager(project.local_path);
    const { path: worktreePath, branch } = await wt.create(taskId, task.description);
    this.db.updateTask(task.id, { worktree_path: worktreePath, branch_name: branch });

    const agentPrompt = buildAgentPrompt(task.description, hasWorkflow);

    const adapter = profile
      ? this.registry.resolve(profile)
      : this.registry.resolveByType('claude');

    const abort = new AbortController();

    // Effective model: per-task override → profile default → provider default.
    const agentType = profile?.agent_type ?? 'claude';
    const effectiveModel = task.model ?? profile?.model ?? getDefaultModel(agentType);

    await adapter.start(task, worktreePath, agentPrompt, effectiveModel ?? undefined);

    const rt: RunningTask = { task, adapter, abortController: abort };
    runningTasks.set(taskId, rt);

    createTokenTracker(taskId);

    const { owner, repo } = parseRepoUrl(project.repo_url);
    const githubToken = process.env['GITHUB_TOKEN'];
    this.processStream(taskId, adapter, wt, owner, repo, project.local_path, githubToken);
  }

  private async processStream(
    taskId: string,
    adapter: AgentAdapter,
    wt: WorktreeManager,
    owner: string,
    repo: string,
    repoPath: string,
    githubToken?: string,
  ): Promise<void> {
    const task = this.db.getTask(taskId)!;

    try {
      let sessionId: string | null = null;

      for await (const message of adapter.stream()) {
        this.broadcastToSSEClients(taskId, message);

        if (message.type === 'text') {
          this.db.appendLog(taskId, 'agent', message.content);
          try {
            const parsed = JSON.parse(message.content);
            if (parsed.session_id) {
              sessionId = parsed.session_id;
            }
          } catch {}
        }

        if (message.type === 'tool_use') {
          this.db.appendLog(taskId, 'agent', `[tool_use] ${message.content}`);
        }

        if (message.type === 'done') {
          const usage = adapter.getTokenUsage();
          updateTokenUsage(taskId, usage);
          this.db.updateTask(taskId, {
            token_usage: JSON.stringify(usage),
            session_id: sessionId,
          });

          const currentTask = this.db.getTask(taskId);
          if (currentTask?.branch_name) {
            await this.waitForPR(taskId, currentTask.branch_name, owner, repo, repoPath, githubToken, wt);
          }
        }

        if (message.type === 'error') {
          this.db.appendLog(taskId, 'agent', `[error] ${message.content}`);
          this.db.updateTask(taskId, { status: 'failed' });
          const currentTask = this.db.getTask(taskId);
          if (currentTask?.worktree_path) {
            await wt.cleanup(currentTask.worktree_path);
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        const msg = err.message ?? String(err);
        this.db.appendLog(taskId, 'agent', `[error] ${msg}`);
        this.db.updateTask(taskId, { status: 'failed' });
        const currentTask = this.db.getTask(taskId);
        if (currentTask?.worktree_path) {
          await wt.cleanup(currentTask.worktree_path);
        }
      }
    } finally {
      runningTasks.delete(taskId);
    }
  }

  /**
   * Poll GitHub every 30s for the task's PR lifecycle:
   *   pr_ready — PR was opened (head matches branch)
   *   merged   — PR changed to merged state
   *
   * When merged, triggers deploy of affected targets.
   * Times out after 30 minutes.
   */
  private async waitForPR(
    taskId: string,
    branch: string,
    owner: string,
    repo: string,
    repoPath: string,
    githubToken?: string,
    wt?: WorktreeManager,
  ): Promise<void> {
    const maxAttempts = 60;
    const pollInterval = 30_000;

    for (let i = 0; i < maxAttempts; i++) {
      const encodedBranch = encodeURIComponent(branch);
      const prs = await pollGitHub(
        `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodedBranch}&state=all`,
        githubToken,
      );

      if (prs && prs.length > 0) {
        const pr = prs[0];

        if (pr.merged_at || pr.merged) {
          // PR was merged
          this.db.updateTask(taskId, { status: 'merged', pr_url: pr.html_url });

          // Deploy any affected targets
          const currentTask = this.db.getTask(taskId);
          if (currentTask && owner && repo) {
            await deployAffectedTargets(
              currentTask.project_id,
              pr.html_url,
              taskId,
              this.db,
              repoPath,
              githubToken,
            );
          }

          // Clean up worktree after merge + deploy
          if (currentTask?.worktree_path && wt) {
            await wt.cleanup(currentTask.worktree_path);
          }
          return;
        }

        if (pr.state === 'open') {
          // PR is open but not yet merged — mark pr_ready if not already
          const currentTask = this.db.getTask(taskId);
          if (currentTask?.status !== 'pr_ready') {
            this.db.updateTask(taskId, { status: 'pr_ready', pr_url: pr.html_url });
            if (currentTask?.worktree_path && wt) {
              await wt.cleanup(currentTask.worktree_path);
            }
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    this.db.updateTask(taskId, { status: 'failed' });
    const currentTask = this.db.getTask(taskId);
    if (currentTask?.worktree_path && wt) {
      await wt.cleanup(currentTask.worktree_path);
    }
  }

  async reply(taskId: string, message: string): Promise<void> {
    this.db.appendLog(taskId, 'user', message);

    const running = runningTasks.get(taskId);
    if (running) {
      const task = this.db.getTask(taskId);
      if (task?.session_id) {
        await running.adapter.resume(task.session_id, message);
        const currentTask = this.db.getTask(taskId)!;
        const project = this.db.getProject(currentTask.project_id);
        const { owner, repo } = project ? parseRepoUrl(project.repo_url) : { owner: '', repo: '' };
        const githubToken = process.env['GITHUB_TOKEN'];
        this.processStream(taskId, running.adapter, new WorktreeManager(''), owner, repo, '', githubToken);
      }
    } else {
      throw new Error('Task not currently running; resume not implemented for completed tasks');
    }
  }

  async killTask(taskId: string): Promise<void> {
    const running = runningTasks.get(taskId);
    if (running) {
      await running.adapter.kill();
      running.abortController.abort();
      runningTasks.delete(taskId);
    }

    const task = this.db.getTask(taskId);
    if (task?.worktree_path) {
      const project = this.db.getProject(task.project_id);
      if (project) {
        const wt = new WorktreeManager(project.local_path);
        await wt.cleanup(task.worktree_path);
      }
    }

    this.db.updateTask(taskId, { status: 'failed' });
  }

  // ── SSE ───────────────────────────────────────────────────

  subscribeToSSE(taskId: string, callback: (msg: AgentMessage) => void): () => void {
    if (!sseClients.has(taskId)) {
      sseClients.set(taskId, new Set());
    }
    sseClients.get(taskId)!.add(callback);
    return () => sseClients.get(taskId)?.delete(callback);
  }

  private broadcastToSSEClients(taskId: string, message: AgentMessage): void {
    const clients = sseClients.get(taskId);
    if (clients) {
      for (const cb of clients) {
        try { cb(message); } catch {}
      }
    }
  }
}
