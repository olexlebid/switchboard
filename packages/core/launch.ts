// Starts, resumes and stops tasks on behalf of the dashboard. The dashboard never runs agents itself:
// it spawns a separate `sb` process (so a task survives a dashboard restart) with a fixed argument list.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveAttachments, type IncomingFile } from './attachments';
import { addUserMessage, busyWith, createChat, setChatMode } from './chat';
import { SbError } from './errors';
import { defaultConfigPath } from './config';
import { maskSecrets } from './mask';
import { readState, runsDir } from './store';
import { matchAllowedProject } from './task-overview';
import type { AgentId, SwitchboardConfig } from './types';

export type LaunchInput = {
  text: string;
  type: string;
  project: string;
  priority?: string;
  figma?: string;
};

export type LaunchResult = { ok: true; message: string; taskId?: string } | { ok: false; error: string; status: number };

const MAX_TEXT = 5000;
const fail = (error: string, status = 400): LaunchResult => ({ ok: false, error, status });

/** Repo root: set by `sb dashboard` (SB_ROOT); otherwise derived from this file (tests, dev). */
export function repoRoot(): string {
  return process.env.SB_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
}

export type ValidatedLaunch = { args: string[]; project: string };

/** Checks form input against the config and the allowed project list; returns the exact `sb run` argv. */
export function validateLaunch(cfg: SwitchboardConfig, input: LaunchInput): ValidatedLaunch | { error: string } {
  const text = input.text.replace(/\r\n/g, '\n').trim();
  if (!text) return { error: 'Опиши задачу.' };
  if (text.length > MAX_TEXT) return { error: `Опис задачі задовгий (максимум ${MAX_TEXT} символів).` };
  if (!cfg.routing[input.type]) return { error: 'Невідомий тип задачі.' };
  const priority = input.priority || 'normal';
  if (priority !== 'normal' && priority !== 'high') return { error: 'Невідомий пріоритет.' };
  const figma = (input.figma ?? '').trim();
  if (figma) {
    let url: URL;
    try {
      url = new URL(figma);
    } catch {
      return { error: 'Посилання на Figma некоректне.' };
    }
    if (url.protocol !== 'https:' || !/(^|\.)figma\.com$/.test(url.hostname)) return { error: 'Посилання має вести на figma.com (https).' };
  }
  const project = matchAllowedProject(cfg, input.project);
  if (!project) return { error: 'Цей проєкт не дозволений для запуску з дешборду. Додай його: `sb project add <папка>`.' };

  // Everything after "--" is the task text, so text that starts with "-" is never read as an option.
  const args = ['run', '--project', project, '--type', input.type, '--priority', priority];
  if (figma) args.push('--figma', figma);
  args.push('--', text);
  return { args, project };
}

function sbCommand(args: string[]): { cmd: string; args: string[]; cwd: string } {
  const root = repoRoot();
  // `--import tsx` runs the TypeScript CLI directly with the repo's own tsx.
  return { cmd: process.execPath, args: ['--import', 'tsx', join(root, 'bin/sb.ts'), ...args], cwd: root };
}

/** Is a task or a chat of this project running right now? (one working tree, one agent at a time) */
const projectBusy = (project: string): boolean => busyWith(project) !== undefined;

