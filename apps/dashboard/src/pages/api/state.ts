// GET /api/state?project=<path>: everything the dashboard shows (limits, tasks, chat) as JSON.
import type { APIRoute } from 'astro';
import { getDashboardState } from '@core/dashboard-state';
import { guard, json } from '../../api';

export const GET: APIRoute = async ({ request, url }) => {
  const denied = guard(request);
  if (denied) return denied;
  return json(await getDashboardState(url.searchParams.get('project') ?? undefined));
};
