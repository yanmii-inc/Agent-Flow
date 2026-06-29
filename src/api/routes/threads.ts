import type { Db } from '../../db/index';
import type { CreateThreadInput } from '../../agents/base';
import { RESUMABLE_AGENT_TYPES } from '../../agents/base';
import { PROVIDER_MODELS, isValidModel } from '../../agents/models';
import { Orchestrator } from '../../orchestrator/index';

export function handleThreads(req: Request, db: Db, orchestrator: Orchestrator): Response | Promise<Response> {
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);

  // POST /threads or GET /threads
  if (pathParts.length === 1) {
    if (req.method === 'POST') return createThread(req, db, orchestrator);
    if (req.method === 'GET') return listThreads(req, db);
    return new Response('Method not allowed', { status: 405 });
  }

  // /threads/:id
  if (pathParts.length === 2) {
    const threadId = pathParts[1];
    if (req.method === 'GET') return getThread(threadId, db);
    if (req.method === 'DELETE') return deleteThread(threadId, db, orchestrator);
    return new Response('Method not allowed', { status: 405 });
  }

  // /threads/:id/reply, /threads/:id/logs
  if (pathParts.length === 3) {
    const threadId = pathParts[1];
    const action = pathParts[2];

    if (action === 'reply') {
      if (req.method === 'POST') return replyToThread(threadId, req, db, orchestrator);
      return new Response('Method not allowed', { status: 405 });
    }

    if (action === 'logs') {
      if (req.method === 'GET') return streamThreadLogs(threadId, req, db, orchestrator);
      return new Response('Method not allowed', { status: 405 });
    }
  }

  return new Response('Not found', { status: 404 });
}

async function createThread(req: Request, db: Db, orchestrator: Orchestrator): Promise<Response> {
  try {
    const body = await req.json() as CreateThreadInput;

    if (!body.project_id || !body.message) {
      return Response.json({ error: 'project_id and message are required' }, { status: 400 });
    }

    const project = db.getProject(body.project_id);
    if (!project) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }

    // Resolve the effective agent profile (explicit > project default > claude).
    const profileId = body.agent_profile_id ?? project.agent_profile_id ?? undefined;
    const profile = profileId ? db.getAgentProfile(profileId) : undefined;
    if (body.agent_profile_id && !profile) {
      return Response.json({ error: 'Agent profile not found' }, { status: 400 });
    }
    const agentType = profile?.agent_type ?? 'claude';

    // Threads require an agent that supports resume (claude natively;
    // gemini/glm rebuild from stored history).
    if (!RESUMABLE_AGENT_TYPES.includes(agentType)) {
      return Response.json(
        { error: `Threads require an agent that supports resume (claude, gemini, glm). Got: ${agentType}` },
        { status: 400 },
      );
    }

    // Model is validated against the resolved provider.
    if (body.model !== undefined && body.model !== null && body.model !== '') {
      if (!isValidModel(agentType, body.model)) {
        const allowed = PROVIDER_MODELS[agentType]?.map(m => m.id).join(', ') ?? '(none)';
        return Response.json(
          { error: `model "${body.model}" is not valid for agent_type "${agentType}". Allowed: ${allowed}` },
          { status: 400 },
        );
      }
    }

    const thread = db.createThread(body);

    // Persist the first user turn before dispatch so SSE replay sees it.
    db.appendThreadMessage(thread.id, 'user', body.message);

    // Dispatch asynchronously (no PR pipeline — read-only plan-mode conversation).
    orchestrator.dispatchThread(thread.id).catch(err => {
      console.error(`Thread ${thread.id} failed to start:`, err);
      try { db.appendThreadMessage(thread.id, 'agent', `[error] ${err.message ?? err}`); } catch {}
    });

    return Response.json(thread, { status: 201 });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}

function listThreads(req: Request, db: Db): Response {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id') ?? undefined;
  const threads = db.listThreads(projectId);
  return Response.json(threads, { status: 200 });
}

function getThread(threadId: string, db: Db): Response {
  const thread = db.getThread(threadId);
  if (!thread) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }
  return Response.json(thread, { status: 200 });
}

async function deleteThread(threadId: string, db: Db, orchestrator: Orchestrator): Promise<Response> {
  await orchestrator.killThread(threadId);
  db.deleteThread(threadId);
  return new Response(null, { status: 204 });
}

async function replyToThread(threadId: string, req: Request, db: Db, orchestrator: Orchestrator): Promise<Response> {
  try {
    const body = await req.json() as { message: string };
    if (!body.message) {
      return Response.json({ error: 'message is required' }, { status: 400 });
    }

    const thread = db.getThread(threadId);
    if (!thread) {
      return Response.json({ error: 'Thread not found' }, { status: 404 });
    }

    await orchestrator.replyThread(threadId, body.message);
    return Response.json({ status: 'ok' }, { status: 200 });
  } catch (err: any) {
    if (err.message?.includes('already in progress')) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    return Response.json({ error: err.message }, { status: 400 });
  }
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function streamThreadLogs(threadId: string, req: Request, db: Db, orchestrator: Orchestrator): Response {
  const thread = db.getThread(threadId);
  if (!thread) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const sendSSE = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      // Replay existing messages.
      const existingMessages = db.getThreadMessages(threadId);
      for (const msg of existingMessages) {
        sendSSE('log', JSON.stringify(msg));
      }

      // A thread is long-lived (many turns), so unlike /tasks we keep the stream
      // open across turns: `done` signals a turn finished but does NOT close the
      // connection — the client stays subscribed for subsequent replies. The
      // connection ends only when the client disconnects.
      const unsubscribe = orchestrator.subscribeToSSE(threadId, (msg) => {
        sendSSE('message', JSON.stringify(msg));

        if (msg.type === 'error') {
          sendSSE('error', JSON.stringify({ message: msg.content }));
        }
      });

      req.signal.addEventListener('abort', () => {
        unsubscribe();
        try { controller.close(); } catch {}
      });
    },
  });

  // CORS headers are included here so addCors() doesn't need to re-wrap the
  // ReadableStream body, which can corrupt chunked encoding in Bun.
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
