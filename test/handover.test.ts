// Stage 4 scenarios, all on the fake agent (test/fake-agent.mjs): no real model, no real limits burned.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/core/config';
import { resumeTask, startTask, type FlowDeps, type StartInput } from '../packages/core/flow';
import { saveAttachments } from '../packages/core/attachments';
import { outputTail, writeCheckpoint } from '../packages/core/handoff';
import { buildOverview } from '../packages/core/overview';
import { clearExhausted, readState, setExhausted } from '../packages/core/store';
import type { AgentId, Task } from '../packages/core/types';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
let dir: string;
let project: string;
let notes: string[];
let dump: string;
let agySettings: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
// Second precision: claude-style messages carry the reset time as unix seconds.
const inHours = (h: number) => new Date(Math.floor((Date.now() + h * 3600_000) / 1000) * 1000).toISOString();
const in2h = () => inHours(2);
const in1h = () => inHours(1);

function makeRepo(): string {
  const p = join(dir, 'site');
  mkdirSync(p, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: p });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: p });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: p });
  writeFileSync(join(p, 'README.md'), '# site\n');
  writeFileSync(join(p, 'RULES.md'), '# rules\n');
  writeFileSync(join(p, 'DESIGN.md'), '# design\n');
  execFileSync('git', ['add', '-A'], { cwd: p });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: p });
  return p;
}

/** A tiny launcher that runs the fake agent with fixed behaviour for one "agent". */
function launcher(name: string, env: Record<string, string>): string {
  const path = join(dir, name);
  const exports = Object.entries(env).map(([k, v]) => `${k}='${v}'`).join(' ');
  writeFileSync(path, `#!/bin/sh\nexec env ${exports} "${FAKE}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

type Modes = { claude?: string; agy?: string; reset?: string; extra?: string };
function cfgFor(modes: Modes) {
  chmodSync(FAKE, 0o755);
  const reset: Record<string, string> = modes.reset ? { FAKE_RESET_AT: modes.reset } : {};
  const common = { FAKE_PROMPT_DUMP: dump, ...reset };
  const claude = launcher('claude-fake', { ...common, FAKE_AGENT_STYLE: 'claude', FAKE_AGENT_MODE: modes.claude ?? 'success' });
  const agy = launcher('agy-fake', { ...common, FAKE_AGENT_STYLE: 'agy', FAKE_AGENT_MODE: modes.agy ?? 'success', FAKE_AGY_SETTINGS: agySettings });
  return parseConfig(`
agents:
  claude: { cmd: "${claude}", headlessArgs: ["-p", "--output-format", "json"] }
  agy: { cmd: "${agy}", settingsPath: "${agySettings}" }
routing: { section: [claude, agy], review: [agy, claude], research: [agy, claude] }
permissions:
  claude: { allow: [Read, Write] }
  agy: { allow: ["write_file({project}/)"] }
${modes.extra ?? ''}
`);
}

function deps(cfg: ReturnType<typeof parseConfig>, over: Partial<FlowDeps> = {}): FlowDeps {
  return {
    overview: async () => buildOverview(cfg).agents,
    readUsage: async () => undefined,
    notify: async (title, msg) => { notes.push(`${title}: ${msg}`); return true; },
    ...over,
  };
}

const input = (over: Partial<StartInput> = {}): StartInput => ({ text: 'Create Footer.astro from DESIGN.md', type: 'section', project, ...over });
const prompts = () => (existsSync(dump) ? readFileSync(dump, 'utf8').split('=== ').filter(Boolean) : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-ho-'));
  process.env.SB_HOME = join(dir, 'home');
  project = makeRepo();
  notes = [];
  dump = join(dir, 'prompts.txt');
  agySettings = join(dir, 'agy-settings.json');
  writeFileSync(agySettings, '{"colorScheme":"dark"}\n');
});
afterEach(() => {
  delete process.env.SB_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe('scenario 1: limit in the middle of a task, the other agent continues', () => {
  it('checkpoints, marks claude exhausted, hands over to agy with a continuation prompt', async () => {
    const reset = in2h();
    const cfg = cfgFor({ claude: 'limit', agy: 'success', reset });
    const r = await startTask(input(), cfg, () => {}, deps(cfg));

    expect(r.task.status).toBe('done');
    expect(r.runs.map((x) => x.agent)).toEqual(['claude', 'agy']);
    expect(r.runs[0]!.status).toBe('failed');
    expect(r.runs[0]!.reason).toMatch(/ліміт/);
    expect(r.handoffs).toHaveLength(1);
    expect(r.handoffs[0]).toMatchObject({ from: 'claude', to: 'agy' });

    // claude is marked exhausted until the reset time found in its message
    expect(readState().exhausted.claude?.until).toBe(new Date(reset).toISOString());

    // the history on the branch: claude's work was checkpointed, agy finished
    const log = git('log', '--format=%s', `main..${r.task.branch}`).split('\n');
    expect(log[0]).toMatch(/^feat\(sb\):/);
    expect(log).toContain(`wip(sb): checkpoint ${r.task.id} from claude`);

    // PROGRESS.md carries the orchestrator's Handoff note (claude never wrote its own) and agy's section
    const progress = git('show', `${r.task.branch}:PROGRESS.md`);
    expect(progress).toContain(`## Handoff ${r.task.id}: claude → agy`);
    expect(progress).toContain('Reason: ліміт використання');
    expect(progress).toContain('Footer.astro'); // changed-files stat
    expect(progress).toContain(`## Task ${r.task.id}: Footer`);

    // the second prompt is the continuation prompt, adapted for an agent without shell
    const [first, second] = prompts();
    expect(first).toContain('claude');
    expect(second).toContain('You are continuing a task started by another AI agent that hit its usage limit.');
    expect(second).toContain('Handoff');
    expect(second).not.toContain('git log --oneline');
    expect(second).toContain('Do not redo finished items. Continue from "Next".');

    expect(notes).toEqual([]); // finished normally: no pause notification
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('with --no-handoff it stops at the limit and waits instead of switching agents', async () => {
    const cfg = cfgFor({ claude: 'limit', agy: 'success', reset: in2h() });
    const r = await startTask(input({ noHandoff: true }), cfg, () => {}, deps(cfg));
    expect(r.task.status).toBe('waiting');
    expect(r.runs.map((x) => x.agent)).toEqual(['claude']);
    expect(r.waiting?.reason).toMatch(/--no-handoff/);
    expect(notes).toHaveLength(1);
  });

  it('a handover limit of 0 pauses at the first limit', async () => {
    const cfg = cfgFor({ claude: 'limit', agy: 'success', reset: in2h(), extra: 'handoff: { maxHandoffs: 0 }' });
    const r = await startTask(input(), cfg, () => {}, deps(cfg));
    expect(r.task.status).toBe('waiting');
    expect(r.runs).toHaveLength(1);
    expect(r.waiting?.reason).toMatch(/ліміт передач/);
  });
});

