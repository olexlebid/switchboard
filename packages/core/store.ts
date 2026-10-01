// Tiny JSON store in ~/.switchboard (override with SB_HOME). Chosen over SQLite:
// one user, small data, no native build; writes are atomic (tmp + rename).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentId, ExhaustedMark, UsageSnapshot } from './types';

export type State = {
  version: 1;
  snapshots: Partial<Record<AgentId, UsageSnapshot>>;
  /** Recent snapshots for history charts, newest last. */
  history: UsageSnapshot[];
  exhausted: Partial<Record<AgentId, ExhaustedMark>>;
  /** Hand-set marks for services without an API (dashboard manual cards). */
  manual: Record<string, { state: 'available' | 'exhausted'; at: string }>;
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
  return { version: 1, snapshots: {}, history: [], exhausted: {}, manual: {}, meta: {} };
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

export function updateState(fn: (s: State) => void): State {
  const s = readState();
  fn(s);
  writeJsonAtomic(statePath(), s);
  return s;
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
