import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/core/config';
import { SbError, startTask, type StartInput } from '../packages/core/flow';
import { initProject } from '../packages/core/init';
import { interpretOutput } from '../packages/core/interpret';
import { parseProgress } from '../packages/core/progress';
import { buildOverview } from '../packages/core/overview';
import { readState, sbHome } from '../packages/core/store';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
let dir: string;
let project: string;

/** startTask with all outside-world dependencies stubbed: no real CLI is ever asked for usage. */
const start = (i: StartInput, c: ReturnType<typeof parseConfig>) =>
  startTask(i, c, () => {}, { overview: async () => buildOverview(c).agents, readUsage: async () => undefined, notify: async () => false });

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
  delete process.env.FAKE_PROGRESS_STATUS;
});
afterEach(() => {
  delete process.env.FAKE_PROGRESS_STATUS;
  delete process.env.SB_HOME;
  delete process.env.FAKE_AGENT_MODE;
  delete process.env.FAKE_AGENT_STYLE;
  rmSync(dir, { recursive: true, force: true });
});

describe('startTask', () => {
  it('runs on sb/<id>, commits the result, masks secrets, returns to main', async () => {
    const mainBefore = git('rev-parse', 'main');
    const r = await start(input(), cfg());

    expect(r.task.status).toBe('done');
    expect(r.run!.status).toBe('done');
    expect(r.task.branch).toBe(`sb/${r.task.id}`);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // back where we started
    expect(git('rev-parse', 'main')).toBe(mainBefore); // main never touched
    expect(git('branch', '--list', 'sb/*').split('\n')).toHaveLength(1);

    const files = git('diff', '--name-only', `main..${r.task.branch}`).split('\n');
    expect(files).toEqual(expect.arrayContaining(['src/components/Footer.astro', 'PROGRESS.md', `.sb/tasks/${r.task.id}.md`]));
    expect(git('log', '-1', '--format=%s', r.task.branch)).toMatch(/^feat\(sb\): Create Footer\.astro/);
    expect(r.warnings).not.toContain('Агент не оновив PROGRESS.md.');

    const log = readFileSync(r.run!.logPath, 'utf8');
    expect(log).not.toContain('sk-abcdefgh12345678');
    expect(log).toContain('<token>');
    expect(log).not.toContain('Create Footer.astro from DESIGN.md'); // the prompt is not dumped into the log
    expect(readState().tasks[r.task.id]?.status).toBe('done');
  });

  it("a run that ends with 'Status: blocked' in PROGRESS.md is blocked, with the open question as reason (seen in the first real run)", async () => {
    process.env.FAKE_PROGRESS_STATUS = 'blocked';
    const r = await start(input(), cfg());
    expect(r.outcome!.ok).toBe(true); // the process itself succeeded
    expect(r.task.status).toBe('blocked');
    expect(r.run!.reason).toContain('No Astro project, build not verified');
    expect(git('log', '-1', '--format=%s', r.task.branch)).toMatch(/^wip\(sb\)/);
  });

  it("'Status: in-progress' leaves the task waiting for a continuation", async () => {
    process.env.FAKE_PROGRESS_STATUS = 'in-progress';
    const r = await start(input(), cfg());
    expect(r.task.status).toBe('waiting');
    expect(git('log', '-1', '--format=%s', r.task.branch)).toMatch(/^wip\(sb\)/);
  });

  it('writes the task file with type, branch and definition of done', async () => {
    const r = await start(input({ figma: 'https://figma.com/x', priority: 'high' }), cfg());
    const md = git('show', `${r.task.branch}:.sb/tasks/${r.task.id}.md`);
    expect(md).toContain('- Type: section');
    expect(md).toContain('- Priority: high');
    expect(md).toContain('https://figma.com/x');
    expect(md).toContain('## Definition of done');
  });

  it('refuses a dirty working tree without creating a branch', async () => {
    writeFileSync(join(project, 'notes.txt'), 'uncommitted');
    await expect(start(input(), cfg())).rejects.toMatchObject({ exitCode: 3 });
    expect(git('branch', '--list', 'sb/*')).toBe('');
  });

  it('marks a run with denied tools as blocked and keeps partial work in a wip checkpoint', async () => {
    process.env.FAKE_AGENT_MODE = 'partial';
    const r = await start(input(), cfg());
    expect(r.task.status).toBe('blocked');
    expect(r.run!.reason).toBe('denied: Write');
    expect(git('log', '-1', '--format=%s', r.task.branch)).toMatch(/^wip\(sb\): checkpoint/);
    expect(git('show', '--stat', '--format=', r.task.branch)).toContain('Footer.astro');
  });

  it('treats a denied-only run with no changes as blocked, not done', async () => {
    process.env.FAKE_AGENT_MODE = 'denied';
    const r = await start(input(), cfg());
    expect(r.task.status).toBe('blocked');
    expect(r.outcome!.denied).toEqual(['Write']);
  });

  it('kills a hanging agent (including its child processes) at the timeout', async () => {
    process.env.FAKE_AGENT_MODE = 'hang';
    const t0 = Date.now();
    const r = await start(input({ timeoutMin: 0.03 }), cfg());
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.task.status).toBe('failed');
    expect(r.run!.reason).toMatch(/timeout/);
    expect(readFileSync(r.run!.logPath, 'utf8')).toContain('timeout after');
  }, 30_000);

  it('reports a failing agent and a missing binary as failed', async () => {
    process.env.FAKE_AGENT_MODE = 'error';
    expect((await start(input(), cfg())).task.status).toBe('failed');
    const bad = parseConfig(`
agents:
  claude: { cmd: "${join(dir, 'nope')}" }
  agy: { cmd: "${FAKE}" }
routing: { section: [claude] }
`);
    const r = await start(input(), bad);
    expect(r.task.status).toBe('failed');
    expect(r.run!.reason).toMatch(/cannot run/);
  });

  it('understands the agy output format and an explicit --agent', async () => {
    process.env.FAKE_AGENT_STYLE = 'agy';
    const r = await start(input({ agent: 'agy' }), cfg());
    expect(r.task.agent).toBe('agy');
    expect(r.task.status).toBe('done');
  });

  it('uses the first agent of the routing list for the task type', async () => {
    process.env.FAKE_AGENT_STYLE = 'agy';
    const r = await start(input({ type: 'review' }), cfg());
    expect(r.task.agent).toBe('agy');
  });

  it('push failures (no remote) are warnings, never errors', async () => {
    const r = await start(input(), cfg('git: { pushBranches: true }'));
    expect(r.task.status).toBe('done');
    expect(r.warnings.join(' ')).toMatch(/push не вдався/);
  });

  it('validates project, type and text', async () => {
    await expect(start(input({ project: join(dir, 'missing') }), cfg())).rejects.toBeInstanceOf(SbError);
    await expect(start(input({ type: 'nope' }), cfg())).rejects.toThrow(/Невідомий тип/);
    await expect(start(input({ text: '  ' }), cfg())).rejects.toThrow(/Порожній/);
    const plain = join(dir, 'plain');
    execFileSync('mkdir', ['-p', plain]);
    await expect(start(input({ project: plain }), cfg())).rejects.toThrow(/не є git/);
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
  it('creates the scaffolding in a new project and never overwrites existing files', () => {
    writeFileSync(join(project, 'AGENTS.md'), 'my agents file\n');
    const r = initProject(project);
    expect(r.mode).toBe('new');
    expect(r.created).toEqual(expect.arrayContaining(['RULES.md', 'DESIGN.md', 'CLAUDE.md']));
    expect(r.skipped).toContain('AGENTS.md');
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe('my agents file\n');
    expect(existsSync(join(project, '.sb/tasks/.gitkeep'))).toBe(true);
    expect(initProject(project).created).toEqual([]);
  });

  it('an existing project with its own CLAUDE.md gets thin pointer files, not TODO templates', () => {
    writeFileSync(join(project, 'CLAUDE.md'), 'my own rules\n');
    mkdirSync(join(project, 'src/styles'), { recursive: true });
    writeFileSync(join(project, 'src/styles/tokens.css'), ':root {}\n');
    const r = initProject(project);
    expect(r.mode).toBe('existing');
    expect(r.created).toEqual(expect.arrayContaining(['RULES.md', 'DESIGN.md', 'AGENTS.md']));
    expect(r.created).not.toContain('CLAUDE.md');
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('my own rules\n');
    const rules = readFileSync(join(project, 'RULES.md'), 'utf8');
    expect(rules).toContain('CLAUDE.md');
    expect(rules).toMatch(/Do NOT create branches, commit/);
    expect(rules).not.toContain('TODO');
    expect(readFileSync(join(project, 'DESIGN.md'), 'utf8')).toContain('src/styles/tokens.css');
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toContain('CLAUDE.md');
    expect(initProject(project).created).toEqual([]);
  });
});

describe('parseProgress', () => {
  const md = `# Notes

## Task t-1: Footer
- Status: blocked
- Last agent: claude
- Done:
  - [x] Footer
- Open questions:
  - Which year format?
  - Is there a build script?

## Task t-2: Other
- Status: done
`;
  it('reads status and open questions of the right task only', () => {
    expect(parseProgress(md, 't-1')).toEqual({ status: 'blocked', openQuestions: ['Which year format?', 'Is there a build script?'] });
    expect(parseProgress(md, 't-2')).toEqual({ status: 'done', openQuestions: [] });
  });
  it('returns no status when the section is missing or the value is unknown', () => {
    expect(parseProgress(md, 't-9').status).toBeUndefined();
    expect(parseProgress('## Task t-3: x\n- Status: ??\n', 't-3').status).toBeUndefined();
  });
});

describe('agy runs with temporary rules', () => {
  let settings: string;
  const agyCfg = (extra = '') => {
    chmodSync(FAKE, 0o755);
    return parseConfig(`
agents:
  claude: { cmd: "${FAKE}" }
  agy: { cmd: "${FAKE}", settingsPath: "${settings}" }
routing: { section: [agy, claude] }
permissions:
  claude: { allow: [Read] }
  agy: { allow: ["write_file({project}/)"], deny: ["write_file({project}/.env)"] }
${extra}
`);
  };
  const ORIGINAL = '{"colorScheme":"dark"}\n';

  beforeEach(() => {
    settings = join(dir, 'agy-settings.json');
    writeFileSync(settings, ORIGINAL);
    process.env.FAKE_AGENT_STYLE = 'agy';
    process.env.FAKE_AGY_SETTINGS = settings;
  });
  afterEach(() => { delete process.env.FAKE_AGY_SETTINGS; });

  it('lets agy write inside the project during the run and restores settings afterwards', async () => {
    const r = await start(input({ agent: 'agy' }), agyCfg());
    expect(r.task.status).toBe('done'); // the fake could only write because the rule was in place
    expect(git('show', '--stat', '--format=', r.task.branch)).toContain('Footer.astro');
    expect(readFileSync(settings, 'utf8')).toBe(ORIGINAL);
    expect(existsSync(join(sbHome(), 'agy-rules-journal.json'))).toBe(false);
  });

  it('without a configured rule agy stays blocked and the settings are never touched', async () => {
    const cfg = parseConfig(`
agents:
  claude: { cmd: "${FAKE}" }
  agy: { cmd: "${FAKE}", settingsPath: "${settings}" }
routing: { section: [agy] }
permissions: { agy: { allow: [] } }
`);
    const r = await start(input({ agent: 'agy' }), cfg);
    expect(r.task.status).toBe('blocked');
    expect(r.outcome!.denied).toEqual(['write_file']);
    expect(readFileSync(settings, 'utf8')).toBe(ORIGINAL);
  });

  it('restores the settings after a timeout', async () => {
    process.env.FAKE_AGENT_MODE = 'hang-agy';
    const r = await start(input({ agent: 'agy', timeoutMin: 0.03 }), agyCfg());
    expect(r.task.status).toBe('failed');
    expect(readFileSync(settings, 'utf8')).toBe(ORIGINAL);
  }, 30_000);

  it('refuses to start while another agy run holds the rules', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(sbHome(), { recursive: true });
    writeFileSync(join(sbHome(), 'agy-rules-journal.json'), JSON.stringify({ settingsPath: settings, backupPath: '', originalExisted: true, permissionsExisted: false, writtenHash: 'x', added: { allow: [], deny: [] }, pid: process.ppid, project: '/other', startedAt: '' }));
    await expect(start(input({ agent: 'agy' }), agyCfg())).rejects.toMatchObject({ exitCode: 3 });
    expect(git('branch', '--list', 'sb/*').split('\n').filter(Boolean).length).toBeLessThanOrEqual(1);
  });
});

describe('protected paths', () => {
  it('marks a run that changed netlify.toml as blocked and never pushes it', async () => {
    process.env.FAKE_AGENT_MODE = 'protected';
    const r = await start(input(), cfg('git: { pushBranches: true }'));
    expect(r.task.status).toBe('blocked');
    expect(r.run!.reason).toContain('netlify.toml');
    expect(r.warnings.join(' ')).not.toMatch(/push не вдався/); // push was skipped, not attempted
    expect(r.warnings.join(' ')).toMatch(/Захищені файли/);
  });
});
