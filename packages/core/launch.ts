// Starts, resumes and stops tasks on behalf of the dashboard. The dashboard never runs agents itself:
// it spawns a separate `sb` process (so a task survives a dashboard restart) with a fixed argument list.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath } from './config';
import { maskSecrets } from './mask';
import { readState, runsDir } from './store';
import { matchAllowedProject } from './task-overview';
import type { SwitchboardConfig } from './types';

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

/** Does any task of this project have a live `sb` process? (one task per project at a time) */
function projectBusy(project: string): boolean {
  return Object.values(readState().tasks).some((t) => {
    if (t.project !== project || !t.pid || (t.status !== 'running' && t.status !== 'queued')) return false;
    try {
      process.kill(t.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

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

export async function launchTask(cfg: SwitchboardConfig, input: LaunchInput): Promise<LaunchResult> {
  const v = validateLaunch(cfg, input);
  if ('error' in v) return fail(v.error);
  if (projectBusy(v.project)) return fail('У цьому проєкті вже виконується задача. Дочекайся її завершення.', 409);
  return spawnSb(v.args, 'run', true);
}

export async function resumeFromDashboard(cfg: SwitchboardConfig, id: string): Promise<LaunchResult> {
  const task = readState().tasks[id];
  if (!task) return fail('Задачі не існує.', 404);
  if (!['waiting', 'blocked', 'failed'].includes(task.status)) return fail('Цю задачу не можна продовжити в поточному стані.', 409);
  if (!matchAllowedProject(cfg, task.project)) return fail('Проєкт задачі недоступний.', 409);
  if (projectBusy(task.project)) return fail('У цьому проєкті вже виконується задача.', 409);
  return spawnSb(['resume', id], 'resume', false);
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

