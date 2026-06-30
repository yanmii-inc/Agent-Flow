import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentAdapter, AgentMessage, TokenUsage, Task, AgentStartOptions, AgentResumeOptions } from './base';
import type { Db } from '../db/index';

export class ClaudeAdapter implements AgentAdapter {
  private db: Db;
  private abortController: AbortController = new AbortController();
  private tokenUsage: TokenUsage = { input: 0, output: 0, total: 0 };
  private activeStream: AsyncIterable<AgentMessage> | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  private model: string | undefined;
  private apiKey: string | undefined;

  async start(task: Task, worktreePath: string, prompt?: string, model?: string, opts?: AgentStartOptions): Promise<void> {
    this.abortController = new AbortController();

    const profile = task.agent_profile_id ? this.db.getAgentProfile(task.agent_profile_id) : undefined;
    this.apiKey = profile?.credentials_encrypted ?? undefined;
    this.model = model;

    const options: Record<string, any> = {
      cwd: worktreePath,
      permissionMode: opts?.permissionMode ?? 'acceptEdits',
    };

    if (this.apiKey) {
      options.apiKey = this.apiKey;
    }
    if (this.model) {
      options.model = this.model;
    }

    const gen = query({
      prompt: prompt ?? task.description,
      options,
    });

    this.activeStream = this.makeStream(gen);
  }

  async resume(sessionId: string, message: string, opts?: AgentResumeOptions): Promise<void> {
    this.abortController = new AbortController();

    // Resolve creds/model so resume works on a freshly-resolved adapter (e.g. a
    // thread resuming after a server restart, with no prior start() this session).
    this.apiKey = opts?.apiKey ?? this.apiKey;
    this.model = opts?.model ?? this.model;

    const options: Record<string, any> = {
      resume: sessionId,
      permissionMode: opts?.permissionMode ?? 'acceptEdits',
    };
    if (this.apiKey) {
      options.apiKey = this.apiKey;
    }
    if (this.model) {
      options.model = this.model;
    }
    if (opts?.cwd) {
      options.cwd = opts.cwd;
    }

    const gen = query({
      prompt: message,
      options,
    });

    this.activeStream = this.makeStream(gen);
  }

  private makeStream(gen: AsyncGenerator<SDKMessage, void>): AsyncIterable<AgentMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]: async function* () {
        let sessionIdEmitted = false;
        try {
          for await (const msg of gen) {
            // Surface session_id once (so the orchestrator can capture it) rather
            // than repeating the marker after every message.
            const anyMsg = msg as Record<string, unknown>;
            if (!sessionIdEmitted && anyMsg.session_id && typeof anyMsg.session_id === 'string') {
              sessionIdEmitted = true;
              yield { type: 'text', content: JSON.stringify({ session_id: anyMsg.session_id }), timestamp: new Date() };
            }

            for (const mapped of mapSDKMessage(msg)) yield mapped;

            // Track token usage from result messages
            if (msg.type === 'result') {
              const result = msg as SDKResultMessage;
              const usage = result.usage;
              if (usage) {
                self.tokenUsage = {
                  input: usage.input_tokens ?? 0,
                  output: usage.output_tokens ?? 0,
                  total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                };
              }
            }
          }
        } catch (err: any) {
          if (err.name !== 'AbortError') {
            yield { type: 'error', content: err.message ?? String(err), timestamp: new Date() };
          }
        }
        yield { type: 'done', content: '', timestamp: new Date() };
      },
    };
  }

  stream(): AsyncIterable<AgentMessage> {
    if (!this.activeStream) {
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'error', content: 'No active stream', timestamp: new Date() };
        },
      };
    }
    return this.activeStream;
  }

  getTokenUsage(): TokenUsage {
    return this.tokenUsage;
  }

  async kill(): Promise<void> {
    this.abortController.abort();
  }
}

function mapSDKMessage(msg: SDKMessage): AgentMessage[] {
  switch (msg.type) {
    case 'assistant': {
      const assistantMsg = msg as SDKAssistantMessage;
      const blocks = (assistantMsg.message.content ?? []) as any[];
      const out: AgentMessage[] = [];
      const text = blocks
        .filter(b => b.type === 'text')
        .map(b => b.text as string)
        .join('\n');
      if (text) out.push({ type: 'text', content: text, timestamp: new Date() });
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          out.push({
            type: 'tool_use',
            content: `${b.name}(${JSON.stringify(b.input ?? {})})`,
            tool: b.name as string,
            args: (b.input ?? {}) as Record<string, unknown>,
            timestamp: new Date(),
          });
        }
      }
      return out;
    }
    case 'user': {
      // The SDK emits user messages that wrap the tool results it already ran.
      const userMsg = msg as SDKUserMessage;
      const content = (userMsg.message as any).content;
      const blocks = Array.isArray(content) ? content : [];
      const out: AgentMessage[] = [];
      for (const b of blocks) {
        if (b && typeof b === 'object' && b.type === 'tool_result') {
          const raw = b.content;
          const output = typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? raw.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
              : JSON.stringify(raw ?? '');
          out.push({
            type: 'tool_result',
            content: output,
            output,
            isError: b.is_error === true,
            timestamp: new Date(),
          });
        }
      }
      return out;
    }
    case 'result': {
      const result = msg as SDKResultMessage;
      if (result.subtype === 'success') {
        return [{ type: 'text', content: result.result ?? '', timestamp: new Date() }];
      }
      const errors = (result as any).errors ?? [];
      return [{ type: 'error', content: errors.join('\n') || 'Unknown error', timestamp: new Date() }];
    }
    case 'stream_event': {
      const delta = (msg as any).event?.delta?.text;
      if (delta) return [{ type: 'text', content: delta, timestamp: new Date() }];
      return [];
    }
    default:
      return [];
  }
}
