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

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_TURNS = 50;

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: string } } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message: string };
}

interface HistoryRow {
  role: 'user' | 'agent';
  chunk: string;
}

export class GeminiAdapter implements AgentAdapter {
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
    const apiKey = profile?.credentials_encrypted ?? process.env['GEMINI_API_KEY'] ?? '';
    const resolvedModel = model ?? getDefaultModel('gemini')!;
    const readonly = opts?.permissionMode === 'plan';

    // Surface a session marker so the orchestrator can persist + resume. Gemini
    // has no native sessions, so the marker is the conversation id (= task id);
    // resume rebuilds context from stored history via that id.
    this.messageQueue.push({ type: 'text', content: JSON.stringify({ session_id: task.id }), timestamp: new Date() });

    const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: prompt ?? task.description }] }];

    this.streamActive = true;
    this.runAgentLoop(contents, worktreePath, apiKey, resolvedModel, readonly).catch(() => {});
  }

  async resume(sessionId: string, _message: string, opts?: AgentResumeOptions): Promise<void> {
    this.abortController = new AbortController();
    this.messageQueue = [];
    this.tokenUsage = { input: 0, output: 0, total: 0 };

    const apiKey = opts?.apiKey ?? process.env['GEMINI_API_KEY'] ?? '';
    const resolvedModel = opts?.model ?? getDefaultModel('gemini')!;
    const readonly = opts?.permissionMode === 'plan';
    const cwd = opts?.cwd ?? process.cwd();

    // Rebuild the conversation from stored history (keyed by the session marker).
    const history = this.db.getSessionHistory(sessionId) as HistoryRow[];
    const contents = this.buildContentsFromHistory(history);

    this.streamActive = true;
    this.runAgentLoop(contents, cwd, apiKey, resolvedModel, readonly).catch(() => {});
  }

  /** Rebuild Gemini contents from persisted rows, skipping log noise. */
  private buildContentsFromHistory(rows: HistoryRow[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    for (const row of rows) {
      if (this.isLogNoise(row.chunk)) continue;
      if (row.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: row.chunk }] });
      } else {
        // Gemini requires strict user/model alternation — merge consecutive
        // assistant turns into the last model message.
        const last = contents[contents.length - 1];
        if (last && last.role === 'model') {
          last.parts.push({ text: row.chunk });
        } else {
          contents.push({ role: 'model', parts: [{ text: row.chunk }] });
        }
      }
    }
    return contents;
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
    contents: GeminiContent[],
    cwd: string,
    apiKey: string,
    model: string,
    readonly: boolean,
  ): Promise<void> {
    const systemPrompt = readonly ? READONLY_AGENT_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT;
    const tools = readonly ? READONLY_TOOL_DEFINITIONS : TOOL_DEFINITIONS;

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (this.abortController.signal.aborted) break;

        const response = await this.callApi(contents, apiKey, model, systemPrompt, tools);

        if (response.error) {
          this.messageQueue.push({ type: 'error', content: response.error.message, timestamp: new Date() });
          break;
        }

        const usage = response.usageMetadata;
        if (usage) {
          this.tokenUsage.input += usage.promptTokenCount ?? 0;
          this.tokenUsage.output += usage.candidatesTokenCount ?? 0;
          this.tokenUsage.total = this.tokenUsage.input + this.tokenUsage.output;
        }

        const candidate = response.candidates?.[0];
        if (!candidate) break;

        const assistantContent = candidate.content;
        contents.push(assistantContent);

        const textParts = assistantContent.parts.filter((p): p is { text: string } => 'text' in p);
        const text = textParts.map(p => p.text).join('\n').trim();
        if (text) {
          this.messageQueue.push({ type: 'text', content: text, timestamp: new Date() });
        }

        const fnCalls = assistantContent.parts.filter(
          (p): p is { functionCall: { name: string; args: Record<string, unknown> } } => 'functionCall' in p,
        );

        if (fnCalls.length === 0) break;

        const toolResultParts: GeminiPart[] = [];
        for (const fc of fnCalls) {
          const toolCall: ToolCall = {
            id: `${fc.functionCall.name}-${turn}`,
            name: fc.functionCall.name,
            args: fc.functionCall.args,
          };

          this.messageQueue.push({
            type: 'tool_use',
            content: `${fc.functionCall.name}(${JSON.stringify(fc.functionCall.args)})`,
            timestamp: new Date(),
          });

          const result = await executeTool(toolCall, cwd);
          toolResultParts.push({
            functionResponse: {
              name: fc.functionCall.name,
              response: { content: result.result },
            },
          });
        }

        contents.push({ role: 'user', parts: toolResultParts });
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
    contents: GeminiContent[],
    apiKey: string,
    model: string,
    systemPrompt: string,
    tools: typeof TOOL_DEFINITIONS,
  ): Promise<GeminiResponse> {
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: [{
        functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      return { error: { message: `Gemini API error ${response.status}: ${text}` } };
    }

    return response.json() as Promise<GeminiResponse>;
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
