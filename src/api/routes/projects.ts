import type { Db } from '../../db/index';
import type { CreateProjectInput, CreateDeployTargetInput } from '../../agents/base';

export function handleProjects(req: Request, db: Db): Response | Promise<Response> {
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);

  // POST /projects or GET /projects
  if (pathParts.length === 1) {
    if (req.method === 'POST') return createProject(req, db);
    if (req.method === 'GET') {
      const projects = db.listProjects();
      return Response.json(projects, { status: 200 });
    }
    return new Response('Method not allowed', { status: 405 });
  }

  // /projects/:id/targets
  if (pathParts.length === 3 && pathParts[2] === 'targets') {
    const projectId = pathParts[1];
    return handleTargets(projectId, req, db);
  }

  // /projects/:id/targets/:tid
  if (pathParts.length === 4 && pathParts[2] === 'targets') {
    const projectId = pathParts[1];
    const targetId = pathParts[3];
    return handleTarget(projectId, targetId, req, db);
  }

  return new Response('Not found', { status: 404 });
}

function handleTargets(projectId: string, req: Request, db: Db): Response | Promise<Response> {
  if (req.method === 'POST') return createTarget(projectId, req, db);
  if (req.method === 'GET') {
    const targets = db.getDeployTargets(projectId);
    return Response.json(targets, { status: 200 });
  }
  return new Response('Method not allowed', { status: 405 });
}

function handleTarget(projectId: string, targetId: string, req: Request, db: Db): Response | Promise<Response> {
  if (req.method === 'PUT') return updateTarget(targetId, req, db);
  if (req.method === 'DELETE') return deleteTarget(targetId, db);
  return new Response('Method not allowed', { status: 405 });
}

async function createProject(req: Request, db: Db): Promise<Response> {
  try {
    const body = await req.json() as CreateProjectInput & { targets?: { name: string; path: string; deploy_command: string }[] };

    if (!body.name || !body.repo_url || !body.local_path) {
      return Response.json({ error: 'name, repo_url, and local_path are required' }, { status: 400 });
    }

    const project = db.createProject(body);
    const targets = body.targets ? db.getDeployTargets(project.id) : [];
    return Response.json({ ...project, targets }, { status: 201 });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}

async function createTarget(projectId: string, req: Request, db: Db): Promise<Response> {
  try {
    const body = await req.json() as CreateDeployTargetInput;
    if (!body.name || !body.path || !body.deploy_command) {
      return Response.json({ error: 'name, path, and deploy_command are required' }, { status: 400 });
    }
    const target = db.createDeployTarget({ ...body, project_id: projectId });
    return Response.json(target, { status: 201 });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}

async function updateTarget(targetId: string, req: Request, db: Db): Promise<Response> {
  try {
    const body = await req.json() as Partial<CreateDeployTargetInput>;
    const target = db.updateDeployTarget(targetId, body);
    if (!target) {
      return Response.json({ error: 'Deploy target not found' }, { status: 404 });
    }
    return Response.json(target, { status: 200 });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}

async function deleteTarget(targetId: string, db: Db): Promise<Response> {
  const deleted = db.deleteDeployTarget(targetId);
  if (!deleted) {
    return Response.json({ error: 'Deploy target not found' }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
