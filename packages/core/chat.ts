// Chat: a persistent conversation with an agent that may edit project files.
// Every chat has its own branch sb/c-<id>; each turn is committed there (never merged, never deployed).
// Each agent keeps its own session (claude --resume / agy --conversation). When the agent changes
// (manual switch or failover on a usage limit) the new one gets a transcript of the conversation instead.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachmentsPrompt, loadBatch } from './attachments';
import { runAgentOnce } from './agent-run';
import { onExit } from './cleanup';
import { SbError } from './errors';
import { changedFiles, checkoutBranch, commitAll, currentBranch, dirtyFiles, headSha, isGitRepo, pushBranch, switchBack } from './git';
import type { Outcome } from './interpret';
import { detectLimit } from './limit-detect';
import { collectUsage } from './limits';
import { maskSecrets } from './mask';
import { notify as defaultNotify, type Notify } from './notify';
import { getOverview, type AgentOverview } from './overview';
import { protectedTouched } from './protected';
import { routeTask } from './router';
import { addProject, readState, saveChat, saveRun, setExhausted, updateChat } from './store';
import type { AgentId, Chat, ChatMessage, Run, SwitchboardConfig, UsageSnapshot } from './types';

export type ChatDeps = {
  overview?: () => Promise<AgentOverview[]>;
  readUsage?: (agent: AgentId) => Promise<UsageSnapshot | undefined>;
  notify?: Notify;
  now?: () => Date;
};

const MAX_TEXT = 8000;
const TRANSCRIPT_MESSAGES = 12;
const TRANSCRIPT_CHARS = 1500;
/** Files that tell an agent how the project works, in reading order. */
const RULE_FILES = ['CLAUDE.md', 'RULES.md', 'DESIGN.md', 'AGENTS.md'];

