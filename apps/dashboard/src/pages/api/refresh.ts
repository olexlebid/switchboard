// POST /api/refresh: forces a fresh read of both agents ("Оновити" button).
import type { APIRoute } from 'astro';
import { getOverview } from '@core/overview';
import { guard, json } from '../../api';

export const POST: APIRoute = async ({ request }) => {
  const denied = guard(request);
  if (denied) return denied;
  await getOverview('force');
  return json({ ok: true, message: 'Ліміти оновлено.' });
};
