// GET /api/status: JSON limits overview (re-reads limits when older than dashboard.refreshTtlSec).
import type { APIRoute } from 'astro';
import { getOverview } from '@core/overview';
import { guard, json } from '../../api';

export const GET: APIRoute = async ({ request }) => {
  const denied = guard(request);
  if (denied) return denied;
  return json(await getOverview('if-stale'));
};
