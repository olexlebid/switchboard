// POST /api/merge: `op=preview` shows what would be merged; `op=merge` fast-forwards the base branch (owner-confirmed).
// `kind` is `task` or `chat`, `id` the task/chat id. Never pushes, never deploys.
import type { APIRoute } from 'astro';
import { loadConfig } from '@core/config';
import { mergeFor, previewMergeFor } from '@core/launch';
import { badRequest, field, guard, respond } from '../../api';

export const POST: APIRoute = async ({ request }) => {
  const denied = guard(request);
  if (denied) return denied;
  const form = await request.formData();
  const kind = field(form, 'kind');
  const id = field(form, 'id');
  if (kind !== 'task' && kind !== 'chat') return badRequest();
  if (!(kind === 'task' ? /^t-[\w-]{1,40}$/ : /^c-[\w-]{1,40}$/).test(id)) return badRequest();
  const cfg = loadConfig();
  switch (field(form, 'op')) {
    case 'preview':
      return respond(await previewMergeFor(cfg, kind, id));
    case 'merge':
      return respond(await mergeFor(cfg, kind, id));
    default:
      return badRequest();
  }
};