describe('scenario 2: both agents exhausted, the task waits for the reset', () => {
  it('queues before any run when both are already exhausted (earliest reset wins)', async () => {
    const t1 = in1h();
    const t2 = in2h();
    setExhausted('claude', { until: t2, reason: '5-год ліміт', since: new Date().toISOString() });
    setExhausted('agy', { until: t1, reason: '5-год ліміт', since: new Date().toISOString() });
    const cfg = cfgFor({ claude: 'success', agy: 'success' });
    const r = await startTask(input(), cfg, () => {}, deps(cfg));

    expect(r.task.status).toBe('waiting');
    expect(r.task.waitUntil).toBe(t1);
    expect(r.runs).toEqual([]);
    expect(prompts()).toEqual([]); // no agent was started
    expect(git('branch', '--list', 'sb/*')).toBe(''); // nothing created in the project
    expect(git('status', '--porcelain')).toBe('');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('чекає');
  });

  it('both hit their limits during the task: checkpoint, wait until the earliest reset, then resume', async () => {
    const claudeReset = in2h();
    const agyReset = in1h();
    chmodSync(FAKE, 0o755);
    // each agent gets its own reset time: claude comes back in 2h, agy in 1h
    const claudeLimit = launcher('claude-limit', { FAKE_PROMPT_DUMP: dump, FAKE_AGENT_STYLE: 'claude', FAKE_AGENT_MODE: 'limit', FAKE_RESET_AT: claudeReset });
    const agyLimit = launcher('agy-limit', { FAKE_PROMPT_DUMP: dump, FAKE_AGENT_STYLE: 'agy', FAKE_AGENT_MODE: 'limit', FAKE_RESET_AT: agyReset, FAKE_AGY_SETTINGS: agySettings });
    const cfg2 = parseConfig(`
agents:
  claude: { cmd: "${claudeLimit}", headlessArgs: ["-p", "--output-format", "json"] }
  agy: { cmd: "${agyLimit}", settingsPath: "${agySettings}" }
routing: { section: [claude, agy] }
permissions: { claude: { allow: [Read] }, agy: { allow: ["write_file({project}/)"] } }
`);
    const r = await startTask(input(), cfg2, () => {}, deps(cfg2));

    expect(r.task.status).toBe('waiting');
    expect(r.runs.map((x) => x.agent)).toEqual(['claude', 'agy']);
    expect(r.task.waitUntil).toBe(new Date(agyReset).toISOString()); // agy comes back first
    expect(r.handoffs.map((h) => `${h.from}→${h.to ?? '-'}`)).toEqual(['claude→agy', 'agy→-']);
    expect(notes).toHaveLength(1);
    const progress = git('show', `${r.task.branch}:PROGRESS.md`);
    expect(progress).toContain(`## Handoff ${r.task.id}: claude → agy`);
    expect(progress).toContain(`## Handoff ${r.task.id}: agy →`);
    expect(git('status', '--porcelain')).toBe('');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    // later: the limits reset, the task continues from the checkpoint with a continuation prompt
    clearExhausted('claude');
    clearExhausted('agy');
    const okCfg = cfgFor({ claude: 'success', agy: 'success' });
    const resumed = await resumeTask(r.task.id, okCfg, () => {}, deps(okCfg));
    expect(resumed.task.status).toBe('done');
    expect(resumed.runs.map((x) => x.agent)).toEqual(['claude']);
    expect(prompts().at(-1)).toContain('You are continuing a task started by another AI agent');
    expect(git('log', '--format=%s', `main..${r.task.branch}`).split('\n')[0]).toMatch(/^feat\(sb\):/);
    expect(readState().tasks[r.task.id]?.waitUntil).toBeUndefined();
  });
});

