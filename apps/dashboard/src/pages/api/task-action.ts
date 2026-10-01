// POST /api/task-action: "resume" (with an optional answer and files) or "stop" for one task.
import type { APIRoute } from 'astro';
import { loadConfig } from '@core/config';
import { resumeFromDashboard, stopTask } from '@core/launch';
import { badRequest, field, guard, respond, uploadsOf } from '../../api';

export const POST: APIRoute = async ({ request }) => {
  const denied = guard(request);
  if (denied) return denied;
  const form = await request.formData();
  const id = field(form, 'id');
  const op = field(form, 'op');
  // Task ids look like t-20261001-0742-k3f; anything else is rejected before touching the state.
  if (!/^t-[\w-]{1,40}$/.test(id) || (op !== 'resume' && op !== 'stop')) return badRequest();
  if (op === 'stop') return respond(stopTask(id));
  return respond(await resumeFromDashboard(loadConfig(), id, { note: field(form, 'note'), files: await uploadsOf(form) }));
};
