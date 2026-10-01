import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRequest } from '../apps/dashboard/src/guard';
import { parseConfig } from '../packages/core/config';
import { countAgyModels } from '../packages/core/limits/agy';
import { getOverview } from '../packages/core/overview';
import { readState, setManual } from '../packages/core/store';
import { AGY_QUOTA, CLAUDE_USAGE } from './fixtures';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sb-ov-')); process.env.SB_HOME = join(dir, 'home'); });
afterEach(() => { delete process.env.SB_HOME; rmSync(dir, { recursive: true, force: true }); });

/** Fake CLI that appends a line to a counter file on every call, so tests can count CLI runs. */
function fakeCli(name: string, body: string): string {
  const p = join(dir, name);
  const counter = join(dir, `${name}.calls`);
  writeFileSync(p, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(counter)}, process.argv.slice(2).join(' ') + '\\n');\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const calls = (name: string) => {
  try { return require('node:fs').readFileSync(join(dir, `${name}.calls`), 'utf8').trim().split('\n').length; } catch { return 0; }
};

function cfg() {
  const claude = fakeCli('claude', `if (process.argv[2]==='auth') console.log('{}'); else console.log(${JSON.stringify(CLAUDE_USAGE)});`);
  const agy = fakeCli('agy', `if (process.argv[2]==='models') console.log('Fetching available models...\\nm-1\\tModel 1\\nm-2\\tModel 2'); else console.log(${JSON.stringify(AGY_QUOTA)});`);
  return parseConfig(`
agents:
  claude: { cmd: "${claude}" }
  agy: { cmd: "${agy}" }
limits: { fetchTimeoutSec: 5 }
dashboard: { refreshTtlSec: 3600 }
`);
}

describe('getOverview', () => {
  it('cached mode never runs a CLI and reports unknown without data', async () => {
    const c = cfg();
    const o = await getOverview('cached', c);
    expect(calls('claude') + calls('agy')).toBe(0);
    expect(o.summary.unknown).toBe(2);
    expect(o.agents.map((a) => a.agent)).toEqual(['claude', 'agy']);
  });

  it('force reads both CLIs; if-stale reuses the result within the TTL', async () => {
    const c = cfg();
    const first = await getOverview('force', c);
    expect(first.agents.every((a) => a.snapshot)).toBe(true);
    expect(first.agents[1]?.snapshot?.modelCount).toBe(2);
    const usageCallsAfterForce = calls('claude');
    await getOverview('if-stale', c);
    expect(calls('claude')).toBe(usageCallsAfterForce); // no new CLI runs
    await getOverview('force', c);
    expect(calls('claude')).toBeGreaterThan(usageCallsAfterForce);
  });

  it('caches `agy models` between refreshes', async () => {
    const c = cfg();
    await getOverview('force', c);
    await getOverview('force', c);
    const modelCalls = require('node:fs').readFileSync(join(dir, 'agy.calls'), 'utf8').split('\n').filter((l: string) => l === 'models').length;
    expect(modelCalls).toBe(1);
  });

  it('includes manual cards with their stored state', async () => {
    const c = cfg();
    setManual('stitch', 'exhausted');
    const o = await getOverview('cached', c);
    expect(o.manual.find((m) => m.id === 'stitch')?.state).toBe('exhausted');
    expect(o.manual.find((m) => m.id === 'gemini-chat')?.state).toBeUndefined();
    expect(readState().manual.stitch?.state).toBe('exhausted');
  });
});

describe('countAgyModels', () => {
  it('counts model rows and skips the header line', () => {
    expect(countAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n')).toBe(2);
    expect(countAgyModels('')).toBe(0);
  });
});

describe('request guard', () => {
  const req = (headers: Record<string, string>) => new Request('http://127.0.0.1:4321/api/status', { headers });
  it('accepts localhost hosts and same-origin requests', () => {
    expect(checkRequest(req({ host: '127.0.0.1:4321' }))).toBeUndefined();
    expect(checkRequest(req({ host: 'localhost:4321', origin: 'http://localhost:4321' }))).toBeUndefined();
  });
  it('rejects DNS-rebinding hosts and foreign origins', () => {
    expect(checkRequest(req({ host: 'evil.example:4321' }))).toBeDefined();
    expect(checkRequest(req({ host: '127.0.0.1:4321', origin: 'http://evil.example' }))).toBeDefined();
    expect(checkRequest(req({ host: '127.0.0.1:4321', origin: 'not a url' }))).toBeDefined();
    expect(checkRequest(req({}))).toBeDefined();
  });
});