describe('scenario 3: the words "quota" / "rate limit" in the task text', () => {
  const text = 'Document the API quota and rate limit handling in the footer';

  it('a successful run that echoes them does not trigger a handover', async () => {
    const cfg = cfgFor({ claude: 'success', agy: 'success' });
    const r = await startTask(input({ text }), cfg, () => {}, deps(cfg));
    expect(r.task.status).toBe('done');
    expect(r.runs).toHaveLength(1);
    expect(r.handoffs).toEqual([]);
    expect(readState().exhausted.claude).toBeUndefined();
    expect(r.outcome?.summary).toContain('quota'); // the echo really is in the output
  });

  it('a run that fails for another reason and echoes them is a plain failure, not a handover', async () => {
    const cfg = cfgFor({ claude: 'echo-fail', agy: 'success' });
    const r = await startTask(input({ text }), cfg, () => {}, deps(cfg));
    expect(r.task.status).toBe('failed');
    expect(r.runs.map((x) => x.agent)).toEqual(['claude']);
    expect(r.handoffs).toEqual([]);
    expect(readState().exhausted.claude).toBeUndefined();
    expect(prompts()).toHaveLength(1); // agy was never started
  });
});

describe('detection through a fresh usage snapshot', () => {
  it('treats a failed run as a limit hit when usage shows 100%, using the snapshot reset time', async () => {
    const reset = in2h();
    const cfg = cfgFor({ claude: 'echo-fail', agy: 'success' });
    const snap = { agent: 'claude' as AgentId, source: 'cli' as const, capturedAt: new Date().toISOString(), fiveHour: { usedPct: 100, resetsAt: reset } };
    const r = await startTask(input(), cfg, () => {}, deps(cfg, { readUsage: async (a) => (a === 'claude' ? snap : undefined) }));
    expect(r.handoffs[0]).toMatchObject({ from: 'claude', to: 'agy' });
    expect(readState().exhausted.claude?.until).toBe(reset);
    expect(r.task.status).toBe('done');
  });
});

describe('review tasks use the other agent', () => {
  it('routes a review of an agy-written task to claude', async () => {
    const cfg = cfgFor({ claude: 'success', agy: 'success' });
    const code = await startTask(input({ agent: 'agy' }), cfg, () => {}, deps(cfg));
    expect(code.task.agent).toBe('agy');
    const review = await startTask(input({ type: 'review', text: 'Review the footer for accessibility', reviews: code.task.id }), cfg, () => {}, deps(cfg));
    expect(review.runs[0]!.agent).toBe('claude'); // the matrix prefers agy for review, but agy was the author
  });

  it('rejects --reviews with an unknown task id', async () => {
    const cfg = cfgFor({});
    await expect(startTask(input({ type: 'review', reviews: 't-nope' }), cfg, () => {}, deps(cfg))).rejects.toThrow(/не існує/);
  });
});

