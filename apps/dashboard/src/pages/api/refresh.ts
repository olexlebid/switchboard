// POST /api/refresh: forces a fresh read of both agents ("Оновити" button).
import type { APIRoute } from 'astro';
import { getOverview } from '@core/overview';
import { checkRequest, forbidden } from '../../guard';

export const POST: APIRoute = async ({ request, redirect }) => {
  const denied = checkRequest(request);
  if (denied) return forbidden(denied);
  const overview = await getOverview('force');
  // Without JS the form posts here and expects a page; with JS the client asks for JSON.
  if (request.headers.get('accept')?.includes('application/json')) {
    return Response.json(overview, { headers: { 'cache-control': 'no-store' } });
  }
  return redirect('/', 303);
};
