// POST /api/tree: `op=stash` moves the user's uncommitted changes of an allowed project into `git stash`.
import type { APIRoute } from 'astro';
import { loadConfig } from '@core/config';
import { stashProjectChanges } from '@core/launch';
import { badRequest, field, guard, respond } from '../../api';

export const POST: APIRoute = async ({ request }) => {
  const denied = guard(request);
  if (denied) return denied;
  const form = await request.formData();
  if (field(form, 'op') !== 'stash') return badRequest();
  return respond(await stashProjectChanges(loadConfig(), field(form, 'project')));
};
