import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/core/config';
import { SbError, startTask } from '../packages/core/flow';
import { initProject } from '../packages/core/init';
import { interpretOutput } from '../packages/core/interpret';
import { readState } from '../packages/core/store';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
let dir: string;
let project: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();

function makeRepo(): string {
  const p = join(dir, 'site');
  execFileSync('mkdir', ['-p', p]);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: p });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: p });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: p });
  writeFileSync(join(p, 'README.md'), '# site\n');
  execFileSync('git', ['add', '-A'], { cwd: p });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: p });
  return p;
}

function cfg(extra = '') {
  chmodSync(FAKE, 0o755);
  return parseConfig(`
agents:
  claude: { cmd: "${FAKE}", headlessArgs: ["-p", "--output-format", "json"] }
  agy: { cmd: "${FAKE}", headlessArgs: ["-p", "--output-format", "json"] }
routing: { section: [claude, agy], review: [agy, claude] }
permissions:
  claude: { allow: [Read, Write], deny: ["Bash(git push*)"] }
${extra}
`);
}

const input = (over: Record<string, unknown> = {}) => ({ text: 'Create Footer.astro from DESIGN.md', type: 'section', project, ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-flow-'));
  process.env.SB_HOME = join(dir, 'home');
  project = makeRepo();
  delete process.env.FAKE_AGENT_MODE;
  delete process.env.FAKE_AGENT_STYLE;
});
afterEach(() => {
  delete process.env.SB_HOME;
  delete process.env.FAKE_AGENT_MODE;
  delete process.env.FAKE_AGENT_STYLE;
  rmSync(dir, { recursive: true, force: true });
});

describe('startTask', () => {
  it('runs on sb/<id>, commits the result, masks secrets, returns to main', async () => {
    const mainBefore = git('rev-parse', 'main');
    const r = await startTask(input(), cfg());

    expect(r.task.status).toBe('done');
    expect(r.run.status).toBe('done');
    expect(r.task.branch).toBe(`sb/${r.task.id}`);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // back where we started
    expect(git('rev-parse', 'main')).toBe(mainBefore); // main never touched
    expect(git('branch', '--list', 'sb/*').split('\n')).toHaveLength(1);

    const files = git('diff', '--name-only', `main..${r.task.branch}`).split('\n');
    expect(files).toEqual(expect.arrayContaining(['src/components/Footer.astro', 'PROGRESS.md', `.sb/tasks/${r.task.id}.md`]));
    expect(git('log', '-1', '--format=%s', r.task.branch)).toMatch(/^feat\(sb\): Create Footer\.astro/);
    expect(r.warnings).not.toContain('Агент не оновив PROGRESS.md.');

    const log = readFileSync(r.run.logPath, 'utf8');
    expect(log).not.toContain('sk-abcdefgh12345678');
    expect(log).toContain('<token>');
    expect(log).not.toContain('Create Footer.astro from DESIGN.md'); // the prompt is not dumped into the log
    expect(readState().tasks[r.task.id]?.status).toBe('done');
  });

  it('writes the task file with type, branch and definition of done', async () => {
    const r = await startTask(input({ figma: 'https://figma.com/x', priority: 'high' }), cfg());
    const md = git('show', `${r.task.branch}:.sb/tasks/${r.task.id}.md`);
    expect(md).toContain('- Type: section');
    expect(md).toContain('- Priority: high');
    expect(md).toContain('https://figma.com/x');
    expect(md).toContain('## Definition of done');
  });

  it('refuses a dirty working tree without creating a branch', async () => {
    writeFileSync(join(project, 'notes.txt'), 'uncommitted');
    await expect(startTask(input(), cfg())).rejects.toMatchObject({ exitCode: 3 });
    expect(git('branch', '--list', 'sb/*')).toBe('');
  });

  it('marks a run with denied tools as blocked and keeps partial work in a wip checkpoint', async () => {
    process.env.FAKE_AGENT_MODE = 'partial';
    const r = await startTask(input(), cfg());
    expect(r.task.status).toBe('blocked');
    expect(r.run.reason).toBe('denied: Write');
    expect(git('log', '-1', '--format=%s', r.task.branch)).toMatch(/^wip\(sb\): checkpoint/);
    expect(git('show', '--stat', '--format=', r.task.branch)).toContain('Footer.astro');
  });

  it('treats a denied-only run with no changes as blocked, not done', async () => {
    process.env.FAKE_AGENT_MODE = 'denied';
    const r = await startTask(input(), cfg());
    expect(r.task.status).toBe('blocked');
    expect(r.outcome.denied).toEqual(['Write']);
  });

  it('kills a hanging agent (including its child processes) at the timeout', async () => {
    process.env.FAKE_AGENT_MODE = 'hang';
    const t0 = Date.now();
    const r = await startTask(input({ timeoutMin: 0.03 }), cfg());
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.task.status).toBe('failed');
    expect(r.run.reason).toMatch(/timeout/);
    expect(readFileSync(r.run.logPath, 'utf8')).toContain('timeout after');
  }, 30_000);

  it('reports a failing agent and a missing binary as failed', async () => {
    process.env.FAKE_AGENT_MODE = 'error';
    expect((await startTask(input(), cfg())).task.status).toBe('failed');
    const bad = parseConfig(`
agents:
  claude: { cmd: "${join(dir, 'nope')}" }
  agy: { cmd: "${FAKE}" }
routing: { section: [claude] }
`);
    const r = await startTask(input(), bad);
    expect(r.task.status).toBe('failed');
    expect(r.run.reason).toMatch(/cannot run/);
  });

  it('understands the agy output format and an explicit --agent', async () => {
    process.env.FAKE_AGENT_STYLE = 'agy';
    const r = await startTask(input({ agent: 'agy' }), cfg());
    expect(r.task.agent).toBe('agy');
    expect(r.task.status).toBe('done');
  });

  it('uses the first agent of the routing list for the task type', async () => {
    process.env.FAKE_AGENT_STYLE = 'agy';
    const r = await startTask(input({ type: 'review' }), cfg());
    expect(r.task.agent).toBe('agy');
  });

  it('push failures (no remote) are warnings, never errors', async () => {
    const r = await startTask(input(), cfg('git: { pushBranches: true }'));
    expect(r.task.status).toBe('done');
    expect(r.warnings.join(' ')).toMatch(/push не вдався/);
  });

  it('validates project, type and text', async () => {
    await expect(startTask(input({ project: join(dir, 'missing') }), cfg())).rejects.toBeInstanceOf(SbError);
    await expect(startTask(input({ type: 'nope' }), cfg())).rejects.toThrow(/Невідомий тип/);
    await expect(startTask(input({ text: '  ' }), cfg())).rejects.toThrow(/Порожній/);
    const plain = join(dir, 'plain');
    execFileSync('mkdir', ['-p', plain]);
    await expect(startTask(input({ project: plain }), cfg())).rejects.toThrow(/не є git/);
  });
});

