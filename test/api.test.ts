// The public API (sb api): auth, validation, read-only answers, write mode, polling, cancel and throttling.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApiServer } from '../packages/core/api-server';
import { createApiToken, readApiToken, tokenMatches } from '../packages/core/api-token';
import { parseConfig } from '../packages/core/config';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
let dir: string;
let project: string;
let server: Server | undefined;
let base = '';
const TOKEN = 'sbk_test_token_value_1234567890';

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();

function makeRepo(name: string): string {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: p });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: p });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: p });
  writeFileSync(join(p, 'README.md'), '# site\n');
  writeFileSync(join(p, 'RULES.md'), '# rules\n');
  execFileSync('git', ['add', '-A'], { cwd: p });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: p });
  return p;
}

function launcher(name: string, mode: string): string {
  const path = join(dir, name);
  const env = `FAKE_AGENT_STYLE='${name.startsWith('agy') ? 'agy' : 'claude'}' FAKE_AGENT_MODE='${mode}' FAKE_ARGS_DUMP='${join(dir, 'args.jsonl')}'`;
  writeFileSync(path, `#!/bin/sh\nif [ "$2" = "/usage" ] || [ "$2" = "/quota" ] || [ "$1" = "auth" ] || [ "$1" = "models" ]; then echo "n/a"; exit 0; fi\nexec env ${env} "${FAKE}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Starts the API on a free port with fake agents answering in `mode`. */
async function boot(mode = 'answer', api: Record<string, number | boolean> = {}, projects: string[] = [project]) {
  chmodSync(FAKE, 0o755);
  const apiCfg = { rateLimitPerMin: 1000, maxConcurrent: 5, ...api };
  const text = `
agents:
  claude: { cmd: "${launcher('claude-fake', mode)}", headlessArgs: ["-p", "--output-format", "json"] }
  agy: { cmd: "${launcher('agy-fake', mode)}", settingsPath: "${join(dir, 'agy-settings.json')}" }
routing: { section: [claude, agy] }
permissions: { claude: { allow: [Read, Write, Edit] }, agy: { allow: [] } }
notifications: { enabled: false }
dashboard: { projects: [${projects.map((p) => `"${p}"`).join(', ')}] }
api: { ${Object.entries(apiCfg).map(([k, v]) => `${k}: ${v}`).join(', ')} }
`;
  // The detached `sb chat-turn` process reads the config from SB_CONFIG, so it must exist on disk.
  const file = join(dir, 'switchboard.config.yaml');
  writeFileSync(file, text);
  process.env.SB_CONFIG = file;
  const cfg = parseConfig(text);
  server = await startApiServer(cfg, { port: 0 });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return cfg;
}

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, json: (await res.json()) as any };
}

async function until(fn: () => Promise<boolean>, ms = 20_000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sb-api-')));
  process.env.SB_HOME = join(dir, 'home');
  process.env.SB_API_TOKEN = TOKEN;
  project = makeRepo('site');
  writeFileSync(join(dir, 'agy-settings.json'), '{}\n');
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  delete process.env.SB_HOME;
  delete process.env.SB_API_TOKEN;
  delete process.env.SB_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

describe('token', () => {
  it('creates a 0600 token once, keeps it, rotates on request, compares in constant time', () => {
    delete process.env.SB_API_TOKEN;
    expect(readApiToken()).toBeUndefined();
    const t = createApiToken()!;
    expect(t).toMatch(/^sbk_/);
    expect(readApiToken()).toBe(t);
    expect(createApiToken()).toBeUndefined();
    expect(createApiToken({ rotate: true })).not.toBe(t);
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });

  it('refuses to start without a token', async () => {
    delete process.env.SB_API_TOKEN;
    const cfg = parseConfig('agents: { claude: { cmd: c }, agy: { cmd: a } }');
    await expect(startApiServer(cfg, { port: 0 })).rejects.toThrow(/sb api token/);
  });
});

describe('auth and discovery', () => {
  it('health is open, everything else needs the bearer token', async () => {
    await boot();
    expect((await call('GET', '/v1/health', undefined, null)).json).toEqual({ ok: true });
    expect((await call('GET', '/v1/models', undefined, null)).status).toBe(401);
    expect((await call('GET', '/v1/models', undefined, 'wrong')).status).toBe(401);
    expect((await call('POST', '/v1/prompts', { prompt: 'x' }, null)).status).toBe(401);
    expect((await call('GET', '/v1/nope')).status).toBe(404);
  });

  it('lists agents with models and project names, and never an absolute path', async () => {
    await boot();
    const r = await call('GET', '/v1/models');
    expect(r.status).toBe(200);
    expect(r.json.agents.map((a: any) => a.agent)).toEqual(['claude', 'agy', 'codex']);
    expect(r.json.agents[0].models.map((m: any) => m.id)).toContain('opus');
    expect(r.json.projects).toEqual(['site']);
    expect(JSON.stringify(r.json)).not.toContain(dir);
    const s = await call('GET', '/v1/status');
    expect(s.status).toBe(200);
    expect(s.json.jobs).toMatchObject({ running: 0, maxConcurrent: 5 });
  });
});

describe('validation', () => {
  it('rejects bad input with a code', async () => {
    await boot();
    const code = async (body: unknown) => (await call('POST', '/v1/prompts', body)).json.error?.code;
    expect(await code({})).toBe('prompt_required');
    expect(await code({ prompt: 'x'.repeat(8001) })).toBe('prompt_too_long');
    expect(await code({ prompt: 'x', agent: 'gpt' })).toBe('unknown_agent');
    expect(await code({ prompt: 'x', model: 'opus' })).toBe('model_needs_agent');
    expect(await code({ prompt: 'x', agent: 'claude', model: 'gpt-9' })).toBe('unknown_model');
    expect(await code({ prompt: 'x', wait: 100 })).toBe('bad_wait');
    expect(await code({ prompt: 'x', write: 'yes' })).toBe('bad_write');
    expect(await code({ prompt: 'x', project: 'nope' })).toBe('unknown_project');
    expect(await code({ prompt: 'x', chat: 'c-none' })).toBe('unknown_chat');
    const bad = await fetch(`${base}/v1/prompts`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{oops' });
    expect(bad.status).toBe(400);
    const text = await fetch(`${base}/v1/prompts`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' }, body: 'hi' });
    expect(text.status).toBe(415);
  });

  it('needs "project" when several are allowed, and honours api.allowWrite', async () => {
    const other = makeRepo('other');
    await boot('answer', { allowWrite: false }, [project, other]);
    const r = await call('POST', '/v1/prompts', { prompt: 'x' });
    expect(r.json.error.code).toBe('project_required');
    const w = await call('POST', '/v1/prompts', { prompt: 'x', project: 'site', write: true });
    expect(w.status).toBe(403);
    expect(w.json.error.code).toBe('write_disabled');
  });
});

describe('read-only answers', () => {
  it('answers without touching the repo: no branch, no commit, works with a dirty tree, minimal tools', async () => {
    await boot('answer');
    writeFileSync(join(project, 'notes.txt'), 'my uncommitted work');
    const before = git('rev-parse', 'HEAD');
    const r = await call('POST', '/v1/prompts', { prompt: 'Що в README?', project: 'site', agent: 'claude', model: 'haiku', wait: 15 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'done', write: false, agent: 'claude', model: 'haiku', project: 'site' });
    expect(r.json.answer).toContain('Відповідь: Що в README?');
    expect(r.json.branch).toBeUndefined();
    expect(git('branch', '--list')).toBe('* main');
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('my uncommitted work');
    const run = JSON.parse(readFileSync(join(dir, 'args.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    expect(run.args).toContain('--model');
    expect(run.args[run.args.indexOf('--model') + 1]).toBe('haiku');
    expect(run.args[run.args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep');
    expect(run.args[run.args.indexOf('--disallowedTools') + 1]).toContain('Write');
    expect(run.args.join(' ')).not.toContain('--allowedTools Read,Write');
  }, 40_000);

  it('hides secrets and absolute paths in the answer', async () => {
    await boot('answer');
    const r = await call('POST', '/v1/prompts', { prompt: 'SECRET please', project: 'site', wait: 15 });
    expect(r.json.status).toBe('done');
    expect(r.json.answer).not.toMatch(/ghp_a{30}/);
    expect(r.json.answer).toContain('<token>');
    expect(r.json.answer).not.toContain(dir);
  }, 40_000);

  it('without wait it answers 202 and the job is polled until done', async () => {
    await boot('slow');
    const r = await call('POST', '/v1/prompts', { prompt: 'повільно', project: 'site' });
    expect(r.status).toBe(202);
    expect(['queued', 'running']).toContain(r.json.status);
    expect(r.headers.get('location')).toBe(`/v1/prompts/${r.json.id}`);
    let last: any;
    await until(async () => { last = (await call('GET', `/v1/prompts/${r.json.id}`)).json; return last.status === 'done'; });
    expect(last.answer).toContain('Відповідь: повільно');
    expect(last.durationMs).toBeGreaterThan(0);
    expect((await call('GET', '/v1/prompts/m-nothing-here')).status).toBe(404);
  }, 40_000);

  it('continues an API conversation and refuses to switch its write mode', async () => {
    await boot('answer');
    const a = await call('POST', '/v1/prompts', { prompt: 'перше', project: 'site', wait: 15 });
    const b = await call('POST', '/v1/prompts', { prompt: 'друге', chat: a.json.chat, wait: 15 });
    expect(b.json.status).toBe('done');
    expect(b.json.chat).toBe(a.json.chat);
    expect(b.json.id).not.toBe(a.json.id);
    const w = await call('POST', '/v1/prompts', { prompt: 'змінюй', chat: a.json.chat, write: true });
    expect(w.status).toBe(409);
    expect(w.json.error.code).toBe('write_mismatch');
  }, 60_000);
});

describe('write mode', () => {
  it('write:true behaves like a chat: branch sb/c-…, a commit and the project back on its branch', async () => {
    await boot('chat');
    const r = await call('POST', '/v1/prompts', { prompt: 'зроби футер', project: 'site', agent: 'claude', write: true, wait: 20 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'done', write: true });
    expect(r.json.branch).toMatch(/^sb\/c-/);
    expect(r.json.files).toEqual(['chat/claude.txt']);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git('log', '-1', '--format=%s', r.json.branch)).toMatch(/^chat\(sb\):/);
    expect(existsSync(join(project, 'chat'))).toBe(false); // the edit lives on the branch, main is untouched
    const run = JSON.parse(readFileSync(join(dir, 'args.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    expect(run.args[run.args.indexOf('--allowedTools') + 1]).toContain('Write');
  }, 60_000);

  it('write:true on a dirty tree is refused with tree_dirty and nothing is stored', async () => {
    await boot('chat');
    writeFileSync(join(project, 'notes.txt'), 'mine');
    const r = await call('POST', '/v1/prompts', { prompt: 'зроби', project: 'site', write: true });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('tree_dirty');
    expect(git('branch', '--list')).toBe('* main');
  }, 40_000);
});

describe('cancel and throttling', () => {
  it('cancels a running job', async () => {
    await boot('hang');
    const r = await call('POST', '/v1/prompts', { prompt: 'довго', project: 'site' });
    await until(async () => (await call('GET', `/v1/prompts/${r.json.id}`)).json.status === 'running');
    const c = await call('POST', `/v1/prompts/${r.json.id}/cancel`);
    expect(c.status).toBe(200);
    await until(async () => (await call('GET', `/v1/prompts/${r.json.id}`)).json.status === 'cancelled');
  }, 60_000);

  it('limits requests per minute and concurrent jobs', async () => {
    await boot('slow', { maxConcurrent: 1 });
    const a = await call('POST', '/v1/prompts', { prompt: 'один', project: 'site' });
    expect(a.status).toBe(202);
    const b = await call('POST', '/v1/prompts', { prompt: 'два', project: 'site' });
    expect(b.status).toBe(429);
    expect(b.json.error.code).toBe('too_many_jobs');
    await until(async () => (await call('GET', `/v1/prompts/${a.json.id}`)).json.status === 'done');
  }, 60_000);

  it('answers 429 with Retry-After after too many requests in a minute', async () => {
    await boot('answer', { rateLimitPerMin: 3 });
    for (let i = 0; i < 3; i++) expect((await call('GET', '/v1/models')).status).toBe(200);
    const r = await call('GET', '/v1/models');
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
