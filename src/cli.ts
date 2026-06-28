import { existsSync } from 'fs';
import path from 'path';
import { readFile, writeFile } from 'fs/promises';
import { Db } from './db/index';
import { scanWorkspaces } from './scan';

const SIGN_FILE = '.mandor.json';

interface SignFile {
  name: string;
  repo_url?: string;
  agent_profile_id?: string;
}

function detectGitRemote(): string | null {
  try {
    const result = Bun.spawnSync(['git', 'remote', 'get-url', 'origin']);
    if (result.exitCode === 0) {
      return result.stdout.toString().trim();
    }
  } catch {}
  return null;
}

async function initCommand(nameOverride?: string): Promise<void> {
  const cwd = process.cwd();
  const signPath = path.join(cwd, SIGN_FILE);

  if (existsSync(signPath)) {
    console.error(`Error: ${SIGN_FILE} already exists in ${cwd}`);
    process.exit(1);
  }

  const dirName = path.basename(cwd);
  const name = nameOverride || dirName;
  const repoUrl = detectGitRemote() || undefined;

  const sign: SignFile = {
    name,
    ...(repoUrl ? { repo_url: repoUrl } : {}),
  };

  await writeFile(signPath, JSON.stringify(sign, null, 2) + '\n');
  console.log(`Created ${SIGN_FILE} for project "${name}" in ${cwd}`);
}

async function scanCommand(roots: string[]): Promise<void> {
  const dbPath = process.env['MANDOR_DB_PATH'] ?? 'mandor.db';
  const db = new Db(dbPath);

  if (roots.length === 0) {
    roots = [process.cwd()];
  }

  const result = scanWorkspaces(db, roots);
  db.close();

  console.log(`Scanned: ${roots.join(', ')}`);
  console.log(`${result.created} created, ${result.updated} updated, ${result.deleted} removed`);
  console.log(`Total projects: ${result.projects.length}`);
  for (const p of result.projects) {
    console.log(`  ${p.name} (${p.local_path}) [${p.source}]`);
  }
}

export async function runCLI(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'init': {
      const nameOverride = args[1] || undefined;
      await initCommand(nameOverride);
      break;
    }
    case 'scan': {
      const roots = args.slice(1);
      await scanCommand(roots);
      break;
    }
    default:
      console.error('Usage: mandor <command> [options]');
      console.error('');
      console.error('Commands:');
      console.error('  init [name]          Create a .mandor.json sign file');
      console.error('  scan [dir...]        Scan directories for .mandor.json files and upsert projects');
      console.error('');
      console.error('Examples:');
      console.error('  mandor init');
      console.error('  mandor init my-app');
      console.error('  mandor scan');
      console.error('  mandor scan ~/code ~/work');
      console.error('  mandor scan ./my-project');
      process.exit(1);
  }
}
