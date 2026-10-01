// Shared helpers for the JSON API routes: guard, uploads and uniform responses.
import type { IncomingFile } from '@core/attachments';
import type { LaunchResult } from '@core/launch';
import { checkRequest, forbidden } from './guard';

/** Runs the host/origin guard; returns a 403 response when the request must be refused. */
export function guard(request: Request): Response | undefined {
  const denied = checkRequest(request);
  return denied ? forbidden(denied) : undefined;
}

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export const badRequest = (error = 'Некоректний запит.'): Response => json({ ok: false, error }, 400);

/** A launch result as an HTTP response: the user-facing message or error text is always in the body. */
export const respond = (r: LaunchResult & Record<string, unknown>): Response => json(r, r.ok ? 200 : r.status);

/** String field of a form, trimmed of nothing (text is validated by the core). */
export const field = (form: FormData, name: string): string => String(form.get(name) ?? '');

/** Files of a multipart form field. Size/type rules are enforced by the core when it stores them. */
export async function uploadsOf(form: FormData, name = 'files'): Promise<IncomingFile[]> {
  const out: IncomingFile[] = [];
  for (const v of form.getAll(name)) {
    if (typeof v === 'string' || v.size === 0) continue;
    out.push({ name: v.name, data: Buffer.from(await v.arrayBuffer()) });
  }
  return out;
}
