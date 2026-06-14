import simpleGit from 'simple-git';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

export interface WorktreeResult {
  path: string;
  branch: string;
}

export class WorktreeManager {
  private git;
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  async create(taskId: string, description: string): Promise<WorktreeResult> {
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);

    const branch = `agent/${taskId}-${slug}`;
    const worktreePath = join(this.repoPath, '..', `.worktrees/${taskId}`);

    const exists = await this.git.branch(['--list', branch]);
    if (!exists) {
      await this.git.checkoutLocalBranch(branch);
    } else {
      await this.git.checkout(branch);
    }

    await this.git.raw(['worktree', 'add', worktreePath, branch]);

    return { path: worktreePath, branch };
  }

  async cleanup(worktreePath: string): Promise<void> {
    try {
      await this.git.raw(['worktree', 'remove', worktreePath]);
    } catch {}

    try {
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    } catch {}
  }
}
