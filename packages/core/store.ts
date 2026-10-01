// Tiny JSON store in ~/.switchboard (override with SB_HOME). Chosen over SQLite:
// one user, small data, no native build; writes are atomic (tmp + rename).
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentId, ExhaustedMark, Run, Task, UsageSnapshot } from './types';

export type State = {
  version: 1;
  snapshots: Partial<Record<AgentId, UsageSnapshot>>;
  /** Recent snapshots for history charts, newest last. */
  history: UsageSnapshot[];
  exhausted: Partial<Record<AgentId, ExhaustedMark>>;
  /** Hand-set marks for services without an API (dashboard manual cards). */
  manual: Record<string, { state: 'available' | 'exhausted'; at: string }>;
  /** Project folders the dashboard may start tasks in (added by `sb project add` or by running a task). */
  projects: string[];
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  /** Slow-changing facts cached between refreshes. */
  meta: { agyModels?: { count: number; at: string } };
};

const HISTORY_LIMIT = 500;

export function sbHome(): string {
  return process.env.SB_HOME ?? join(homedir(), '.switchboard');
}

function statePath(): string {
  return join(sbHome(), 'state.json');
}

function emptyState(): State {
  return { version: 1, snapshots: {}, history: [], exhausted: {}, manual: {}, projects: [], tasks: {}, runs: {}, meta: {} };
}

export function readState(): State {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as State;
    if (parsed.version !== 1) return emptyState();
    return { ...emptyState(), ...parsed };
  } catch {
    // Missing or corrupt file: start clean instead of crashing the CLI.
    return emptyState();
  }
}

/** Atomic JSON write with private permissions (state may contain masked account info). */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 15_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process lock around read-modify-write of state.json (the dashboard and several `sb`
 * processes write to it). Plain O_EXCL lock file; a lock older than LOCK_STALE_MS belongs to a
 * crashed process and is taken over.
 */
function withStateLock<T>(fn: () => T): T {
  mkdirSync(sbHome(), { recursive: true, mode: 0o700 });
  const lock = `${statePath()}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch { /* the holder just released it */ }
      if (Date.now() > deadline) throw new Error('state.json is locked by another process (timeout)');
      sleepSync(10 + Math.floor(Math.random() * 15));
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

export function updateState(fn: (s: State) => void): State {
  return withStateLock(() => {
    const s = readState();
    fn(s);
    writeJsonAtomic(statePath(), s);
    return s;
  });
}

export function saveSnapshot(snap: UsageSnapshot): void {
  updateState((s) => {
    s.snapshots[snap.agent] = snap;
    s.history.push(snap);
    if (s.history.length > HISTORY_LIMIT) s.history.splice(0, s.history.length - HISTORY_LIMIT);
  });
}

export function setExhausted(agent: AgentId, mark: ExhaustedMark): void {
  updateState((s) => { s.exhausted[agent] = mark; });
}

export function clearExhausted(agent: AgentId): void {
  updateState((s) => { delete s.exhausted[agent]; });
}

export function setManual(id: string, state: 'available' | 'exhausted', now = new Date()): void {
  updateState((s) => { s.manual[id] = { state, at: now.toISOString() }; });
}

export function runsDir(): string {
  return join(sbHome(), 'runs');
}

export function saveTask(task: Task): void {
  updateState((s) => { s.tasks[task.id] = { ...task, updatedAt: new Date().toISOString() }; });
}

export function saveRun(run: Run): void {
  updateState((s) => { s.runs[run.id] = run; });
}

export function addProject(path: string): void {
  updateState((s) => { if (!s.projects.includes(path)) s.projects.push(path); });
}

export function removeProject(path: string): boolean {
  let removed = false;
  updateState((s) => {
    const before = s.projects.length;
    s.projects = s.projects.filter((p) => p !== path);
    removed = s.projects.length < before;
  });
  return removed;
}
