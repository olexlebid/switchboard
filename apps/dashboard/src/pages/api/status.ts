// GET /api/status: JSON overview (re-reads limits when older than dashboard.refreshTtlSec).
import type { APIRoute } from 'astro';
import { getOverview } from '@core/overview';
import { checkRequest, forbidden } from '../../guard';

export const GET: APIRoute = async ({ request }) => {
  const denied = checkRequest(request);
  if (denied) return forbidden(denied);
  return Response.json(await getOverview('if-stale'), { headers: { 'cache-control': 'no-store' } });
};
