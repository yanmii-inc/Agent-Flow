import type { Db } from '../db/index';
import { Orchestrator } from '../orchestrator/index';
import { handleProjects } from './routes/projects';
import { handleAgents } from './routes/agents';
import { handleTasks } from './routes/tasks';
import { handleTokens } from './routes/tokens';
import { handleModels } from './routes/models';

export class ApiServer {
  private db: Db;
  private orchestrator: Orchestrator;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(db: Db) {
    this.db = db;
    this.orchestrator = new Orchestrator(db);
  }

  start(port: number = 3000, hostname: string = '0.0.0.0'): void {
    this.server = Bun.serve({
      port,
      hostname,
      fetch: (req) => this.handleRequest(req),
    });

    console.log(`mandor API server running on http://${hostname}:${port}`);
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  private corsHeaders(): HeadersInit {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }

  private addCors(res: Response): Response {
    // SSE responses carry their own CORS headers and must not be re-wrapped:
    // creating a new Response from a ReadableStream body can lock the stream,
    // causing ERR_INCOMPLETE_CHUNKED_ENCODING in Bun.
    if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
      return res;
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(this.corsHeaders())) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }

  private async handleRequest(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: this.corsHeaders() });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      let res: Response;
      if (path === '/projects' || path.startsWith('/projects/')) {
        res = await handleProjects(req, this.db);
      } else if (path === '/agent-profiles' || path.startsWith('/agent-profiles/')) {
        res = await handleAgents(req, this.db);
      } else if (path === '/tasks' || path.startsWith('/tasks/')) {
        res = await handleTasks(req, this.db, this.orchestrator);
      } else if (path === '/tokens') {
        res = await handleTokens(req, this.db);
      } else if (path === '/models') {
        res = handleModels(req);
      } else {
        res = Response.json({ error: 'Not found' }, { status: 404 });
      }
      return this.addCors(res);
    } catch (err: any) {
      return this.addCors(Response.json({ error: err.message }, { status: 500 }));
    }
  }
}
