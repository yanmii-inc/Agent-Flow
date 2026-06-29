import path from 'path';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import type { Db } from '../../db/index';
import type { CreateProjectInput, CreateDeployTargetInput } from '../../agents/base';
import { scanWorkspaces } from '../../scan';
import { ensureProject, resolveHome, SIGN_FILE } from '../../project-setup';

export async function handleProjects(req: Request, db: Db): Promise<Response> {
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);

  // POST /projects/scan
  if (pathParts.length === 2 && pathParts[1] === 'scan') {
    if (req.method === 'POST') {
      let roots: string[] | undefined;
      try {
        const body = await req.json();
        if (body.roots && Array.isArray(body.roots)) roots = body.roots;
      } catch {}
      const result = scanWorkspaces(db, roots);
      return Response.json(result, { status: 200 });
    }
    return new Response('Method not allowed', { status: 405 });
  }

  // DELETE /projects/:id
  if (pathParts.length === 2 && pathParts[1] !== 'scan') {
    if (req.method === 'DELETE') return deleteProjectRecord(pathParts[1], db);
    return new Response('Method not allowed', { status: 405 });
  }

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
  const startedAt = Date.now();
  let body: CreateProjectInput & { targets?: { name: string; path: string; deploy_command: string }[] };

  try {
    body = await req.json() as typeof body;
  } catch (err: any) {
    console.error('[projects] POST /projects: failed to parse JSON body:', err?.message);
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  console.log('[projects] POST /projects', {
    name: body?.name,
    repo_url: body?.repo_url,
    local_path: body?.local_path,
    agent_profile_id: body?.agent_profile_id,
    targets: Array.isArray(body?.targets) ? body.targets.length : 0,
  });

  if (!body?.name || !body?.repo_url || !body?.local_path) {
    console.warn('[projects] create: validation failed — name, repo_url, and local_path are all required');
    return Response.json({ error: 'name, repo_url, and local_path are required' }, { status: 400 });
  }

  try {
    // Ensure the repo is cloned and mandor is initialized on disk (idempotent).
    const setup = await ensureProject({
      name: body.name,
      repoUrl: body.repo_url,
      localPath: body.local_path,
    });
    console.log('[projects] project ready on disk', {
      localPath: setup.localPath,
      cloned: setup.cloned,
      initialized: setup.initialized,
    });

    // Persist. If a project row already exists for this local_path (e.g. from a
    // prior scan or create), update it instead of failing on the UNIQUE constraint.
    let project;
    const existing = db.getProjectByLocalPath(setup.localPath);
    if (existing) {
      console.log(`[projects] project row already exists for local_path (${existing.id}); updating`);
      db.updateProject(existing.id, {
        name: body.name,
        repo_url: body.repo_url,
        agent_profile_id: body.agent_profile_id ?? null,
      });
      project = db.getProject(existing.id)!;
    } else {
      project = db.createProject({ ...body, local_path: setup.localPath });
      console.log(`[projects] created project row ${project.id} at ${setup.localPath}`);
    }

    const targets = body.targets ? db.getDeployTargets(project.id) : [];
    console.log(`[projects] POST /projects -> 201 in ${Date.now() - startedAt}ms (id=${project.id})`);
    return Response.json({ ...project, targets }, { status: 201 });
  } catch (err: any) {
    console.error(`[projects] POST /projects failed in ${Date.now() - startedAt}ms:`, err?.message);
    if (err?.stack) console.error(err.stack);
    return Response.json({ error: err?.message ?? 'Failed to create project' }, { status: 400 });
  }
}

async function deleteProjectRecord(id: string, db: Db): Promise<Response> {
  const startedAt = Date.now();
  const project = db.getProject(id);
  if (!project) {
    console.warn(`[projects] DELETE /projects/${id}: not found`);
    return Response.json({ error: 'Project not found' }, { status: 404 });
  }

  console.log(`[projects] DELETE /projects/${id}: "${project.name}" (local_path=${project.local_path})`);

  // Remove the .mandor.json sign file from the cloned dir; keep the rest of the folder.
  try {
    const signPath = path.join(resolveHome(project.local_path), SIGN_FILE);
    if (existsSync(signPath)) {
      await unlink(signPath);
      console.log(`[projects] removed ${signPath}`);
    } else {
      console.log(`[projects] no ${SIGN_FILE} at ${signPath} (nothing to remove)`);
    }
  } catch (err: any) {
    // Filesystem cleanup is best-effort — still delete the DB record below.
    console.error(`[projects] could not remove ${SIGN_FILE} for ${id}: ${err?.message}`);
  }

  // Delete the DB record (cascades to tasks, task_logs, deploy_targets).
  db.deleteProject(id);
  console.log(`[projects] DELETE /projects/${id} -> 204 in ${Date.now() - startedAt}ms`);
  return new Response(null, { status: 204 });
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
