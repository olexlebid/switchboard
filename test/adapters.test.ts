import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/core/config';
import { collectUsage } from '../packages/core/limits';
import { readState } from '../packages/core/store';
import { AGY_QUOTA, CLAUDE_USAGE } from './fixtures';

const ROOT = join(import.meta.dirname, '..');
let dir: string;

/** Writes an executable Node script that acts as a fake CLI. */
function fakeCli(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function config(claude: string, agy: string) {
  return parseConfig(`
agents:
  claude: { cmd: "${claude}", headlessArgs: ["-p"] }
  agy: { cmd: "${agy}", headlessArgs: ["-p"] }
limits: { fetchTimeoutSec: 3 }
`);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sb-adapt-')); process.env.SB_HOME = join(dir, 'home'); });
afterEach(() => { delete process.env.SB_HOME; rmSync(dir, { recursive: true, force: true }); });

describe('collectUsage with fake CLIs', () => {
  const claudeOk = () => fakeCli('claude', `
const a = process.argv.slice(2);
if (a[0] === 'auth') console.log(JSON.stringify({ email: 'olexlebid@gmail.com', subscriptionType: 'pro' }));
else console.log(${JSON.stringify(CLAUDE_USAGE)});`);
  const agyOk = () => fakeCli('agy', `console.log(${JSON.stringify(AGY_QUOTA)});`);

  it('returns normalized snapshots and stores them', async () => {
    const now = new Date('2026-10-01T05:53:00Z');
    const res = await collectUsage(config(claudeOk(), agyOk()), now);
    const claude = res.find((r) => r.agent === 'claude')!;
    const agy = res.find((r) => r.agent === 'agy')!;
    expect(claude.error).toBeUndefined();
    expect(claude.snapshot?.fiveHour?.usedPct).toBe(2);
    expect(claude.snapshot?.account).toBe('ole…@gmail.com · pro');
    expect(claude.snapshot?.source).toBe('cli');
    expect(agy.snapshot?.perGroup).toHaveLength(4);
    expect(agy.snapshot?.fiveHour?.resetsAt).toBe('2026-10-01T10:45:23Z');
    expect(readState().snapshots.claude?.capturedAt).toBe(now.toISOString());
  });

  it('keeps the last stored snapshot and reports the error when a CLI fails', async () => {
    await collectUsage(config(claudeOk(), agyOk()), new Date('2026-10-01T05:00:00Z'));
    const badClaude = fakeCli('claude-bad', `console.log('something unexpected'); `);
    const res = await collectUsage(config(badClaude, join(dir, 'does-not-exist')), new Date('2026-10-01T06:00:00Z'));
    const claude = res.find((r) => r.agent === 'claude')!;
    const agy = res.find((r) => r.agent === 'agy')!;
    expect(claude.error).toMatch(/no "Current session/);
    expect(claude.snapshot?.capturedAt).toBe('2026-10-01T05:00:00.000Z'); // old data, so the status can show its age
    expect(agy.error).toMatch(/cannot run/);
  });

  it('times out a hanging CLI', async () => {
    const hang = fakeCli('claude-hang', `setTimeout(() => {}, 60000);`);
    const cfg = parseConfig(`
agents:
  claude: { cmd: "${hang}" }
  agy: { cmd: "${agyOk()}" }
limits: { fetchTimeoutSec: 1 }
`);
    const res = await collectUsage(cfg, new Date());
    expect(res.find((r) => r.agent === 'claude')?.error).toMatch(/timed out/);
  }, 10_000);
});

describe('statusline hook', () => {
  const hook = join(ROOT, 'hooks/claude-statusline.mjs');
  const run = (input: unknown, args: string[] = []) =>
    spawnSync('node', [hook, ...args], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, SB_HOME: join(dir, 'home') } });

  it('writes a snapshot when rate_limits is present and prints a short line', () => {
    const r = run({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1790000000 }, seven_day: { used_percentage: 3, resets_at: 1790500000 } } });
    expect(r.stdout.trim()).toBe('5h 12% | 7d 3%');
    const snap = JSON.parse(readFileSync(join(dir, 'home', 'claude-usage.json'), 'utf8'));
    expect(snap.source).toBe('statusline');
    expect(snap.fiveHour).toEqual({ usedPct: 12, resetsAt: new Date(1790000000 * 1000).toISOString() });
  });

  it('does nothing harmful without rate_limits and wraps an existing statusLine', () => {
    const wrapped = Buffer.from('echo my-old-line').toString('base64');
    const r = run({ model: { id: 'x' } }, ['--wrap-b64', wrapped]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('my-old-line');
  });

  it('survives invalid input', () => {
    const r = spawnSync('node', [hook], { input: 'not json', encoding: 'utf8', env: { ...process.env, SB_HOME: join(dir, 'home') } });
    expect(r.status).toBe(0);
  });
});

describe('sb hook install / uninstall', () => {
  const sb = (args: string[], claudeHome: string) =>
    spawnSync('npx', ['tsx', join(ROOT, 'bin/sb.ts'), ...args], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, SB_HOME: join(dir, 'home'), CLAUDE_HOME: claudeHome },
    });

  it('backs up settings, wraps the old statusLine and restores it', () => {
    const ch = join(dir, 'claude'); mkdirSync(ch);
    const file = join(ch, 'settings.json');
    const original = { theme: 'dark', statusLine: { type: 'command', command: 'echo old' } };
    writeFileSync(file, JSON.stringify(original));

    const dry = sb(['hook', 'install', '--dry-run'], ch);
    expect(dry.status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(original);

    const inst = sb(['hook', 'install'], ch);
    expect(inst.status).toBe(0);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.statusLine.command).toContain('claude-statusline.mjs');
    expect(after.statusLine.command).toContain('--wrap-b64');
    const backups = readdirSync(ch).filter((f) => f.includes('sb-backup'));
    expect(backups).toHaveLength(1);

    expect(sb(['hook', 'install'], ch).stdout).toContain('вже встановлено');

    expect(sb(['hook', 'uninstall'], ch).status).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(original);
  }, 30_000);

  it('refuses to touch an invalid settings.json', () => {
    const ch = join(dir, 'claude2'); mkdirSync(ch);
    writeFileSync(join(ch, 'settings.json'), '{oops');
    const r = sb(['hook', 'install'], ch);
    expect(r.status).toBe(1);
    expect(readFileSync(join(ch, 'settings.json'), 'utf8')).toBe('{oops');
  }, 30_000);
});
