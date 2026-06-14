import { execa } from 'execa';
import type { Db } from '../db/index';
import type { DeployTarget } from '../agents/base';

/**
 * On PR merge, detect which deploy targets are affected by changed files
 * and run their deploy commands.
 *
 * agentflow never assumes project structure — deploy targets are always
 * user-defined at project registration. agentflow never decides how or
 * where to deploy — it only runs the deploy_command the user provides.
 *
 * @example
 * // Monorepo with multiple apps
 * { name: "api",      path: "apps/api",      deploy_command: "make deploy-api" }
 * { name: "web",      path: "apps/web",      deploy_command: "make deploy-web" }
 * { name: "consumer", path: "apps/consumer", deploy_command: "make deploy-consumer" }
 *
 * // Single app project
 * { name: "app", path: ".", deploy_command: "make deploy" }
 *
 * // Different structure
 * { name: "backend",   path: "server",        deploy_command: "cd server && ./deploy.sh" }
 * { name: "dashboard", path: "client/admin",  deploy_command: "cd client/admin && ./deploy.sh" }
 */
export async function deployAffectedTargets(
  projectId: string,
  prUrl: string,
  taskId: string,
  db: Db,
  repoPath: string,
  githubToken?: string,
): Promise<void> {
  db.updateTask(taskId, { status: 'deploying' });

  // 1. Get list of changed files from GitHub API for the merged PR
  const changedPaths = await getChangedPaths(prUrl, githubToken);
  if (!changedPaths || changedPaths.length === 0) {
    db.appendLog(taskId, 'agent', '[deploy] No changed files detected, skipping deploy');
    db.updateTask(taskId, { status: 'failed' });
    return;
  }

  // 2. Load deploy targets for this project
  const targets = db.getDeployTargets(projectId);
  if (targets.length === 0) {
    db.appendLog(taskId, 'agent', '[deploy] No deploy targets configured, skipping');
    return;
  }

  // 3. Find affected targets — any target whose path prefix matches a changed file
  const affected = targets.filter(target =>
    changedPaths.some(p => p.startsWith(target.path))
  );

  if (affected.length === 0) {
    db.appendLog(taskId, 'agent', '[deploy] No deploy targets affected by changed files');
    return;
  }

  // 4. Run deploy_command for each affected target
  let allSucceeded = true;
  for (const target of affected) {
    db.appendLog(taskId, 'agent', `[deploy] Deploying target "${target.name}" (path: ${target.path})`);

    try {
      const result = await execa('sh', ['-c', target.deploy_command], {
        cwd: repoPath,
        all: true,
      });

      const output = result.all?.toString() ?? '';
      db.appendLog(taskId, 'agent', `[deploy] ${target.name}: ${output}`);
    } catch (err: any) {
      allSucceeded = false;
      const msg = err.all?.toString() ?? err.message ?? String(err);
      db.appendLog(taskId, 'agent', `[deploy] ${target.name} FAILED: ${msg}`);
    }
  }

  db.updateTask(taskId, { status: allSucceeded ? 'deployed' : 'deploy_failed' });
}

async function getChangedPaths(prUrl: string, githubToken?: string): Promise<string[] | null> {
  try {
    // Parse PR URL to get owner/repo/number
    // Format: https://github.com/owner/repo/pull/123
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;

    const [, owner, repo, prNumber] = match;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
    };
    if (githubToken) {
      headers.Authorization = `Bearer ${githubToken}`;
    }

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
      { headers }
    );

    if (!response.ok) return null;

    const files = await response.json() as any[];
    return files.map((f: any) => f.filename);
  } catch {
    return null;
  }
}