const newId = (prefix: string, now = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${Math.random().toString(36).slice(2, 5)}`;
};

const oneLine = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function expandHome(p: string): string {
  return resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
}

/** Creates an empty chat for a project. The branch is created lazily by the first turn. */
export async function createChat(
  input: { project: string; mode?: 'auto' | AgentId; title?: string },
  now = new Date(),
): Promise<Chat> {
  const project = expandHome(input.project);
  if (!existsSync(project) || !statSync(project).isDirectory()) throw new SbError(`Папки проєкту не існує: ${project}`, 2);
  if (!(await isGitRepo(project))) throw new SbError(`${project} не є git-репозиторієм.`, 2);
  const id = newId('c', now);
  const chat: Chat = {
    id,
    project,
    title: oneLine(input.title ?? 'Новий чат', 60),
    branch: `sb/${id}`,
    baseBranch: await currentBranch(project),
    baseSha: await headSha(project),
    mode: input.mode ?? 'auto',
    sessions: {},
    messages: [],
    status: 'idle',
    turns: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  saveChat(chat);
  addProject(project);
  return chat;
}

/** Appends a user message (status pending). A turn is started separately (`sb chat-turn`). */
export function addUserMessage(
  chatId: string,
  input: { text: string; attachmentsDir?: string },
  now = new Date(),
): ChatMessage {
  const chat = readState().chats[chatId];
  if (!chat) throw new SbError('Чату не існує.', 2);
  const text = input.text.replace(/\r\n/g, '\n').trim();
  if (!text && !input.attachmentsDir) throw new SbError('Порожнє повідомлення.', 2);
  if (text.length > MAX_TEXT) throw new SbError(`Повідомлення задовге (максимум ${MAX_TEXT} символів).`, 2);
  if (chat.status === 'running') throw new SbError('Агент ще відповідає на попереднє повідомлення.', 2);
  let attachments: ChatMessage['attachments'];
  if (input.attachmentsDir) {
    try {
      attachments = loadBatch(chat.project, input.attachmentsDir).items;
    } catch (e) {
      throw new SbError(`Вкладення: ${(e as Error).message}`, 2);
    }
  }
  const message: ChatMessage = { id: newId('m', now), role: 'user', text: text || '(лише вкладення)', at: now.toISOString(), attachments, status: 'pending' };
  updateChat(chatId, (c) => {
    c.messages.push(message);
    if (c.turns === 0 && c.title === 'Новий чат') c.title = oneLine(message.text, 60);
  });
  return message;
}

export function setChatMode(chatId: string, mode: 'auto' | AgentId): void {
  if (mode !== 'auto' && mode !== 'claude' && mode !== 'agy') throw new SbError('Невідомий режим чату.', 2);
  if (!updateChat(chatId, (c) => { c.mode = mode; })) throw new SbError('Чату не існує.', 2);
}

// ---------------------------------------------------------------- prompts

const RULES = (chat: Chat, agent: AgentId, existing: string[]) => `You are chatting with the user about a web project (Astro) through an automated orchestrator. You can read and edit files in this project directory. The current git branch is ${chat.branch}.
${existing.length ? `Read these project files first (they exist): ${existing.join(', ')}.\n` : ''}${agent === 'agy' ? 'You have NO shell access: do not run shell commands. Read and write files with your file tools only.\n' : ''}
Hard rules:
- Work only inside this project directory.
- Do NOT run git commit, push, merge, rebase, reset, checkout or deploy. The orchestrator commits your edits after each reply.
- Do NOT install or remove dependencies and do NOT edit netlify.toml.
- Do not read or print secrets (.env files, tokens).
- If something is missing or unclear (a color, a breakpoint, a text), ask the user instead of inventing it.
- Answer in the language the user writes in. Keep answers short; list the files you changed.`;

/** The previous conversation as plain text, for an agent that has no session of its own yet. */
export function transcript(chat: Chat, uptoMessageId: string): string {
  const upto = chat.messages.findIndex((m) => m.id === uptoMessageId);
  const history = chat.messages.slice(0, upto < 0 ? undefined : upto).filter((m) => m.role !== 'system' && m.status !== 'failed');
  const recent = history.slice(-TRANSCRIPT_MESSAGES);
  if (recent.length === 0) return '';
  const lines = recent.map((m) => `${m.role === 'user' ? 'USER' : `ASSISTANT (${m.agent ?? 'agent'})`}: ${m.text.length > TRANSCRIPT_CHARS ? `${m.text.slice(0, TRANSCRIPT_CHARS)}…` : m.text}`);
  return `\nConversation so far (edits made by the assistant are already on disk in this branch; do not redo them):\n${lines.join('\n\n')}\n`;
}

export function buildChatPrompt(chat: Chat, message: ChatMessage, agent: AgentId, existing: string[], withSession: boolean): string {
  const files = attachmentsPrompt(message.attachments ?? [], agent);
  if (withSession) return `${message.text}\n${files}`;
  return `${RULES(chat, agent, existing)}\n${transcript(chat, message.id)}\n---\nUSER MESSAGE:\n\n${message.text}\n${files}`;
}

// ---------------------------------------------------------------- the turn

export type TurnResult = {
  chat: Chat;
  agent?: AgentId;
  ok: boolean;
  files: string[];
  warnings: string[];
  waiting?: { until: string; reason: string };
};

/** Agent order for a chat in "auto" mode: the last agent first (keeps its session), then the rest. */
export function chatOrder(cfg: SwitchboardConfig, chat: Chat): AgentId[] {
  const order = [...cfg.chat.order];
  if (chat.lastAgent && order.includes(chat.lastAgent)) return [chat.lastAgent, ...order.filter((a) => a !== chat.lastAgent)];
  return order;
}

/**
 * Executes the oldest pending user message of the chat: chooses an agent, runs it, commits the edits to
 * the chat branch and stores the reply. On a usage limit in "auto" mode it hands over to the other agent.
 */
export async function runChatTurn(
  chatId: string,
  cfg: SwitchboardConfig,
  say: (s: string) => void = () => {},
  deps: ChatDeps = {},
): Promise<TurnResult> {
  const now = deps.now ?? (() => new Date());
  const notify = deps.notify ?? (cfg.notifications.enabled ? defaultNotify : async () => false);
  const overview = deps.overview ?? (async () => (await getOverview('force', cfg)).agents);
  const readUsage =
    deps.readUsage ?? (async (agent: AgentId) => (await collectUsage(cfg, new Date(), [agent])).find((r) => r.agent === agent)?.snapshot);

  const first = readState().chats[chatId];
  if (!first) throw new SbError('Чату не існує.', 2);
  if (first.status === 'running' && first.pid && first.pid !== process.pid && alive(first.pid)) throw new SbError('Відповідь у цьому чаті вже генерується.', 2);
  const message = first.messages.find((m) => m.role === 'user' && (m.status === 'pending' || m.status === 'running'));
  if (!message) throw new SbError('У чаті немає повідомлення, що чекає відповіді.', 2);
  const project = first.project;
  const warnings: string[] = [];

  // Another chat or task of this project must not share the working tree at the same time.
  const clash = busyWith(project, chatId);
  if (clash) throw new SbError(`У проєкті вже працює ${clash}. Дочекайся завершення.`, 3);
  const returnTo = await currentBranch(project);
  if (returnTo !== first.branch && (await dirtyFiles(project)).length > 0) {
    throw new SbError('Робоче дерево проєкту не чисте: закоміть або відклади зміни, тоді повтори.', 3);
  }

  const setMessage = (status: ChatMessage['status']) =>
    updateChat(chatId, (c) => { const m = c.messages.find((x) => x.id === message.id); if (m) m.status = status; });
  updateChat(chatId, (c) => { c.status = 'running'; c.pid = process.pid; c.waitUntil = undefined; });
  setMessage('running');

  // On Ctrl+C / "stop": keep the agent's edits as a checkpoint commit and free the chat.
  const unregister = onExit(() => {
    const chat = readState().chats[chatId];
    if (!chat || chat.pid !== process.pid) return;
    const git = (...a: string[]) => spawnSync('git', a, { cwd: project, encoding: 'utf8' });
    if (git('status', '--porcelain').stdout.trim()) {
      const identity = git('config', 'user.email').stdout.trim() ? [] : ['-c', 'user.name=Switchboard', '-c', 'user.email=switchboard@localhost'];
      git('add', '-A');
      git(...identity, 'commit', '-m', `wip(sb): chat ${chatId} interrupted`);
    }
    updateChat(chatId, (c) => {
      c.status = 'idle';
      c.pid = undefined;
      const m = c.messages.find((x) => x.id === message.id);
      if (m) m.status = 'failed';
      c.messages.push({ id: newId('m'), role: 'system', text: 'Зупинено користувачем; зміни збережено в гілці чату.', at: new Date().toISOString() });
    });
  }, 2);

  let result: TurnResult = { chat: first, ok: false, files: [], warnings };
  try {
    if ((await currentBranch(project)) !== first.branch) await checkoutBranch(project, first.branch);
    const before = await headSha(project);
    const existing = RULE_FILES.filter((f) => existsSync(resolve(project, f)));

    let handovers = 0;
    let exclude: AgentId[] = [];
    for (;;) {
      const chat = readState().chats[chatId]!;
      // ---- choose the agent
      let agent: AgentId;
      if (chat.mode !== 'auto') {
        agent = chat.mode;
      } else {
        const order = chatOrder(cfg, chat).filter((a) => !exclude.includes(a));
        const decision = routeTask({ ...cfg, routing: { chat: order } }, await overview(), { type: 'chat', priority: 'normal' }, now());
        if (decision.action !== 'run') {
          const until = decision.action === 'queue' ? decision.until : new Date(now().getTime() + 3600_000).toISOString();
          const clock = new Date(until).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
          const reason = `Немає вільного агента (${decision.reason}). Спробуй після ${clock} або обери агента вручну.`;
          updateChat(chatId, (c) => {
            c.status = 'waiting';
            c.waitUntil = until;
            c.pid = undefined;
            const m = c.messages.find((x) => x.id === message.id);
            if (m) m.status = 'pending';
            c.messages.push({ id: newId('m'), role: 'system', text: reason, at: now().toISOString() });
          });
          say(`⏸ ${reason}`);
          result = { chat: readState().chats[chatId]!, ok: false, files: [], warnings, waiting: { until, reason } };
          return result;
        }
        agent = decision.agent;
        say(`Роутер: ${agent} (${decision.reason})`);
      }

      // ---- run: continue the agent's own session, or start one with a transcript
      let sessionId = chat.sessions[agent];
      const runId = `r-${chatId.slice(2)}-${chat.turns + 1}${handovers ? `-${handovers + 1}` : ''}`;
      const run: Run = { id: runId, taskId: chatId, agent, startedAt: now().toISOString(), status: 'running', logPath: '' };
      const timeoutMs = cfg.run.timeoutMin * 60_000;
      const attempt = async (sid?: string) => {
        const prompt = buildChatPrompt(chat, message, agent, existing, Boolean(sid));
        say(`▶ ${agent}${sid ? ' (сесія триває)' : ''}: ${oneLine(message.text, 70)}`);
        return runAgentOnce({ cfg, agent, project, prompt, runId, timeoutMs, sessionId: sid, say, warnings, now, logNote: `chat=${chatId} branch=${chat.branch}` });
      };
      let { proc, outcome, logPath } = await attempt(sessionId);
      // A lost session (for example after the agent's own cleanup): start over with the transcript.
      if (!outcome.ok && sessionId && /session|conversation|not found|no such/i.test(outcome.error ?? '') && outcome.denied.length === 0) {
        updateChat(chatId, (c) => { delete c.sessions[agent]; });
        sessionId = undefined;
        ({ proc, outcome, logPath } = await attempt(undefined));
      }
      run.logPath = logPath;
      saveRun(run);

      // ---- usage limit: mark the agent and hand over (auto mode only)
      if (!outcome.ok && !proc.timedOut && !proc.spawnError && outcome.denied.length === 0) {
        const snapshot = await readUsage(agent).catch(() => undefined);
        const limit = detectLimit({
          stdout: proc.stdout, stderr: proc.stderr, outcome, exitCode: proc.code, timedOut: proc.timedOut,
          taskText: message.text, patterns: cfg.limitDetection.patterns, tailLines: cfg.limitDetection.tailLines, snapshot, now: now(),
        });
        if (limit.hit) {
          const until = limit.resetsAt ?? new Date(now().getTime() + 3600_000).toISOString();
          setExhausted(agent, { until, reason: limit.reason, since: now().toISOString() });
          run.status = 'failed';
          run.reason = `ліміт: ${limit.reason}`;
          run.endedAt = now().toISOString();
          saveRun(run);
          say(`⚠ ${agent}: ${limit.reason}.`);
          const canHand = chat.mode === 'auto' && handovers < cfg.handoff.maxHandoffs;
          if (canHand) {
            handovers++;
            exclude = [...exclude, agent];
            const note = `${agent === 'claude' ? 'Claude' : 'Antigravity'}: ${limit.reason}. Передаю розмову іншому агентові.`;
            updateChat(chatId, (c) => { c.messages.push({ id: newId('m'), role: 'system', text: note, at: now().toISOString() }); });
            await notify('Switchboard: чат', note).catch(() => false);
            // Keep the half-done edits: they are on disk and the next agent sees them in the same branch.
            continue;
          }
          const text = `${agent}: ${limit.reason}. ${chat.mode === 'auto' ? 'Ліміт передач вичерпано.' : 'Обери іншого агента або дочекайся скидання.'}`;
          return await finish(chatId, message.id, before, { agent, outcome, text, ok: false, run, now }, cfg, project, warnings, result);
        }
      }

      const ok = outcome.ok;
      const text = ok
        ? maskSecrets(outcome.reply ?? outcome.summary ?? '(порожня відповідь)')
        : outcome.denied.length
          ? `Агентові не дозволено дію: ${outcome.denied.join(', ')}.`
          : `Помилка: ${outcome.error ?? 'невідома'}${outcome.summary ? `\n${maskSecrets(outcome.summary)}` : ''}`;
      run.status = ok ? 'done' : outcome.denied.length ? 'blocked' : 'failed';
      run.endedAt = now().toISOString();
      run.exitCode = proc.code;
      run.summary = outcome.summary;
      saveRun(run);
      return await finish(chatId, message.id, before, { agent, outcome, text, ok, run, now }, cfg, project, warnings, result);
    }
  } catch (e) {
    updateChat(chatId, (c) => {
      c.status = 'idle';
      c.pid = undefined;
      const m = c.messages.find((x) => x.id === message.id);
      if (m) m.status = 'failed';
      c.messages.push({ id: newId('m'), role: 'system', text: `Помилка: ${(e as Error).message.slice(0, 300)}`, at: new Date().toISOString() });
    });
    throw e;
  } finally {
    unregister();
    updateChat(chatId, (c) => { if (c.pid === process.pid) { c.pid = undefined; if (c.status === 'running') c.status = 'idle'; } });
    try {
      if ((await currentBranch(project)) !== returnTo) await switchBack(project, returnTo);
    } catch (e) {
      warnings.push(`не вдалося повернутися на ${returnTo}: ${(e as Error).message}`);
    }
  }
}

type Finish = { agent: AgentId; outcome: Outcome; text: string; ok: boolean; run: Run; now: () => Date };

/** Commits the turn's edits, stores the reply and the session id, optionally pushes the branch. */
async function finish(
  chatId: string,
  messageId: string,
  before: string,
  f: Finish,
  cfg: SwitchboardConfig,
  project: string,
  warnings: string[],
  fallback: TurnResult,
): Promise<TurnResult> {
  const chat = readState().chats[chatId]!;
  const title = oneLine(chat.messages.find((m) => m.id === messageId)?.text ?? 'chat', 60);
  await commitAll(project, f.ok ? `chat(sb): ${title} [${chatId}]` : `wip(sb): chat ${chatId} checkpoint from ${f.agent}`);
  const files = await changedFiles(project, before);
  const touched = protectedTouched(files, cfg.git.protectedPaths);
  if (touched.length > 0) warnings.push(`Агент змінив захищені файли (${touched.join(', ')}): гілку не буде запушено, перевір diff.`);
  if (cfg.git.pushBranches && files.length > 0 && touched.length === 0) {
    try {
      await pushBranch(project, chat.branch);
    } catch (e) {
      warnings.push(`push не вдався: ${(e as Error).message}`);
    }
  }
  const updated = updateChat(chatId, (c) => {
    const m = c.messages.find((x) => x.id === messageId);
    if (m) m.status = f.ok ? 'done' : 'failed';
    c.messages.push({
      id: newId('m', f.now()), role: f.ok ? 'agent' : 'system', text: f.text, at: f.now().toISOString(), agent: f.agent, files: files.length ? files : undefined,
    });
    if (f.outcome.sessionId) c.sessions[f.agent] = f.outcome.sessionId;
    if (f.ok) {
      c.lastAgent = f.agent;
      c.turns += 1;
    }
    for (const w of touched.length ? [`Захищені файли змінено: ${touched.join(', ')}`] : []) c.messages.push({ id: newId('m', f.now()), role: 'system', text: w, at: f.now().toISOString() });
    c.status = 'idle';
    c.pid = undefined;
  });
  return { chat: updated ?? fallback.chat, agent: f.agent, ok: f.ok, files, warnings };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Describes what else occupies the project's working tree right now (a running task or another chat). */
export function busyWith(project: string, exceptChatId?: string): string | undefined {
  const s = readState();
  for (const t of Object.values(s.tasks)) {
    if (t.project === project && t.pid && (t.status === 'running' || t.status === 'queued') && alive(t.pid)) return `задача ${t.id}`;
  }
  for (const c of Object.values(s.chats)) {
    if (c.id !== exceptChatId && c.project === project && c.pid && c.pid !== process.pid && c.status === 'running' && alive(c.pid)) return `чат ${c.title}`;
  }
  return undefined;
}
