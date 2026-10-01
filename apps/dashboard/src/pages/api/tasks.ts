// POST /api/tasks: starts a task from the dashboard form (multipart: fields + files; spawns a separate `sb run`).
import type { APIRoute } from 'astro';
import { loadConfig } from '@core/config';
import { launchTask } from '@core/launch';
import { field, guard, respond, uploadsOf } from '../../api';

export const POST: APIRoute = async ({ request }) => {
  const denied = guard(request);
  if (denied) return denied;
  const form = await request.formData();
  return respond(
    await launchTask(
      loadConfig(),
      { text: field(form, 'text'), type: field(form, 'type'), project: field(form, 'project'), priority: field(form, 'priority'), figma: field(form, 'figma') },
      await uploadsOf(form),
    ),
  );
};