describe('interpretOutput', () => {
  it('claude: denials make the run not ok even with is_error false (recon sample)', () => {
    const out = JSON.stringify({ is_error: false, subtype: 'success', result: 'blocked by permissions', permission_denials: [{ tool_name: 'Write' }, { tool_name: 'Bash' }, { tool_name: 'Write' }] });
    expect(interpretOutput('claude', out, '')).toMatchObject({ ok: false, denied: ['Write', 'Bash'] });
  });
  it('claude: clean success', () => {
    expect(interpretOutput('claude', JSON.stringify({ is_error: false, result: 'ok', permission_denials: [] }), '').ok).toBe(true);
  });
  it('claude: is_error and api errors', () => {
    expect(interpretOutput('claude', JSON.stringify({ is_error: true, result: 'Credit balance too low' }), '')).toMatchObject({ ok: false, error: 'Credit balance too low' });
    expect(interpretOutput('claude', JSON.stringify({ is_error: false, api_error_status: 429, result: '' }), '').ok).toBe(false);
  });
  it('agy: SUCCESS with denied_actions is not ok (recon sample, exit code was 0)', () => {
    const stderr = 'jetski: no output produced — a tool required the "write_file" permission';
    const stdout = JSON.stringify({ conversation_id: 'x', status: 'SUCCESS', response: '', denied_actions: [{ action: 'write_file', display_name: 'WriteToFile' }] });
    expect(interpretOutput('agy', stdout, stderr)).toMatchObject({ ok: false, denied: ['write_file'] });
  });
  it('agy: JSON may follow a notice line', () => {
    const stdout = 'some notice\n' + JSON.stringify({ status: 'SUCCESS', response: 'hi', denied_actions: [] });
    expect(interpretOutput('agy', stdout, '')).toMatchObject({ ok: true, summary: 'hi' });
  });
  it('no JSON at all is a failure', () => {
    expect(interpretOutput('claude', 'garbage', '').ok).toBe(false);
  });
});

describe('initProject', () => {
  it('creates the scaffolding and never overwrites existing files', () => {
    writeFileSync(join(project, 'CLAUDE.md'), 'my own rules\n');
    const r = initProject(project);
    expect(r.created).toEqual(expect.arrayContaining(['RULES.md', 'DESIGN.md', 'AGENTS.md']));
    expect(r.skipped).toContain('CLAUDE.md');
    expect(r.warnings.join(' ')).toMatch(/@RULES\.md/);
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('my own rules\n');
    expect(existsSync(join(project, '.sb/tasks/.gitkeep'))).toBe(true);
    const again = initProject(project);
    expect(again.created).toEqual([]);
  });
});
