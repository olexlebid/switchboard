// Chat scenarios on the fake agent: session continuity, agent switch with transcript, failover, safety.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveAttachments } from '../packages/core/attachments';
import { addUserMessage, chatOrder, createChat, runChatTurn, setChatMode, transcript, type ChatDeps } from '../packages/core/chat';
import { parseConfig } from '../packages/core/config';
import { buildOverview } from '../packages/core/overview';
import { readState, updateState } from '../packages/core/store';

const FAKE = join(import.meta.dirname, 'fake-agent.mjs');
let dir: string;
let project: string;
let dump: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
const inHours = (h: number) => new Date(Math.floor((Date.now() + h * 3600_000) / 1000) * 1000).toISOString();

function makeRepo(): string {
  const p = join(dir, 'site');
  mkdirSync(p, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: p });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: p });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: p });
  writeFileSync(join(p, 'README.md'), '# site\n');
  writeFileSync(join(p, 'CLAUDE.md'), '# rules\n');
  execFileSync('git', ['add', '-A'], { cwd: p });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: p });
  return p;
}

function launcher(name: string, env: Record<string, string>): string {
  const path = join(dir, name);
  const exports = Object.entries(env).map(([k, v]) => `${k}='${v}'`).join(' ');
  writeFileSync(path, `#!/bin/sh\nexec env ${exports} "${FAKE}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function cfgFor(claude = 'chat', agy = 'chat') {
  chmodSync(FAKE, 0o755);
  const common = { FAKE_PROMPT_DUMP: dump, FAKE_RESET_AT: inHours(2) };
  const c = launcher('claude-fake', { ...common, FAKE_AGENT_STYLE: 'claude', FAKE_AGENT_MODE: claude });
  const a = launcher('agy-fake', { ...common, FAKE_AGENT_STYLE: 'agy', FAKE_AGENT_MODE: agy });
  return parseConfig(`
agents:
  claude: { cmd: "${c}", headlessArgs: ["-p", "--output-format", "json"] }
  agy: { cmd: "${a}", settingsPath: "${join(dir, 'agy-settings.json')}" }
routing: { section: [claude, agy] }
permissions: { claude: { allow: [Read, Write] }, agy: { allow: [] } }
notifications: { enabled: false }
`);
}

const deps = (cfg: ReturnType<typeof parseConfig>): ChatDeps => ({
  overview: async () => buildOverview(cfg).agents,
  readUsage: async () => undefined,
  notify: async () => true,
});

async function turn(cfg: ReturnType<typeof parseConfig>, chatId: string, text: string, attachmentsDir?: string) {
  addUserMessage(chatId, { text, attachmentsDir });
  return runChatTurn(chatId, cfg, () => {}, deps(cfg));
}

const replies = (id: string) => readState().chats[id]!.messages.filter((m) => m.role === 'agent').map((m) => m.text);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-chat-'));
  process.env.SB_HOME = join(dir, 'home');
  project = makeRepo();
  dump = join(dir, 'prompts.txt');
  writeFileSync(join(dir, 'agy-settings.json'), '{}\n');
});
afterEach(() => {
  delete process.env.SB_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe('chat turns', () => {
  it('edits on its own branch, commits per turn and returns the project to its branch', async () => {
    const cfg = cfgFor();
    const chat = await createChat({ project });
    expect(chat.branch).toBe(`sb/${chat.id}`);
    const r = await turn(cfg, chat.id, 'Зроби футер');
    expect(r.ok).toBe(true);
    expect(r.agent).toBe('claude');
    expect(r.files).toEqual(['chat/claude.txt']);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git('log', '--oneline', chat.branch)).toMatch(/chat\(sb\): Зроби футер/);
    const after = readState().chats[chat.id]!;
    expect(after.status).toBe('idle');
    expect(after.turns).toBe(1);
    expect(after.messages.map((m) => `${m.role}:${m.status ?? ''}`)).toEqual(['user:done', 'agent:']);
    expect(after.title).toBe('Зроби футер');
    expect(replies(chat.id)[0]).toContain('echo(claude): ');
    expect(replies(chat.id)[0]).toContain('[new, no-transcript]');
  });

  it('continues the same agent session on the next message', async () => {
    const cfg = cfgFor();
    const chat = await createChat({ project });
    await turn(cfg, chat.id, 'перше');
    const sid = readState().chats[chat.id]!.sessions.claude;
    expect(sid).toBeTruthy();
    await turn(cfg, chat.id, 'друге');
    expect(replies(chat.id)[1]).toContain('[resumed, no-transcript]');
    expect(readState().chats[chat.id]!.sessions.claude).toBe(sid);
    // the resumed prompt is just the message: no rules block again
    const prompts = readFileSync(dump, 'utf8').split('=== ').filter(Boolean);
    expect(prompts[1]).not.toContain('Hard rules');
  });

  it('gives a newly selected agent a transcript, then keeps its own session', async () => {
    const cfg = cfgFor();
    const chat = await createChat({ project });
    await turn(cfg, chat.id, 'почни тут');
    setChatMode(chat.id, 'agy');
    const r = await turn(cfg, chat.id, 'продовж');
    expect(r.agent).toBe('agy');
    expect(replies(chat.id)[1]).toContain('[new, transcript]');
    expect(readFileSync(dump, 'utf8')).toContain('USER: почни тут');
    await turn(cfg, chat.id, 'ще');
    expect(replies(chat.id)[2]).toContain('echo(agy)');
    expect(replies(chat.id)[2]).toContain('[resumed, no-transcript]');
    const s = readState().chats[chat.id]!.sessions;
    expect(s.claude && s.agy).toBeTruthy();
  });

  it('auto mode: a usage limit hands the conversation to the other agent', async () => {
    const cfg = cfgFor('limit', 'chat');
    const chat = await createChat({ project });
    const r = await turn(cfg, chat.id, 'зроби щось');
    expect(r.ok).toBe(true);
    expect(r.agent).toBe('agy');
    const state = readState();
    expect(state.exhausted.claude).toBeTruthy();
    expect(state.chats[chat.id]!.messages.some((m) => m.role === 'system' && /Передаю/.test(m.text))).toBe(true);
    expect(replies(chat.id)[0]).toContain('echo(agy)');
    expect(state.chats[chat.id]!.lastAgent).toBe('agy');
    // the half-done work of the first agent is committed together with the second one's
    expect(git('show', '--stat', '--format=', chat.branch)).toMatch(/Footer\.astro/);
  });

  it('a fixed agent does not fail over', async () => {
    const cfg = cfgFor('limit', 'chat');
    const chat = await createChat({ project, mode: 'claude' });
    const r = await turn(cfg, chat.id, 'привіт');
    expect(r.ok).toBe(false);
    expect(r.agent).toBe('claude');
    const msgs = readState().chats[chat.id]!.messages;
    expect(msgs.at(-1)!.role).toBe('system');
    expect(msgs.find((m) => m.role === 'user')!.status).toBe('failed');
  });

  it('waits when no agent is available and keeps the message pending', async () => {
    const cfg = cfgFor();
    const until = inHours(3);
    updateState((s) => {
      s.exhausted.claude = { until, reason: 'test', since: new Date().toISOString() };
      s.exhausted.agy = { until, reason: 'test', since: new Date().toISOString() };
    });
    const chat = await createChat({ project });
    const r = await turn(cfg, chat.id, 'привіт');
    expect(r.waiting?.until).toBe(until);
    const after = readState().chats[chat.id]!;
    expect(after.status).toBe('waiting');
    expect(after.messages[0]!.status).toBe('pending');
    // after the reset the same pending message is processed
    updateState((s) => { s.exhausted = {}; });
    const again = await runChatTurn(chat.id, cfg, () => {}, deps(cfg));
    expect(again.ok).toBe(true);
    expect(readState().chats[chat.id]!.status).toBe('idle');
  });

  it('refuses to start on a dirty working tree and keeps the user changes untouched', async () => {
    const cfg = cfgFor();
    const chat = await createChat({ project });
    writeFileSync(join(project, 'mine.txt'), 'my work');
    addUserMessage(chat.id, { text: 'привіт' });
    await expect(runChatTurn(chat.id, cfg, () => {}, deps(cfg))).rejects.toThrow(/не чисте/);
    expect(readFileSync(join(project, 'mine.txt'), 'utf8')).toBe('my work');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readState().chats[chat.id]!.status).toBe('idle');
  });

  it('passes attachments to the agent', async () => {
    const cfg = cfgFor();
    const chat = await createChat({ project });
    const saved = await saveAttachments(project, [{ name: 'brief.txt', data: Buffer.from('Primary color: #123456') }]);
    await turn(cfg, chat.id, 'дивись вкладення', saved.dir);
    expect(readFileSync(dump, 'utf8')).toContain('brief.txt');
    // attachments never end up in git
    expect(git('status', '--porcelain')).toBe('');
  });

  it('validates input and ordering', async () => {
    const cfg = cfgFor();
    const chat = await createChat({ project });
    expect(() => addUserMessage(chat.id, { text: '   ' })).toThrow(/Порожнє/);
    expect(() => addUserMessage(chat.id, { text: 'x'.repeat(9000) })).toThrow(/задовге/);
    expect(() => addUserMessage('c-nope', { text: 'x' })).toThrow(/не існує/);
    await expect(runChatTurn(chat.id, cfg)).rejects.toThrow(/немає повідомлення/);
    expect(chatOrder(cfg, { ...chat, lastAgent: 'agy' })).toEqual(['agy', 'claude']);
    expect(transcript({ ...chat, messages: [] }, 'x')).toBe('');
  });
});
