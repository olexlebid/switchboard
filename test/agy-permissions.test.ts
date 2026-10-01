import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgyPermissionError, applyAgyRules, recoverAgyRules } from '../packages/core/agy-permissions';
import { matchesProtected } from '../packages/core/protected';
import { sbHome } from '../packages/core/store';

let dir: string;
let settings: string;
const rules = { allow: ['write_file(/p/proj/)'], deny: ['write_file(/p/proj/.env)'] };
const apply = () => applyAgyRules({ settingsPath: settings, project: '/p/proj', ...rules });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-agyp-'));
  process.env.SB_HOME = join(dir, 'home');
  settings = join(dir, 'agy', 'settings.json');
  mkdirSync(join(dir, 'agy'));
});
afterEach(() => { delete process.env.SB_HOME; rmSync(dir, { recursive: true, force: true }); });

const journal = () => join(sbHome(), 'agy-rules-journal.json');

describe('applyAgyRules', () => {
  it('adds the rules, keeps other keys, and restores the original byte for byte', () => {
    const original = '{"colorScheme":"dark",  "trustedWorkspaces":["/x"]}\n'; // odd formatting on purpose
    writeFileSync(settings, original);
    const h = apply();
    const during = JSON.parse(readFileSync(settings, 'utf8'));
    expect(during.permissions.allow).toEqual(rules.allow);
    expect(during.permissions.deny).toEqual(rules.deny);
    expect(during.trustedWorkspaces).toEqual(['/x']);
    expect(existsSync(journal())).toBe(true);

    h.restore();
    expect(readFileSync(settings, 'utf8')).toBe(original);
    expect(existsSync(journal())).toBe(false);
    expect(h.restore()).toBe('already restored'); // idempotent
  });

  it('keeps rules that were already there and never removes them', () => {
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ['write_file(/p/proj/)', 'read_file(*)'] } }));
    const h = apply();
    expect(h.added.allow).toEqual([]); // already present, so not ours
    expect(h.added.deny).toEqual(rules.deny);
    // someone edits the file meanwhile: only our rules may disappear
    const cur = JSON.parse(readFileSync(settings, 'utf8'));
    cur.colorScheme = 'light';
    writeFileSync(settings, JSON.stringify(cur));
    h.restore();
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    expect(after.colorScheme).toBe('light');
    expect(after.permissions.allow).toEqual(['write_file(/p/proj/)', 'read_file(*)']);
    expect(after.permissions.deny).toBeUndefined();
  });

  it('removes the permissions block it created when the file was edited meanwhile', () => {
    writeFileSync(settings, '{"a":1}');
    const h = apply();
    const cur = JSON.parse(readFileSync(settings, 'utf8'));
    cur.b = 2;
    writeFileSync(settings, JSON.stringify(cur));
    h.restore();
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ a: 1, b: 2 });
  });

  it('creates and removes the settings file when none existed', () => {
    const h = apply();
    expect(existsSync(settings)).toBe(true);
    h.restore();
    expect(existsSync(settings)).toBe(false);
  });

  it('refuses invalid JSON without touching the file', () => {
    writeFileSync(settings, '{oops');
    expect(apply).toThrow(AgyPermissionError);
    expect(readFileSync(settings, 'utf8')).toBe('{oops');
    expect(existsSync(journal())).toBe(false);
  });

  it('refuses to start while another live process holds the journal', () => {
    writeFileSync(settings, '{"a":1}');
    mkdirSync(sbHome(), { recursive: true });
    writeFileSync(journal(), JSON.stringify({ settingsPath: settings, backupPath: '', originalExisted: true, permissionsExisted: false, writtenHash: 'x', added: { allow: [], deny: [] }, pid: process.ppid, project: '/other', startedAt: '' }));
    expect(apply).toThrow(/ще триває/);
  });

  it('repairs a crash: a dead process left rules behind', () => {
    const original = '{"colorScheme":"dark"}\n';
    writeFileSync(settings, original);
    // Simulate a crashed run in a child process that exits without restoring.
    const code = `
      import { applyAgyRules } from ${JSON.stringify(join(import.meta.dirname, '../packages/core/agy-permissions.ts'))};
      applyAgyRules({ settingsPath: ${JSON.stringify(settings)}, project: '/p/proj', allow: ['write_file(/p/proj/)'], deny: [] });
      process.kill(process.pid, 'SIGKILL');`;
    spawnSync('npx', ['tsx', '--input-type=module', '-e', code], { env: { ...process.env, SB_HOME: join(dir, 'home') }, cwd: join(import.meta.dirname, '..') });
    expect(readFileSync(settings, 'utf8')).toContain('write_file(/p/proj/)'); // crashed with rules in place
    expect(recoverAgyRules()).toMatch(/Відновлено/);
    expect(readFileSync(settings, 'utf8')).toBe(original);
    expect(recoverAgyRules()).toBeUndefined();
  }, 30_000);
});

describe('matchesProtected', () => {
  const p = ['netlify.toml', '.env*'];
  it('matches protected names at any depth', () => {
    expect(matchesProtected('netlify.toml', p)).toBe(true);
    expect(matchesProtected('sub/netlify.toml', p)).toBe(true);
    expect(matchesProtected('.env.local', p)).toBe(true);
    expect(matchesProtected('src/.env', p)).toBe(true);
  });
  it('does not match look-alikes', () => {
    expect(matchesProtected('netlify.toml.md', p)).toBe(false);
    expect(matchesProtected('src/environment.ts', p)).toBe(false);
    expect(matchesProtected('src/components/Footer.astro', p)).toBe(false);
  });
  it('supports path patterns', () => {
    expect(matchesProtected('.github/workflows/ci.yml', ['.github/**'])).toBe(true);
    expect(matchesProtected('docs/.github/x', ['.github/**'])).toBe(false);
  });
});