/** Spawns a detached `sb` and waits briefly to report an immediate failure (dirty tree, bad input...). */
async function spawnSb(args: string[], label: string, waitForNewTask: boolean): Promise<LaunchResult> {
  const before = new Set(Object.keys(readState().tasks));
  mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  const outPath = join(runsDir(), `launch-${label}-${Date.now()}.out`);
  const fd = openSync(outPath, 'a', 0o600);
  chmodSync(outPath, 0o600);

  const { cmd, args: argv, cwd } = sbCommand(args);
  const child = spawn(cmd, argv, {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, SB_CONFIG: defaultConfigPath(), FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  closeSync(fd);
  child.unref();

  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const started = Date.now();
  while (Date.now() - started < 6000) {
    const code = await Promise.race([exited, new Promise<'tick'>((r) => setTimeout(() => r('tick'), 120))]);
    if (code !== 'tick') {
      // Finished within seconds: a real error unless the task simply completed very fast.
      const out = maskSecrets(readFileSync(outPath, 'utf8')).trim().split('\n').slice(-8).join('\n');
      if (code === 0) return { ok: true, message: 'Задачу виконано.' };
      const created = Object.keys(readState().tasks).find((id) => !before.has(id));
      if (created && waitForNewTask) return { ok: true, message: `Задача ${created} завершилась (код ${code}); деталі нижче.`, taskId: created };
      return fail(out || `sb завершився з кодом ${code}`, 409);
    }
    if (waitForNewTask) {
      const created = Object.keys(readState().tasks).find((id) => !before.has(id));
      if (created) return { ok: true, message: `Задачу ${created} запущено.`, taskId: created };
    } else if (Date.now() - started > 1500) {
      return { ok: true, message: 'Продовження запущено.' };
    }
  }
  return { ok: true, message: 'Запуск ініційовано; задача з’явиться в списку.' };
}

/** Saves uploaded files into the project and returns the batch folder, or an error text. */
async function storeUploads(project: string, files: IncomingFile[] | undefined): Promise<{ dir?: string; error?: string; notes: string[] }> {
  if (!files || files.length === 0) return { notes: [] };
  const batch = await saveAttachments(project, files);
  const notes = batch.rejected.map((r) => `${r.name}: ${r.reason}`);
  if (batch.items.length === 0) return { error: `Жоден файл не прийнято. ${notes.join('; ')}`, notes };
  return { dir: batch.dir, notes };
}

export async function launchTask(cfg: SwitchboardConfig, input: LaunchInput, files?: IncomingFile[]): Promise<LaunchResult> {
  const v = validateLaunch(cfg, input);
  if ('error' in v) return fail(v.error);
  if (projectBusy(v.project)) return fail('У цьому проєкті вже виконується задача або чат. Дочекайся завершення.', 409);
  const up = await storeUploads(v.project, files);
  if (up.error) return fail(up.error);
  const args = up.dir ? [...v.args.slice(0, v.args.indexOf('--')), '--attachments', up.dir, ...v.args.slice(v.args.indexOf('--'))] : v.args;
  const r = await spawnSb(args, 'run', true);
  return r.ok && up.notes.length ? { ...r, message: `${r.message} Не прийнято: ${up.notes.join('; ')}` } : r;
}

export async function resumeFromDashboard(
  cfg: SwitchboardConfig,
  id: string,
  extra: { note?: string; files?: IncomingFile[] } = {},
): Promise<LaunchResult> {
  const task = readState().tasks[id];
  if (!task) return fail('Задачі не існує.', 404);
  if (!['waiting', 'blocked', 'failed'].includes(task.status)) return fail('Цю задачу не можна продовжити в поточному стані.', 409);
  if (!matchAllowedProject(cfg, task.project)) return fail('Проєкт задачі недоступний.', 409);
  if (projectBusy(task.project)) return fail('У цьому проєкті вже виконується задача або чат.', 409);
  const note = (extra.note ?? '').replace(/\r\n/g, '\n').trim();
  if (note.length > MAX_TEXT) return fail(`Відповідь задовга (максимум ${MAX_TEXT} символів).`);
  const up = await storeUploads(task.project, extra.files);
  if (up.error) return fail(up.error);
  const args = ['resume', id];
  if (up.dir) args.push('--attachments', up.dir);
  if (note) args.push('--note', note);
  return spawnSb(args, 'resume', false);
}

// ---------------------------------------------------------------- chat

const failFrom = (e: unknown): LaunchResult => (e instanceof SbError ? fail(e.message, 409) : fail((e as Error).message, 500));

/** Creates an empty chat for an allowed project. */
export async function newChatFromDashboard(cfg: SwitchboardConfig, projectInput: string, mode: string): Promise<LaunchResult & { chatId?: string }> {
  const project = matchAllowedProject(cfg, projectInput);
  if (!project) return fail('Цей проєкт не дозволений.');
  if (mode !== 'auto' && mode !== 'claude' && mode !== 'agy') return fail('Невідомий режим чату.');
  try {
    const chat = await createChat({ project, mode });
    return { ok: true, message: 'Новий чат створено.', chatId: chat.id };
  } catch (e) {
    return failFrom(e);
  }
}

export function setChatModeFromDashboard(chatId: string, mode: string): LaunchResult {
  if (!readState().chats[chatId]) return fail('Чату не існує.', 404);
  if (mode !== 'auto' && mode !== 'claude' && mode !== 'agy') return fail('Невідомий режим чату.');
  setChatMode(chatId, mode as 'auto' | AgentId);
  return { ok: true, message: 'Режим змінено.' };
}

/** Adds the user's message (with files) and starts a detached `sb chat-turn` for it. */
export async function sendChatMessage(cfg: SwitchboardConfig, chatId: string, text: string, files?: IncomingFile[]): Promise<LaunchResult> {
  const chat = readState().chats[chatId];
  if (!chat) return fail('Чату не існує.', 404);
  if (!matchAllowedProject(cfg, chat.project)) return fail('Проєкт чату недоступний.', 409);
  if (chat.status === 'running') return fail('Агент ще відповідає.', 409);
  if (busyWith(chat.project, chatId)) return fail('У цьому проєкті вже виконується задача або інший чат.', 409);
  const up = await storeUploads(chat.project, files);
  if (up.error) return fail(up.error);
  try {
    addUserMessage(chatId, { text, attachmentsDir: up.dir });
  } catch (e) {
    return failFrom(e);
  }
  const r = await spawnSb(['chat-turn', chatId], 'chat', false);
  return r.ok && up.notes.length ? { ...r, message: `${r.message} Не прийнято: ${up.notes.join('; ')}` } : r;
}

/** Starts the turn for a message that is still pending (e.g. after "waiting for a limit reset"). */
export async function retryChat(cfg: SwitchboardConfig, chatId: string): Promise<LaunchResult> {
  const chat = readState().chats[chatId];
  if (!chat) return fail('Чату не існує.', 404);
  if (!matchAllowedProject(cfg, chat.project)) return fail('Проєкт чату недоступний.', 409);
  if (chat.status === 'running') return fail('Агент ще відповідає.', 409);
  if (busyWith(chat.project, chatId)) return fail('У цьому проєкті вже виконується задача або інший чат.', 409);
  if (!chat.messages.some((m) => m.role === 'user' && m.status === 'pending')) return fail('Немає повідомлення, що чекає.', 409);
  return spawnSb(['chat-turn', chatId], 'chat', false);
}

/** True when `pid` is one of our `sb` processes (never signal an arbitrary process). */
export function isSbProcess(pid: number): boolean {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return r.status === 0 && /bin\/sb\.ts/.test(r.stdout);
}

export function stopTask(id: string): LaunchResult {
  const task = readState().tasks[id];
  if (!task) return fail('Задачі не існує.', 404);
  if ((task.status !== 'running' && task.status !== 'queued') || !task.pid) return fail('Задача зараз не виконується.', 409);
  if (!isSbProcess(task.pid)) return fail('Процес задачі не знайдено (вже завершився).', 409);
  // sb handles SIGTERM: it stops the agent, restores agy rules and commits a wip checkpoint.
  process.kill(task.pid, 'SIGTERM');
  return { ok: true, message: 'Зупиняю задачу: робота збережеться чекпойнтом у гілці.' };
}


export function stopChat(chatId: string): LaunchResult {
  const chat = readState().chats[chatId];
  if (!chat) return fail('Чату не існує.', 404);
  if (chat.status !== 'running' || !chat.pid) return fail('Агент зараз не відповідає.', 409);
  if (!isSbProcess(chat.pid)) return fail('Процес чату не знайдено (вже завершився).', 409);
  // sb handles SIGTERM: it stops the agent, restores agy rules and commits a checkpoint.
  process.kill(chat.pid, 'SIGTERM');
  return { ok: true, message: 'Зупиняю відповідь: зміни збережуться в гілці чату.' };
}
