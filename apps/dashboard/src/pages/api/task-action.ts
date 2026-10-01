// POST /api/task-action: "resume" or "stop" for one task (buttons in the task panel).
import type { APIRoute } from 'astro';
import { loadConfig } from '@core/config';
import { resumeFromDashboard, stopTask } from '@core/launch';
import { checkRequest, forbidden } from '../../guard';

export const POST: APIRoute = async ({ request, redirect }) => {
  const denied = checkRequest(request);
  if (denied) return forbidden(denied);

  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const action = String(form.get('op') ?? '');
  // Task ids look like t-20261001-0742-k3f; anything else is rejected before touching the state.
  if (!/^t-[\w-]{1,40}$/.test(id) || (action !== 'resume' && action !== 'stop')) {
    return new Response(JSON.stringify({ ok: false, error: 'Некоректний запит.' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const result = action === 'stop' ? stopTask(id) : await resumeFromDashboard(loadConfig(), id);

  if (request.headers.get('accept')?.includes('application/json')) {
    return Response.json(result, { status: result.ok ? 200 : result.status, headers: { 'cache-control': 'no-store' } });
  }
  return redirect('/', 303);
};