describe('writeCheckpoint', () => {
  const makeTask = (): Task => ({
    id: 't-ck', text: 'x', type: 'section', project, priority: 'normal', status: 'running', branch: 'sb/t-ck',
    baseBranch: 'main', baseSha: git('rev-parse', 'HEAD'), runs: [], createdAt: '', updatedAt: '',
  });

  it('writes a Handoff section when the agent left PROGRESS.md alone, masking secrets', async () => {
    writeFileSync(join(project, 'a.txt'), 'work');
    const tail = outputTail('', '', { ok: false, denied: [], summary: 'stopped; key sk-abcdefgh12345678' });
    const r = await writeCheckpoint({ project, task: makeTask(), from: 'claude', to: 'agy', reason: '5-год ліміт', tail });
    expect(r.noteAdded).toBe(true);
    const md = readFileSync(join(project, 'PROGRESS.md'), 'utf8');
    expect(md).toContain('## Handoff t-ck: claude → agy');
    expect(md).toContain('a.txt');
    expect(md).not.toContain('sk-abcdefgh12345678');
    expect(git('log', '-1', '--format=%s')).toBe('wip(sb): checkpoint t-ck from claude');
  });

  it("leaves the agent's own PROGRESS.md untouched when it updated it during the run", async () => {
    const own = '## Task t-ck: Footer\n- Status: in-progress\n';
    writeFileSync(join(project, 'PROGRESS.md'), own);
    writeFileSync(join(project, 'a.txt'), 'work');
    const r = await writeCheckpoint({ project, task: makeTask(), from: 'claude', reason: 'ліміт', tail: '' });
    expect(r.noteAdded).toBe(false);
    expect(readFileSync(join(project, 'PROGRESS.md'), 'utf8')).toBe(own);
  });

  it('still commits a note when the agent produced nothing at all', async () => {
    const r = await writeCheckpoint({ project, task: makeTask(), from: 'agy', reason: 'ліміт', tail: '' });
    expect(r.sha).toBeDefined();
    expect(readFileSync(join(project, 'PROGRESS.md'), 'utf8')).toContain('(no file changes yet)');
  });
});

describe('attachments and clarifications travel with the task', () => {
  it('attachments are listed in the prompt and in the task file; the working tree stays clean', async () => {
    const cfg = cfgFor({ claude: 'success', agy: 'success' });
    const batch = await saveAttachments(project, [{ name: 'layout.png', data: await (await import('sharp')).default({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer() }, { name: 'brief.txt', data: Buffer.from('Kindertanz page') }]);
    const r = await startTask(input({ attachmentsDir: batch.dir }), cfg, () => {}, deps(cfg));
    expect(r.task.status).toBe('done');
    expect(r.task.attachments?.map((a) => a.name)).toEqual(['layout.png', 'brief.txt']);
    const [first] = prompts();
    expect(first).toContain('ATTACHMENTS from the user');
    expect(first).toContain(batch.items[0]!.path);
    expect(git('show', `${r.task.branch}:.sb/tasks/${r.task.id}.md`)).toContain('## Attachments');
    expect(git('status', '--porcelain')).toBe('');
    // the uploaded files themselves are never committed
    expect(git('ls-tree', '-r', '--name-only', r.task.branch)).not.toContain('.sb/attachments');
  });

  it('rejects an attachment folder outside .sb/attachments', async () => {
    const cfg = cfgFor({});
    await expect(startTask(input({ attachmentsDir: '../..' }), cfg, () => {}, deps(cfg))).rejects.toThrow(/Вкладення/);
  });

  it("resume with a clarification puts the user's answer into the continuation prompt and the task file", async () => {
    const cfg = cfgFor({ claude: 'limit', agy: 'success', reset: in2h(), extra: 'handoff: { maxHandoffs: 0 }' });
    const waiting = await startTask(input(), cfg, () => {}, deps(cfg));
    expect(waiting.task.status).toBe('waiting');
    clearExhausted('claude');
    const okCfg = cfgFor({ claude: 'success', agy: 'success' });
    const done = await resumeTask(waiting.task.id, okCfg, () => {}, deps(okCfg), { clarification: 'Use three columns and the accent color from DESIGN.md' });
    expect(done.task.status).toBe('done');
    const last = prompts().at(-1)!;
    expect(last).toContain('You are continuing a task started by another AI agent');
    expect(last).toContain('The user answered your open questions');
    expect(last).toContain('Use three columns');
    expect(git('show', `${done.task.branch}:.sb/tasks/${done.task.id}.md`)).toContain('## Clarifications from the user');
    expect(readState().tasks[done.task.id]?.clarifications).toHaveLength(1);
  });
});
