import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskEmail, maskSecrets } from '../packages/core/mask';
import { clearExhausted, readState, saveSnapshot, sbHome, setExhausted } from '../packages/core/store';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sb-store-')); process.env.SB_HOME = dir; });
afterEach(() => { delete process.env.SB_HOME; rmSync(dir, { recursive: true, force: true }); });

describe('store', () => {
  it('starts empty and persists snapshots with private permissions', () => {
    expect(readState().snapshots).toEqual({});
    saveSnapshot({ agent: 'agy', source: 'cli', capturedAt: '2026-10-01T00:00:00Z' });
    expect(readState().snapshots.agy?.source).toBe('cli');
    expect(statSync(join(sbHome(), 'state.json')).mode & 0o777).toBe(0o600);
  });

  it('caps history and stores/clears exhausted marks', () => {
    for (let i = 0; i < 520; i++) saveSnapshot({ agent: 'claude', source: 'cli', capturedAt: new Date(i * 1000).toISOString() });
    expect(readState().history).toHaveLength(500);
    setExhausted('claude', { until: '2026-10-01T10:00:00Z', reason: 'test', since: '2026-10-01T05:00:00Z' });
    expect(readState().exhausted.claude?.reason).toBe('test');
    clearExhausted('claude');
    expect(readState().exhausted.claude).toBeUndefined();
  });

  it('recovers from a corrupt state file', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'state.json'), '{not json');
    expect(readState().snapshots).toEqual({});
  });
});

describe('mask', () => {
  it('masks emails for the UI', () => {
    expect(maskEmail('olexlebid@gmail.com')).toBe('ole…@gmail.com');
    expect(maskEmail('weird')).toBe('…');
  });
  it('masks secrets for logs', () => {
    const out = maskSecrets('Authorization: Bearer abc.def-123 and sk-ant-abcdefgh12345 and api_key=supersecretvalue');
    expect(out).not.toMatch(/abc\.def|sk-ant|supersecretvalue/);
  });
});

describe('state.json locking', () => {
  it('does not lose updates when several processes write at the same time', async () => {
    const { spawn } = await import('node:child_process');
    const script = join(import.meta.dirname, 'helpers/state-writer.ts');
    const run = () => new Promise<number>((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', script, '40'], { env: { ...process.env, SB_HOME: dir }, cwd: join(import.meta.dirname, '..'), stdio: 'ignore' });
      c.on('exit', (code) => resolve(code ?? 1));
    });
    const codes = await Promise.all([run(), run(), run(), run(), run(), run()]);
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect((readState().meta as Record<string, unknown>).counter).toBe(240);
  }, 60_000);

  it('takes over a stale lock left by a crashed process', async () => {
    const { writeFileSync: wf, utimesSync } = await import('node:fs');
    const lock = join(dir, 'state.json.lock');
    wf(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    saveSnapshot({ agent: 'claude', source: 'cli', capturedAt: '2026-10-01T00:00:00Z' });
    expect(readState().snapshots.claude).toBeDefined();
  });
});
