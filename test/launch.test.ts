import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/core/config';
import { getChatOverview, selectChat } from '../packages/core/chat-overview';
import { isSbProcess, launchTask, newChatFromDashboard, resumeFromDashboard, retryChat, sendChatMessage, setChatModeFromDashboard, stopChat, stopTask, validateLaunch } from '../packages/core/launch';
import { renderMarkdown } from '../packages/core/markdown';
import { addProject, readState, saveRun, saveTask } from '../packages/core/store';
import { allowedProjects, getTasksOverview, matchAllowedProject, tailFile } from '../packages/core/task-overview';
import type { Task } from '../packages/core/types';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
let dir: string;
let project: string;

function makeRepo(name = 'site'): string {
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

/** Fake agent launcher that answers the usage commands harmlessly and runs the fake agent otherwise. */
function launcher(name: string, env: Record<string, string>): string {
  const path = join(dir, name);
  const exports = Object.entries(env).map(([k, v]) => `${k}='${v}'`).join(' ');
  writeFileSync(path, `#!/bin/sh\nif [ "$2" = "/usage" ] || [ "$2" = "/quota" ] || [ "$1" = "auth" ] || [ "$1" = "models" ]; then echo "n/a"; exit 0; fi\nexec env ${exports} "${FAKE}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function writeConfig(claudeMode: string, extra = ''): string {
  chmodSync(FAKE, 0o755);
  const claude = launcher('claude-fake', { FAKE_AGENT_STYLE: 'claude', FAKE_AGENT_MODE: claudeMode });
  const agy = launcher('agy-fake', { FAKE_AGENT_STYLE: 'agy', FAKE_AGENT_MODE: 'success' });
  const file = join(dir, 'switchboard.config.yaml');
  writeFileSync(file, `
agents:
  claude: { cmd: "${claude}", headlessArgs: ["-p", "--output-format", "json"] }
  agy: { cmd: "${agy}", settingsPath: "${join(dir, 'agy-settings.json')}" }
routing: { section: [claude, agy], review: [agy, claude], research: [agy, claude] }
permissions: { claude: { allow: [Read, Write] }, agy: { allow: [] } }
notifications: { enabled: false }
dashboard: { projects: ["${project}"] }
${extra}
`);
  return file;
}

const waitFor = async (cond: () => boolean, ms = 30_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 150));
  }
};

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var) and the code under test resolves project paths
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sb-launch-')));
  process.env.SB_HOME = join(dir, 'home');
  project = makeRepo();
  writeFileSync(join(dir, 'agy-settings.json'), '{}\n');
});
afterEach(() => {
  delete process.env.SB_HOME;
  delete process.env.SB_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

describe('validateLaunch', () => {
  const cfg = () => parseConfig(`
agents: { claude: { cmd: c }, agy: { cmd: a } }
routing: { section: [claude, agy], research: [agy, claude] }
dashboard: { projects: ["${project}"] }
`);
  const ok = { text: 'Make a footer', type: 'section', project: '' };

  it('builds a fixed argv with the text after "--"', () => {
    const v = validateLaunch(cfg(), { ...ok, project, priority: 'high', figma: 'https://www.figma.com/design/abc?node-id=1' });
    expect('error' in v).toBe(false);
    if ('error' in v) return;
    expect(v.args).toEqual(['run', '--project', project, '--type', 'section', '--priority', 'high', '--figma', 'https://www.figma.com/design/abc?node-id=1', '--', 'Make a footer']);
  });

  it('text that looks like options stays a plain positional (cannot inject --project)', () => {
    const v = validateLaunch(cfg(), { ...ok, project, text: '--project /etc --agent agy do it' });
    if ('error' in v) throw new Error(v.error);
    const parsed = parseArgs({
      args: v.args.slice(1),
      allowPositionals: true,
      options: { project: { type: 'string' }, type: { type: 'string' }, priority: { type: 'string' }, figma: { type: 'string' }, agent: { type: 'string' } },
    });
    expect(parsed.values.project).toBe(project);
    expect(parsed.values.agent).toBeUndefined();
    expect(parsed.positionals).toEqual(['--project /etc --agent agy do it']);
  });

  it('rejects projects that are not on the allowed list, also through .. and symlinks', () => {
    const other = makeRepo('other');
    expect(validateLaunch(cfg(), { ...ok, project: other })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...ok, project: '/etc' })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...ok, project: join(project, '..', 'other') })).toHaveProperty('error');
    symlinkSync(other, join(dir, 'link-to-other'));
    expect(validateLaunch(cfg(), { ...ok, project: join(dir, 'link-to-other') })).toHaveProperty('error');
    // a symlink that points INTO an allowed project is the allowed project
    symlinkSync(project, join(dir, 'link-to-site'));
    expect(validateLaunch(cfg(), { ...ok, project: join(dir, 'link-to-site') })).not.toHaveProperty('error');
  });

  it('validates text, type, priority and the Figma link', () => {
    const base = { ...ok, project };
    expect(validateLaunch(cfg(), { ...base, text: '   ' })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...base, text: 'x'.repeat(5001) })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...base, type: 'nope' })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...base, priority: 'urgent' })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...base, figma: 'http://www.figma.com/x' })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...base, figma: 'https://evil.example/figma.com' })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...base, figma: 'https://notfigma.com/x' })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...base, figma: 'not a url' })).toHaveProperty('error');
    expect(validateLaunch(cfg(), { ...base, figma: 'https://figma.com/design/x' })).not.toHaveProperty('error');
  });
});

describe('allowed projects', () => {
  it('merges config, remembered projects and past tasks without duplicates', () => {
    const cfg = parseConfig(`agents: { claude: { cmd: c }, agy: { cmd: a } }\ndashboard: { projects: ["${project}", "${join(dir, 'gone')}"] }`);
    const second = makeRepo('second');
    addProject(second);
    addProject(project);
    const list = allowedProjects(cfg);
    expect(list.map((p) => p.name)).toEqual(['second', 'site']); // missing folder skipped, no duplicates
    expect(matchAllowedProject(cfg, second)).toBeDefined();
    expect(matchAllowedProject(cfg, '/etc')).toBeUndefined();
  });
});

describe('launching real sb processes from the dashboard code', () => {
  it('starts a task in a separate process and it finishes on its own branch', async () => {
    process.env.SB_CONFIG = writeConfig('success');
    const cfg = parseConfig(await import('node:fs').then((f) => f.readFileSync(process.env.SB_CONFIG!, 'utf8')));
    const r = await launchTask(cfg, { text: 'Create Footer.astro from DESIGN.md', type: 'section', project });
    expect(r.ok).toBe(true);
    const id = r.ok ? r.taskId : undefined;
    expect(id).toMatch(/^t-/);
    await waitFor(() => readState().tasks[id!]?.status === 'done');
    expect(execFileSync('git', ['branch', '--list', 'sb/*'], { cwd: project, encoding: 'utf8' })).toContain(`sb/${id}`);
    // the task is marked done slightly before the process switches the project back, so wait for it
    const head = () => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
    await waitFor(() => head() === 'main');
    expect(head()).toBe('main');
  }, 60_000);

  it('reports an immediate failure (dirty working tree) instead of pretending it started', async () => {
    process.env.SB_CONFIG = writeConfig('success');
    const cfg = parseConfig(await import('node:fs').then((f) => f.readFileSync(process.env.SB_CONFIG!, 'utf8')));
    writeFileSync(join(project, 'notes.txt'), 'uncommitted');
    const r = await launchTask(cfg, { text: 'Create Footer.astro', type: 'section', project });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/не чисте/);
  }, 60_000);

  it('stop: SIGTERM to the sb process saves a checkpoint; resume then finishes the task', async () => {
    process.env.SB_CONFIG = writeConfig('hang');
    const fs = await import('node:fs');
    const cfg = parseConfig(fs.readFileSync(process.env.SB_CONFIG, 'utf8'));
    const started = await launchTask(cfg, { text: 'Create Footer.astro', type: 'section', project });
    expect(started.ok).toBe(true);
    const id = started.ok ? started.taskId! : '';
    await waitFor(() => readState().tasks[id]?.status === 'running' && !!readState().tasks[id]?.pid && existsSync(readState().runs[readState().tasks[id]!.runs[0] ?? '']?.logPath ?? ''));

    // a second task in the same project is refused while the first one is alive
    const second = await launchTask(cfg, { text: 'Another task', type: 'section', project });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(409);

    const stopped = stopTask(id);
    expect(stopped.ok).toBe(true);
    await waitFor(() => readState().tasks[id]?.status === 'failed');
    expect(readState().tasks[id]?.note).toMatch(/перервано/);
    expect(execFileSync('git', ['log', '--format=%s', `main..sb/${id}`], { cwd: project, encoding: 'utf8' })).toContain('interrupted');

    // the working tree stays on the task branch after an interrupt: put it back, then resume with a working agent
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: project });
    process.env.SB_CONFIG = writeConfig('success');
    const okCfg = parseConfig(fs.readFileSync(process.env.SB_CONFIG, 'utf8'));
    const resumed = await resumeFromDashboard(okCfg, id);
    expect(resumed.ok).toBe(true);
    await waitFor(() => readState().tasks[id]?.status === 'done');
  }, 90_000);

  it('refuses to stop or resume things that are not in the right state', async () => {
    expect(stopTask('t-nope').ok).toBe(false);
    const cfg = parseConfig(`agents: { claude: { cmd: c }, agy: { cmd: a } }\ndashboard: { projects: ["${project}"] }`);
    const r = await resumeFromDashboard(cfg, 't-nope');
    expect(r.ok).toBe(false);
  });
});

describe('isSbProcess', () => {
  it('is false for an ordinary process and true for one whose command line is the sb CLI', async () => {
    expect(isSbProcess(process.pid)).toBe(false);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', '--', 'bin/sb.ts'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(isSbProcess(child.pid!)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('getTasksOverview', () => {
  const cfg = () => parseConfig(`agents: { claude: { cmd: c }, agy: { cmd: a } }\nrouting: { section: [claude, agy], review: [agy, claude] }\nrouter: { shortTypes: [section] }\ndashboard: { projects: ["${project}"] }`);
  const task = (over: Partial<Task>): Task => ({
    id: 't-1', text: 'Make a footer\nwith details', type: 'section', project, priority: 'normal', status: 'done', branch: 'sb/t-1',
    baseBranch: 'main', baseSha: 'abc', runs: [], createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', ...over,
  });

  it('splits tasks into running, waiting and recent and shows the log tail', () => {
    mkdirSync(join(process.env.SB_HOME!, 'runs'), { recursive: true });
    const log = join(process.env.SB_HOME!, 'runs', 'r-1.log');
    writeFileSync(log, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\nkey sk-abcdefgh12345678\n');
    saveRun({ id: 'r-1', taskId: 't-run', agent: 'claude', startedAt: new Date(Date.now() - 90_000).toISOString(), status: 'running', logPath: log });
    saveTask(task({ id: 't-run', status: 'running', pid: process.pid, runs: ['r-1'], agent: 'claude', createdAt: '2026-10-01T10:05:00.000Z' }));
    saveTask(task({ id: 't-wait', status: 'waiting', waitUntil: '2026-10-02T09:00:00.000Z', note: 'немає вільного агента', createdAt: '2026-10-01T10:03:00.000Z' }));
    saveTask(task({ id: 't-done', status: 'done', agent: 'agy', createdAt: '2026-10-01T10:01:00.000Z' }));

    const o = getTasksOverview(cfg());
    expect(o.hasRunning).toBe(true);
    expect(o.running.map((t) => t.id)).toEqual(['t-run']);
    expect(o.running[0]!.logTail).toHaveLength(20);
    expect(o.running[0]!.logTail.at(-1)).toContain('<token>'); // masked
    expect(o.running[0]!.canStop).toBe(true);
    expect(o.running[0]!.agentTitle).toBe('Claude Code');
    expect(o.waiting.map((t) => t.id)).toEqual(['t-wait']);
    expect(o.waiting[0]!.canResume).toBe(true);
    expect(o.recent.map((t) => t.id)).toEqual(['t-done']);
    expect(o.recent[0]!.title).toBe('Make a footer'); // first line only
    expect(o.types).toEqual([{ id: 'section', short: true }, { id: 'review', short: false }]);
    expect(o.projects.map((p) => p.name)).toEqual(['site']);
  });

  it('formats the handover history as "Агент → Агент о ЧЧ:ХХ, причина: …", newest first', () => {
    saveTask(task({ id: 't-a', handoffs: [{ from: 'claude', to: 'agy', at: '2026-10-01T12:32:00.000Z', reason: '5-год ліміт' }], createdAt: '2026-10-01T12:00:00.000Z' }));
    saveTask(task({ id: 't-b', handoffs: [{ from: 'agy', at: '2026-10-01T13:10:00.000Z', reason: 'тижневий ліміт' }], createdAt: '2026-10-01T13:00:00.000Z' }));
    const h = getTasksOverview(cfg()).handoffs;
    expect(h).toHaveLength(2);
    expect(h[0]!.text).toMatch(/^Antigravity → нікому \(пауза\) о \d{2}:\d{2}, причина: тижневий ліміт$/);
    expect(h[1]!.text).toMatch(/^Claude Code → Antigravity о \d{2}:\d{2}, причина: 5-год ліміт$/);
  });

  it('marks a "running" task whose sb process died as failed', () => {
    saveTask(task({ id: 't-ghost', status: 'running', pid: 2_000_000_000 }));
    const o = getTasksOverview(cfg());
    expect(o.running).toEqual([]);
    expect(o.recent[0]).toMatchObject({ id: 't-ghost', status: 'failed' });
    expect(readState().tasks['t-ghost']?.pid).toBeUndefined();
  });
});

describe('tailFile', () => {
  it('reads only the end of a large file and survives a missing one', () => {
    const f = join(dir, 'big.log');
    writeFileSync(f, Array.from({ length: 20000 }, (_, i) => `row ${i}`).join('\n'));
    const t = tailFile(f, 3);
    expect(t).toEqual(['row 19997', 'row 19998', 'row 19999']);
    expect(tailFile(join(dir, 'missing.log'))).toEqual([]);
  });
});

describe('chat from the dashboard code', () => {
  const load = async () => parseConfig((await import('node:fs')).readFileSync(process.env.SB_CONFIG!, 'utf8'));

  it('creates a chat, sends a message with a file, shows the reply and switches the agent', async () => {
    process.env.SB_CONFIG = writeConfig('chat');
    const cfg = await load();
    const created = await newChatFromDashboard(cfg, project, 'auto');
    expect(created.ok).toBe(true);
    const chatId = (created as { chatId?: string }).chatId!;

    const sent = await sendChatMessage(cfg, chatId, 'Зроби **футер**', [{ name: 'brief.txt', data: Buffer.from('color #123456') }]);
    expect(sent.ok).toBe(true);
    await waitFor(() => (readState().chats[chatId]?.messages.filter((m) => m.role === 'agent').length ?? 0) === 1);
    const overview = getChatOverview(project)!;
    expect(overview.active!.id).toBe(chatId);
    expect(overview.active!.status).toBe('idle');
    const reply = overview.active!.messages.find((m) => m.role === 'agent')!;
    expect(reply.html).toContain('<p>');
    expect(reply.files).toEqual(['chat/claude.txt']);
    expect(overview.active!.messages[0]!.attachments).toEqual([{ name: 'brief.txt', kind: 'text' }]);

    expect(setChatModeFromDashboard(chatId, 'agy').ok).toBe(true);
    expect(setChatModeFromDashboard(chatId, 'gpt').ok).toBe(false);
    const second = await sendChatMessage(cfg, chatId, 'продовж');
    expect(second.ok).toBe(true);
    await waitFor(() => (readState().chats[chatId]?.messages.filter((m) => m.role === 'agent').length ?? 0) === 2);
    expect(readState().chats[chatId]!.messages.filter((m) => m.role === 'agent')[1]!.agent).toBe('agy');

    // a second chat can be selected and the list holds both
    const other = await newChatFromDashboard(cfg, project, 'claude');
    expect(selectChat(chatId)).toBe(true);
    expect(getChatOverview(project)!.chats).toHaveLength(2);
    expect(getChatOverview(project)!.active!.id).toBe(chatId);
    expect(other.ok).toBe(true);
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim()).toBe('main');
  }, 90_000);

  it('refuses a project that is not allowed, a missing chat and a stop without a running turn', async () => {
    process.env.SB_CONFIG = writeConfig('chat');
    const cfg = await load();
    expect((await newChatFromDashboard(cfg, '/etc', 'auto')).ok).toBe(false);
    expect((await sendChatMessage(cfg, 'c-nope', 'x')).ok).toBe(false);
    expect(stopChat('c-nope').ok).toBe(false);
    const created = await newChatFromDashboard(cfg, project, 'auto');
    const chatId = (created as { chatId?: string }).chatId!;
    expect(stopChat(chatId).ok).toBe(false);
    expect((await retryChat(cfg, chatId)).ok).toBe(false); // nothing pending
  });

  it('stop: SIGTERM keeps the edits and frees the chat', async () => {
    process.env.SB_CONFIG = writeConfig('hang');
    const cfg = await load();
    const chatId = ((await newChatFromDashboard(cfg, project, 'claude')) as { chatId?: string }).chatId!;
    expect((await sendChatMessage(cfg, chatId, 'щось довге')).ok).toBe(true);
    await waitFor(() => readState().chats[chatId]?.status === 'running' && !!readState().chats[chatId]?.pid);
    expect((await sendChatMessage(cfg, chatId, 'ще')).ok).toBe(false); // busy
    expect(getChatOverview(project)!.active!.canStop).toBe(true);
    expect(stopChat(chatId).ok).toBe(true);
    await waitFor(() => readState().chats[chatId]?.status === 'idle');
    const messages = readState().chats[chatId]!.messages;
    expect(messages[0]!.status).toBe('failed');
    expect(messages.at(-1)!.text).toMatch(/Зупинено/);
  }, 60_000);

  it('frees a chat whose process died', async () => {
    const cfg = parseConfig(`agents: { claude: { cmd: c }, agy: { cmd: a } }\ndashboard: { projects: ["${project}"] }`);
    const created = await newChatFromDashboard(cfg, project, 'auto');
    const chatId = (created as { chatId?: string }).chatId!;
    const { updateChat } = await import('../packages/core/store');
    updateChat(chatId, (c) => { c.status = 'running'; c.pid = 2_000_000_000; c.messages.push({ id: 'm1', role: 'user', text: 'x', at: new Date().toISOString(), status: 'running' }); });
    const o = getChatOverview(project)!;
    expect(o.active!.status).toBe('idle');
    expect(o.active!.messages.at(-1)!.text).toMatch(/Процес відповіді зник/);
  });
});

describe('task launch with files and a clarification', () => {
  it('passes uploaded files to the task and a note on resume', async () => {
    process.env.SB_CONFIG = writeConfig('success');
    const fs = await import('node:fs');
    const cfg = parseConfig(fs.readFileSync(process.env.SB_CONFIG, 'utf8'));
    const r = await launchTask(cfg, { text: 'Create Footer.astro', type: 'section', project }, [{ name: 'brief.txt', data: Buffer.from('x') }, { name: 'virus.exe', data: Buffer.from('x') }]);
    expect(r.ok).toBe(true);
    const id = r.ok ? r.taskId! : '';
    await waitFor(() => readState().tasks[id]?.status === 'done');
    expect(readState().tasks[id]!.attachments?.map((a) => a.name)).toEqual(['brief.txt']);
    expect(r.ok && r.message).toMatch(/Не прийнято: virus\.exe/);

    const onlyBad = await launchTask(cfg, { text: 'Another', type: 'section', project }, [{ name: 'virus.exe', data: Buffer.from('x') }]);
    expect(onlyBad.ok).toBe(false);
  }, 60_000);
});

describe('markdown rendering', () => {
  it('escapes raw HTML first and renders only a small safe subset', () => {
    const html = renderMarkdown('# Title\n<script>alert(1)</script> **bold** and `code <b>`\n- one\n- two\n[link](https://example.com) [bad](javascript:alert(1))\n```\n<img src=x onerror=alert(1)>\n```');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code &lt;b&gt;</code>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<pre>');
  });
});
