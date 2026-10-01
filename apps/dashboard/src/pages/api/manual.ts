// POST /api/manual: sets a hand-made mark on a manual card (services without any API).
import type { APIRoute } from 'astro';
import { loadConfig } from '@core/config';
import { setManual } from '@core/store';
import { checkRequest, forbidden } from '../../guard';

export const POST: APIRoute = async ({ request, redirect }) => {
  const denied = checkRequest(request);
  if (denied) return forbidden(denied);

  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const state = String(form.get('state') ?? '');
  // Only cards declared in the config may be written, and only two states are valid.
  const known = loadConfig().dashboard.manualCards.some((c) => c.id === id);
  if (!known || (state !== 'available' && state !== 'exhausted')) {
    return new Response('Невідома картка або стан', { status: 400 });
  }
  setManual(id, state);
  if (request.headers.get('accept')?.includes('application/json')) return Response.json({ ok: true });
  return redirect('/', 303);
};
