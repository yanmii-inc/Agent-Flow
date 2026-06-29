import type { AgentAdapter, AgentMessage, TokenUsage, Task, AgentStartOptions, AgentResumeOptions } from './base';
import type { Db } from '../db/index';
import {
  executeTool,
  TOOL_DEFINITIONS,
  READONLY_TOOL_DEFINITIONS,
  AGENT_SYSTEM_PROMPT,
  READONLY_AGENT_SYSTEM_PROMPT,
} from './llm-coding-tools';
import type { ToolCall } from './llm-coding-tools';
import { getDefaultModel } from './models';

const GLM_BASE = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MAX_TURNS = 50;

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAiResponse {
  choices?: Array<{
    message: OpenAiMessage;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message: string };
}

interface HistoryRow {
  role: 'user' | 'agent';
  chunk: string;
}

export class GlmAdapter implements AgentAdapter {
  private db: Db;
  private tokenUsage: TokenUsage = { input: 0, output: 0, total: 0 };
  private messageQueue: AgentMessage[] = [];
  private streamActive = false;
  private abortController: AbortController = new AbortController();

  constructor(db: Db) {
    this.db = db;
  }

  async start(task: Task, worktreePath: string, prompt?: string, model?: string, opts?: AgentStartOptions): Promise<void> {
    this.abortController = new AbortController();
    this.messageQueue = [];
    this.tokenUsage = { input: 0, output: 0, total: 0 };

    const profile = task.agent_profile_id ? this.db.getAgentProfile(task.agent_profile_id) : undefined;
    const apiKey = profile?.credentials_encrypted ?? process.env['GLM_API_KEY'] ?? '';
    const resolvedModel = model ?? getDefaultModel('glm')!;
    const readonly = opts?.permissionMode === 'plan';

    // Surface a session marker so the orchestrator can persist + resume. GLM has
    // no native sessions, so the marker is the conversation id (= task id);
    // resume rebuilds context from stored history via that id.
    this.messageQueue.push({ type: 'text', content: JSON.stringify({ session_id: task.id }), timestamp: new Date() });

    const systemPrompt = readonly ? READONLY_AGENT_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT;
    const messages: OpenAiMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt ?? task.description },
    ];

    this.streamActive = true;
    this.runAgentLoop(messages, worktreePath, apiKey, resolvedModel, readonly).catch(() => {});
  }

  async resume(sessionId: string, _message: string, opts?: AgentResumeOptions): Promise<void> {
    this.abortController = new AbortController();
    this.messageQueue = [];
    this.tokenUsage = { input: 0, output: 0, total: 0 };

    const apiKey = opts?.apiKey ?? process.env['GLM_API_KEY'] ?? '';
    const resolvedModel = opts?.model ?? getDefaultModel('glm')!;
    const readonly = opts?.permissionMode === 'plan';
    const cwd = opts?.cwd ?? process.cwd();
    const systemPrompt = readonly ? READONLY_AGENT_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT;

    // Rebuild the conversation from stored history (keyed by the session marker).
    const history = this.db.getSessionHistory(sessionId) as HistoryRow[];
    const messages = this.buildMessagesFromHistory(history, systemPrompt);

    this.streamActive = true;
    this.runAgentLoop(messages, cwd, apiKey, resolvedModel, readonly).catch(() => {});
  }

  /** Rebuild OpenAI-style messages from persisted rows, skipping log noise. */
  private buildMessagesFromHistory(rows: HistoryRow[], systemPrompt: string): OpenAiMessage[] {
    const messages: OpenAiMessage[] = [{ role: 'system', content: systemPrompt }];
    for (const row of rows) {
      if (this.isLogNoise(row.chunk)) continue;
      messages.push({
        role: row.role === 'user' ? 'user' : 'assistant',
        content: row.chunk,
      });
    }
    return messages;
  }

  /** Filter out stored rows that aren't clean conversation text. */
  private isLogNoise(chunk: string): boolean {
    if (chunk.startsWith('[tool_use]') || chunk.startsWith('[error]')) return true;
    try {
      const parsed = JSON.parse(chunk);
      if (parsed && typeof parsed.session_id === 'string') return true;
    } catch {}
    return false;
  }

  private async runAgentLoop(
    messages: OpenAiMessage[],
    cwd: string,
    apiKey: string,
    model: string,
    readonly: boolean,
  ): Promise<void> {
    const tools = readonly ? READONLY_TOOL_DEFINITIONS : TOOL_DEFINITIONS;

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (this.abortController.signal.aborted) break;

        const response = await this.callApi(messages, apiKey, model, tools);

        if (response.error) {
          this.messageQueue.push({ type: 'error', content: response.error.message, timestamp: new Date() });
          break;
        }

        const usage = response.usage;
        if (usage) {
          this.tokenUsage.input += usage.prompt_tokens ?? 0;
          this.tokenUsage.output += usage.completion_tokens ?? 0;
          this.tokenUsage.total = this.tokenUsage.input + this.tokenUsage.output;
        }

        const choice = response.choices?.[0];
        if (!choice) break;

        const assistantMsg = choice.message;
        messages.push(assistantMsg);

        if (assistantMsg.content) {
          this.messageQueue.push({ type: 'text', content: assistantMsg.content, timestamp: new Date() });
        }

        const toolCalls = assistantMsg.tool_calls ?? [];
        if (toolCalls.length === 0) break;

        for (const tc of toolCalls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments); } catch {}

          const toolCall: ToolCall = { id: tc.id, name: tc.function.name, args };

          this.messageQueue.push({
            type: 'tool_use',
            content: `${tc.function.name}(${tc.function.arguments})`,
            timestamp: new Date(),
          });

          const result = await executeTool(toolCall, cwd);
          messages.push({
            role: 'tool',
            content: result.result,
            tool_call_id: tc.id,
            name: tc.function.name,
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.abortController.signal.aborted) {
        this.messageQueue.push({ type: 'error', content: msg, timestamp: new Date() });
      }
    }

    this.messageQueue.push({ type: 'done', content: '', timestamp: new Date() });
    this.streamActive = false;
  }

  private async callApi(
    messages: OpenAiMessage[],
    apiKey: string,
    model: string,
    tools: typeof TOOL_DEFINITIONS,
  ): Promise<OpenAiResponse> {
    const body = {
      model,
      messages,
      tools: tools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
    };

    const response = await fetch(GLM_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      return { error: { message: `GLM API error ${response.status}: ${text}` } };
    }

    return response.json() as Promise<OpenAiResponse>;
  }

  stream(): AsyncIterable<AgentMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]: async function* () {
        while (self.streamActive || self.messageQueue.length > 0) {
          if (self.messageQueue.length > 0) {
            yield self.messageQueue.shift()!;
          } else {
            await new Promise(resolve => setTimeout(resolve, 50));
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
    this.streamActive = false;
  }
}
