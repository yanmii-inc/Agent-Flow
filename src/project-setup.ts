import { execa } from 'execa';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';

export const SIGN_FILE = '.mandor.json';

export interface EnsureProjectOptions {
  name: string;
  repoUrl: string;
  /** On-server path; may start with `~` (resolved against the home dir). */
  localPath: string;
}

export interface EnsureProjectResult {
  /** Resolved absolute path (leading `~` expanded). */
  localPath: string;
  /** True if the repo was cloned during this call. */
  cloned: boolean;
  /** True if the `.mandor.json` sign file was created during this call. */
  initialized: boolean;
}

/** Expand a leading `~` to the user's home dir (cross-platform via os.homedir). */
export function resolveHome(p: string): string {
  return p.replace(/^~/, os.homedir());
}

/**
 * Ensure a project exists on disk:
 *   1. If the directory doesn't exist, clone the repo into it.
 *   2. If `.mandor.json` is missing, initialize the project.
 * Returns the resolved absolute path and what was done. Logs every step.
 */
export async function ensureProject(opts: EnsureProjectOptions): Promise<EnsureProjectResult> {
  const localPath = path.resolve(resolveHome(opts.localPath));
  const signPath = path.join(localPath, SIGN_FILE);

  console.log(`[project-setup] ensureProject start for "${opts.name}"`);
  console.log(`[project-setup]   local_path: ${opts.localPath} -> ${localPath}`);
  console.log(`[project-setup]   repo_url:   ${opts.repoUrl}`);

  let cloned = false;
  let initialized = false;

  // 1. Clone the repo if the target directory doesn't exist yet.
  if (!existsSync(localPath)) {
    console.log(`[project-setup] directory does not exist; cloning into ${localPath}`);
    await mkdir(path.dirname(localPath), { recursive: true });
    const result = await execa('git', ['clone', opts.repoUrl, localPath], { reject: false });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || '').toString().trim();
      console.error(`[project-setup] git clone failed (exit ${result.exitCode}): ${detail}`);
      throw new Error(`git clone failed for ${opts.repoUrl}: ${detail || `exit code ${result.exitCode}`}`);
    }
    cloned = true;
    console.log(`[project-setup] clone complete -> ${localPath}`);
  } else {
    console.log(`[project-setup] directory already exists; skipping clone: ${localPath}`);
  }

  // 2. Initialize mandor if the sign file is missing.
  if (!existsSync(signPath)) {
    console.log(`[project-setup] no ${SIGN_FILE} found; initializing in ${localPath}`);
    const sign = { name: opts.name, repo_url: opts.repoUrl };
    await writeFile(signPath, JSON.stringify(sign, null, 2) + '\n');
    initialized = true;
    console.log(`[project-setup] created ${signPath}`);
  } else {
    console.log(`[project-setup] ${SIGN_FILE} already present; skipping init: ${signPath}`);
  }

  console.log(`[project-setup] ensureProject done (cloned=${cloned}, initialized=${initialized})`);
  return { localPath, cloned, initialized };
}
