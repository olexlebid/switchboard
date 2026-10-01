// POST /api/tasks: starts a task from the dashboard form (spawns a separate `sb run`).
import type { APIRoute } from 'astro';
import { loadConfig } from '@core/config';
import { launchTask } from '@core/launch';
import { checkRequest, forbidden } from '../../guard';

export const POST: APIRoute = async ({ request, redirect }) => {
  const denied = checkRequest(request);
  if (denied) return forbidden(denied);

  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  const result = await launchTask(loadConfig(), {
    text: field('text'),
    type: field('type'),
    project: field('project'),
    priority: field('priority'),
    figma: field('figma'),
  });

  if (request.headers.get('accept')?.includes('application/json')) {
    return Response.json(result, { status: result.ok ? 200 : result.status, headers: { 'cache-control': 'no-store' } });
  }
  return redirect('/', 303);
};
