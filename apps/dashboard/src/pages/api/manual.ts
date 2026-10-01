// POST /api/manual: sets a hand-made mark on a manual card (services without any API).
import type { APIRoute } from 'astro';
import { loadConfig } from '@core/config';
import { setManual } from '@core/store';
import { badRequest, field, guard, json } from '../../api';

export const POST: APIRoute = async ({ request }) => {
  const denied = guard(request);
  if (denied) return denied;
  const form = await request.formData();
  const id = field(form, 'id');
  const state = field(form, 'state');
  // Only cards declared in the config may be written, and only two states are valid.
  const known = loadConfig().dashboard.manualCards.some((c) => c.id === id);
  if (!known || (state !== 'available' && state !== 'exhausted')) return badRequest('Невідома картка або стан.');
  setManual(id, state);
  return json({ ok: true });
};
