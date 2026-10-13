// The public API (`sb api`): a tiny JSON service for Make and other automation. It is deliberately separate from
// the dashboard server: only /v1/* with a bearer token exists here, so a tunnel pointed at this port never exposes
// the dashboard, "merge into main", stash or tasks. Listens on 127.0.0.1 only (the tunnel runs on the same machine).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, MAX_PROMPT, cancelJob, createPrompt, getJob, type PromptRequest } from './api-jobs';
import { readApiToken, tokenMatches } from './api-token';
import { getModels } from './models';
import { getOverview } from './overview';
import { readState } from './store';
import { allowedProjects } from './task-overview';
import type { SwitchboardConfig } from './types';

const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function send(res: ServerResponse, r: Reply): void {
  res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(r.headers ?? {}) });
  res.end(JSON.stringify(r.body));
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, 'body_too_large', `Тіло запиту більше ${MAX_BODY / 1024} КБ.`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new ApiError(415, 'json_required', 'Очікується Content-Type: application/json.');
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'bad_json', 'Тіло запиту — некоректний JSON-об’єкт.');
  }
}

/** What Make needs to route work: agent availability and the models each agent accepts. */
async function describeAgents(cfg: SwitchboardConfig) {
  const overview = await getOverview('if-stale', cfg);
  const models = getModels(cfg);
  return overview.agents.map((a) => ({
    agent: a.agent,
    title: a.title,
    status: a.status,
    statusLabel: a.statusLabel,
    fiveHourPct: a.fiveHourPct,
    weeklyPct: a.weeklyPct,
    models: models[a.agent],
  }));
}

export function createApiHandler(cfg: SwitchboardConfig, token: string) {
  const hits: number[] = [];

  /** Sliding window over the last minute. */
  const throttled = (): number | undefined => {
    const now = Date.now();
    while (hits.length && now - hits[0]! > 60_000) hits.shift();
    if (hits.length >= cfg.api.rateLimitPerMin) return Math.ceil((60_000 - (now - hits[0]!)) / 1000);
    hits.push(now);
    return undefined;
  };

  async function route(req: IncomingMessage): Promise<Reply> {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (path === '/v1/health' && method === 'GET') return { status: 200, body: { ok: true } };

    const auth = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!tokenMatches(auth, token)) {
      return { status: 401, body: errorBody('unauthorized', 'Потрібен заголовок Authorization: Bearer <token>.'), headers: { 'www-authenticate': 'Bearer' } };
    }
    const wait = throttled();
    if (wait !== undefined) return { status: 429, body: errorBody('rate_limited', 'Забагато запитів за хвилину.'), headers: { 'retry-after': String(wait) } };

    if (path === '/v1/models' && method === 'GET') {
      return { status: 200, body: { agents: await describeAgents(cfg), projects: allowedProjects(cfg).map((p) => p.name), limits: { maxPromptChars: MAX_PROMPT } } };
    }
    if (path === '/v1/status' && method === 'GET') {
      const chats = Object.values(readState().chats).filter((c) => c.source === 'api');
      const running = chats.filter((c) => c.status === 'running').length;
      return { status: 200, body: { agents: await describeAgents(cfg), jobs: { running, maxConcurrent: cfg.api.maxConcurrent } } };
    }
    if (path === '/v1/prompts' && method === 'POST') {
      const body = (await readJson(req)) as PromptRequest;
      const job = await createPrompt(cfg, body);
      const terminal = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
      return { status: terminal ? 200 : 202, body: job, headers: terminal ? {} : { location: `/v1/prompts/${job.id}` } };
    }
    const m = /^\/v1\/prompts\/([\w-]{1,80})(\/cancel)?$/.exec(path);
    if (m) {
      const id = m[1]!;
      if (!m[2] && method === 'GET') {
        const job = getJob(id);
        return job ? { status: 200, body: job } : { status: 404, body: errorBody('not_found', 'Такого запиту немає.') };
      }
      if (m[2] && method === 'POST') {
        const job = cancelJob(id);
        return job ? { status: 200, body: job } : { status: 404, body: errorBody('not_found', 'Такого запиту немає.') };
      }
    }
    return { status: 404, body: errorBody('not_found', 'Невідомий шлях.') };
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let reply: Reply;
    try {
      reply = await route(req);
    } catch (e) {
      if (e instanceof ApiError) {
        reply = { status: e.status, body: errorBody(e.code, e.message), headers: e.status === 429 ? { 'retry-after': '5' } : {} };
      } else {
        reply = { status: 500, body: errorBody('internal', 'Внутрішня помилка.') };
      }
    }
    // One line per request, never the headers or the body (they carry the token and the prompts).
    console.log(`${new Date().toISOString()} ${req.method} ${(req.url ?? '').split('?')[0]} -> ${reply.status}`);
    send(res, reply);
  };
}

/** Starts the API on 127.0.0.1. Refuses to start without a token. */
export function startApiServer(cfg: SwitchboardConfig, opts: { port?: number } = {}): Promise<Server> {
  const token = readApiToken();
  if (!token) return Promise.reject(new Error('Токена API ще немає. Створи його: sb api token'));
  // One handler for the whole lifetime: it owns the request counter of the rate limit.
  const handler = createApiHandler(cfg, token);
  const server = createServer((req, res) => void handler(req, res));
  server.requestTimeout = 60_000;
  const port = opts.port ?? cfg.api.port;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}
