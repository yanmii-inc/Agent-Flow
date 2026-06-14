import { execa } from 'execa';
import { emptyAsyncIterable } from './base';
import type { AgentAdapter, AgentMessage, TokenUsage, Task } from './base';

export class OpenCodeAdapter implements AgentAdapter {
  private process: ReturnType<typeof execa> | null = null;
  private abortController: AbortController = new AbortController();
  private tokenUsage: TokenUsage = { input: 0, output: 0, total: 0 };
  private messageQueue: AgentMessage[] = [];
  private streamActive = false;

  async start(task: Task, worktreePath: string, prompt?: string): Promise<void> {
    this.abortController = new AbortController();
    this.messageQueue = [];

    const binary = 'opencode';
    const args = ['--no-author-mode', '--non-interactive', prompt ?? task.description];

    this.process = execa(binary, args, {
      cwd: worktreePath,
      signal: this.abortController.signal,
      all: true,
      buffer: false,
    });

    this.streamActive = true;
    this.captureOutput();
  }

  async resume(sessionId: string, message: string): Promise<void> {
    // OpenCode doesn't natively support session resume like Claude SDK.
    // We re-spawn with the context reconstructed from task_logs.
    throw new Error('Session resume not supported for OpenCode');
  }

  private async captureOutput(): Promise<void> {
    if (!this.process) return;

    try {
      for await (const chunk of this.process.all ?? emptyAsyncIterable()) {
        this.messageQueue.push({
          type: 'text',
          content: typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Buffer),
          timestamp: new Date(),
        });
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        this.messageQueue.push({
          type: 'error',
          content: err.message ?? String(err),
          timestamp: new Date(),
        });
      }
    }

    this.messageQueue.push({ type: 'done', content: '', timestamp: new Date() });
    this.streamActive = false;
  }

  stream(): AsyncIterable<AgentMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]: async function* () {
        while (self.streamActive || self.messageQueue.length > 0) {
          if (self.messageQueue.length > 0) {
            yield self.messageQueue.shift()!;
          } else {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      },
    };
  }

  getTokenUsage(): TokenUsage {
    return this.tokenUsage;
  }

  async kill(): Promise<void> {
    this.abortController.abort();
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
  }
}
