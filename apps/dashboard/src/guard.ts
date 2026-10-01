// Request guard for a localhost-only tool. Blocks DNS-rebinding (foreign Host header) and
// cross-site requests (foreign Origin) so a random web page cannot drive the local API.

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOf(hostHeader: string): string {
  return hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0]!;
}

/** Returns an error message when the request must be rejected, otherwise undefined. */
export function checkRequest(request: Request): string | undefined {
  const host = request.headers.get('host') ?? '';
  if (!ALLOWED_HOSTNAMES.has(hostnameOf(host))) return 'Недозволений Host';

  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return 'Некоректний Origin';
    }
    if (originHost !== host) return 'Недозволений Origin';
  }
  return undefined;
}

/** Plain-text 403 for a rejected request. */
export function forbidden(message: string): Response {
  return new Response(message, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
