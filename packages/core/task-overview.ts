// What the dashboard shows about tasks: running, waiting (queue), recent, handover history, log tail.
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadConfig } from './config';
import { maskSecrets } from './mask';
import { AGENT_TITLES } from './overview';
import { readState, runsDir, saveTask } from './store';
import { taskTitle } from './tasks';
import type { AgentId, SwitchboardConfig, Task, TaskStatus } from './types';

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'запускається',
  running: 'виконується',
  waiting: 'чекає',
  blocked: 'заблоковано',
  failed: 'помилка',
  done: 'готово',
};

export type TaskView = {
  id: string;
  title: string;
  type: string;
  project: string;
  projectName: string;
  branch: string;
  agent?: AgentId;
  agentTitle?: string;
  status: TaskStatus;
  statusLabel: string;
  /** Start of the latest run (running tasks show the elapsed time from here). */
  startedAt?: string;
  logTail: string[];
  note?: string;
  waitUntil?: string;
  canResume: boolean;
  canStop: boolean;
};

export type HandoffView = {
  taskId: string;
  taskTitle: string;
  at: string;
  /** "Claude Code → Antigravity о 14:32, причина: 5-год ліміт" */
  text: string;
};

export type ProjectOption = { path: string; name: string };

export type TasksOverview = {
  running: TaskView[];
  waiting: TaskView[];
  recent: TaskView[];
  handoffs: HandoffView[];
  types: { id: string; short: boolean }[];
  projects: ProjectOption[];
  hasRunning: boolean;
};

/** Last `lines` lines of a text file without reading all of it (logs can be large). */
export function tailFile(path: string, lines = 20, maxBytes = 64_000): string[] {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    return buf
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(-lines)
      .map((l) => maskSecrets(l.length > 300 ? `${l.slice(0, 300)}…` : l));
  } catch {
    return [];
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A task stuck in "running" whose sb process is gone (e.g. kill -9) is marked failed. */
function reconcile(tasks: Task[]): void {
  for (const t of tasks) {
    if ((t.status === 'running' || t.status === 'queued') && t.pid && !processAlive(t.pid)) {
      t.status = 'failed';
      t.note = 'процес sb зник (збій або kill -9); спробуй «Продовжити»';
      t.pid = undefined;
      saveTask(t);
    }
  }
}

/** Real paths of every project the dashboard may start tasks in. */
export function allowedProjects(cfg: SwitchboardConfig): ProjectOption[] {
  const state = readState();
  const raw = [...cfg.dashboard.projects, ...state.projects, ...Object.values(state.tasks).map((t) => t.project)];
  const seen = new Set<string>();
  const out: ProjectOption[] = [];
  for (const p of raw) {
    const abs = resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue; // folder is gone
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ path: real, name: basename(real) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolves a user-supplied project path to an allowed project, or undefined. */
export function matchAllowedProject(cfg: SwitchboardConfig, input: string): string | undefined {
  try {
    const real = realpathSync(resolve(input.replace(/^~(?=$|\/)/, process.env.HOME ?? '~')));
    return allowedProjects(cfg).some((p) => p.path === real) ? real : undefined;
  } catch {
    return undefined;
  }
}

function view(t: Task): TaskView {
  const state = readState();
  const runs = t.runs.map((id) => state.runs[id]).filter((r): r is NonNullable<typeof r> => !!r);
  const last = runs[runs.length - 1];
  const live = t.status === 'running' || t.status === 'queued';
  return {
    id: t.id,
    title: taskTitle(t.text),
    type: t.type,
    project: t.project,
    projectName: basename(t.project),
    branch: t.branch,
    agent: t.agent,
    agentTitle: t.agent ? AGENT_TITLES[t.agent] : undefined,
    status: t.status,
    statusLabel: TASK_STATUS_LABEL[t.status],
    startedAt: last?.startedAt,
    // The log of a finished task is useful too (the last lines explain how it ended).
    logTail: last && last.logPath.startsWith(runsDir()) && existsSync(last.logPath) ? tailFile(last.logPath, 20) : [],
    note: t.note?.replace(/\s+/g, ' ').slice(0, 220),
    waitUntil: t.waitUntil,
    canResume: t.status === 'waiting' || t.status === 'blocked' || t.status === 'failed',
    canStop: live && !!t.pid,
  };
}

export function getTasksOverview(cfg: SwitchboardConfig = loadConfig()): TasksOverview {
  reconcile(Object.values(readState().tasks));
  const tasks = Object.values(readState().tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const running = tasks.filter((t) => t.status === 'running' || t.status === 'queued').map((t) => view(t));
  const waiting = tasks
    .filter((t) => t.status === 'waiting')
    .sort((a, b) => (a.waitUntil ?? '').localeCompare(b.waitUntil ?? ''))
    .map((t) => view(t));
  const recent = tasks.filter((t) => !['running', 'queued', 'waiting'].includes(t.status)).slice(0, 8).map((t) => view(t));

  const handoffs: HandoffView[] = tasks
    .flatMap((t) =>
      (t.handoffs ?? []).map((h) => {
        const time = new Date(h.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
        const to = h.to ? AGENT_TITLES[h.to] : 'нікому (пауза)';
        return { taskId: t.id, taskTitle: taskTitle(t.text, 50), at: h.at, text: `${AGENT_TITLES[h.from]} → ${to} о ${time}, причина: ${h.reason}` };
      }),
    )
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10);

  return {
    running,
    waiting,
    recent,
    handoffs,
    types: Object.keys(cfg.routing).map((id) => ({ id, short: cfg.router.shortTypes.includes(id) })),
    projects: allowedProjects(cfg),
    hasRunning: running.length > 0,
  };
}

