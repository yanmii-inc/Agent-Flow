import { execa } from 'execa';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  result: string;
  isError: boolean;
}

export async function executeTool(toolCall: ToolCall, cwd: string): Promise<ToolResult> {
  try {
    switch (toolCall.name) {
      case 'read_file': {
        const path = resolve(cwd, String(toolCall.args.path));
        if (!existsSync(path)) {
          return { id: toolCall.id, name: toolCall.name, result: `File not found: ${toolCall.args.path}`, isError: true };
        }
        const content = readFileSync(path, 'utf-8');
        return { id: toolCall.id, name: toolCall.name, result: content, isError: false };
      }
      case 'write_file': {
        const path = resolve(cwd, String(toolCall.args.path));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(toolCall.args.content), 'utf-8');
        return { id: toolCall.id, name: toolCall.name, result: 'File written successfully', isError: false };
      }
      case 'bash': {
        const proc = await execa('sh', ['-c', String(toolCall.args.command)], {
          cwd,
          timeout: 60_000,
          reject: false,
        });
        const output = [proc.stdout, proc.stderr].filter(Boolean).join('\n');
        return { id: toolCall.id, name: toolCall.name, result: output || '(no output)', isError: proc.exitCode !== 0 };
      }
      default:
        return { id: toolCall.id, name: toolCall.name, result: `Unknown tool: ${toolCall.name}`, isError: true };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id: toolCall.id, name: toolCall.name, result: msg, isError: true };
  }
}

export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file relative to the working directory',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to the file (relative or absolute)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file, creating parent directories as needed',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to the file (relative or absolute)' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command in the working directory. Use for git operations, tests, builds, etc.',
    parameters: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
  },
];

export const AGENT_SYSTEM_PROMPT = `You are an expert software engineer working autonomously on a coding task.
You have tools to read files, write files, and run shell commands.

When given a task:
1. Explore the codebase to understand the structure
2. Make the necessary changes
3. Run tests if available to verify correctness
4. Stage and commit all changes with a clear descriptive commit message
5. Push the branch to origin
6. Open a PR against main with a summary of what changed and why

Work autonomously. Use the bash tool for git operations. Do not ask for confirmation before making changes.`;

/** Read-only system prompt for threads (brainstorm / insights). */
export const READONLY_AGENT_SYSTEM_PROMPT = `You are a read-only coding assistant helping the user think through their codebase.
You can read files to understand the code, but you must NOT modify anything: do not write or edit files, do not run commands that change state, and do not commit, push, or open pull requests.
Use read_file to explore when useful. Your job is to answer questions, explain code, brainstorm approaches, and surface insights.`;

/**
 * Tools available in read-only ("plan") mode. Only read_file is exposed so the
 * agent can look but not touch — the equivalent of Claude's plan mode for the
 * CLI/API adapters that have no native permission concept.
 */
export const READONLY_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(t => t.name === 'read_file');

