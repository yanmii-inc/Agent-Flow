import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import os from 'os';
import type { Db } from './db/index';

interface MandorSignFile {
  name?: string;
  repo_url?: string;
  agent_profile_id?: string;
}

export function getWorkspaceRoots(): string[] {
  const env = process.env['WORKSPACE_ROOTS'];
  if (env) {
    try {
      const parsed = JSON.parse(env);
      if (Array.isArray(parsed)) return parsed.map((p: string) => p.replace(/^~/, os.homedir()));
    } catch {
      return env.split(',').map(s => s.trim().replace(/^~/, os.homedir())).filter(Boolean);
    }
  }

  try {
    const configPath = path.join(os.homedir(), '.mandor', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (Array.isArray(config.workspaceRoots)) {
      return config.workspaceRoots.map((p: string) => p.replace(/^~/, os.homedir()));
    }
  } catch {}

  return [process.cwd()];
}

function findSignFiles(root: string, maxDepth: number = 5): string[] {
  if (!existsSync(root)) return [];

  const results: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !entry.name.startsWith('node_modules')) {
            walk(fullPath, depth + 1);
          }
        } else if (entry.name === '.mandor.json') {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  walk(root, 0);
  return results;
}

function readSignFile(filePath: string): MandorSignFile | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    console.warn(`  Warning: Invalid ${filePath}, skipping`);
    return null;
  }
}

export interface ScanResult {
  created: number;
  updated: number;
  deleted: number;
  projects: ReturnType<Db['listProjects']>;
}

export function scanWorkspaces(db: Db, roots?: string[]): ScanResult {
  if (!roots || roots.length === 0) {
    roots = getWorkspaceRoots();
  }
  const foundPaths: Set<string> = new Set();
  let created = 0;
  let updated = 0;

  for (const root of roots) {
    const signFiles = findSignFiles(root);
    for (const signFilePath of signFiles) {
      const projectDir = path.dirname(signFilePath);
      const localPath = path.resolve(projectDir);
      foundPaths.add(localPath);

      const sign = readSignFile(signFilePath);
      if (!sign) continue;

      const name = sign.name || path.basename(projectDir);
      const repoUrl = sign.repo_url || '';

      const existing = db.getProjectByLocalPath(localPath);
      if (existing) {
        db.updateProject(existing.id, {
          name,
          repo_url: repoUrl,
          agent_profile_id: sign.agent_profile_id ?? null,
        });
        updated++;
      } else {
        try {
          db.createProject({
            name,
            repo_url: repoUrl,
            local_path: localPath,
            agent_profile_id: sign.agent_profile_id,
            source: 'scan',
          });
          created++;
        } catch (err: any) {
          if (err.message?.includes('UNIQUE')) {
            const disambiguated = `${name} (${path.basename(path.dirname(projectDir))})`;
            try {
              db.createProject({
                name: disambiguated,
                repo_url: repoUrl,
                local_path: localPath,
                agent_profile_id: sign.agent_profile_id,
                source: 'scan',
              });
              created++;
            } catch (innerErr: any) {
              console.warn(`  Warning: Could not create project at ${localPath}: ${innerErr.message}`);
            }
          } else {
            console.warn(`  Warning: Could not create project at ${localPath}: ${err.message}`);
          }
        }
      }
    }
  }

  let deleted = 0;
  const dbPaths = db.listAllLocalPaths();
  for (const dbPath of dbPaths) {
    if (!foundPaths.has(dbPath)) {
      const proj = db.getProjectByLocalPath(dbPath);
      if (proj && proj.source === 'scan') {
        try {
          db.deleteProject(proj.id);
          deleted++;
        } catch (err: any) {
          console.warn(`  Warning: Could not delete project "${proj.name}" at ${proj.local_path}: ${err.message}`);
        }
      }
    }
  }

  return { created, updated, deleted, projects: db.listProjects() };
}
