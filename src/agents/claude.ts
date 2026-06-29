import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentAdapter, AgentMessage, TokenUsage, Task, AgentStartOptions, AgentResumeOptions } from './base';
import type { Db } from '../db/index';

type SDKTextContent = {
  type: 'text';
  text: string;
};

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
        try {
          for await (const msg of gen) {
            const mapped = mapSDKMessage(msg);
            if (mapped) yield mapped;

            // Extract session_id from any message type that has it
            const anyMsg = msg as Record<string, unknown>;
            if (anyMsg.session_id && typeof anyMsg.session_id === 'string') {
              yield { type: 'text' as const, content: JSON.stringify({ session_id: anyMsg.session_id }), timestamp: new Date() };
            }

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
            yield { type: 'error' as const, content: err.message ?? String(err), timestamp: new Date() };
          }
        }
        yield { type: 'done' as const, content: '', timestamp: new Date() };
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

function mapSDKMessage(msg: SDKMessage): AgentMessage | null {
  switch (msg.type) {
    case 'assistant': {
      const assistantMsg = msg as SDKAssistantMessage;
      const textBlocks = (assistantMsg.message.content as SDKTextContent[])?.filter((c): c is SDKTextContent => c.type === 'text') ?? [];
      const text = textBlocks.map(b => b.text).join('\n');
      if (!text) return null;
      return { type: 'text', content: text, timestamp: new Date() };
    }
    case 'result': {
      const result = msg as SDKResultMessage;
      if (result.subtype === 'success') {
        return { type: 'text', content: result.result ?? '', timestamp: new Date() };
      }
      const errors = (result as any).errors ?? [];
      return { type: 'error', content: errors.join('\n') || 'Unknown error', timestamp: new Date() };
    }
    case 'stream_event': {
      const seMsg = msg as any;
      const delta = seMsg.event?.delta?.text;
      if (delta) {
        return { type: 'text', content: delta, timestamp: new Date() };
      }
      return null;
    }
    case 'system':
    case 'user':
    case 'auth_status':
    case 'tool_progress':
      return null;
    default:
      return null;
  }
}
