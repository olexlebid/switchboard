// ChatGPT (Codex CLI) usage. `codex exec` has no usage command (`/status` exists only in the interactive TUI), so the
// numbers come from the rate-limit records Codex writes into its own local session logs:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, lines like
//   {"timestamp":"...","type":"event_msg","payload":{"type":"token_count","info":{...},
//    "rate_limits":{"primary":{"used_percent":12.0,"window_minutes":300,"resets_at":1790000000},
//                   "secondary":{"used_percent":3.0,"window_minutes":10080,"resets_at":1790500000}}}}
// This is a local log, not an API; its format is not documented by OpenAI and may change between CLI versions
// (older versions wrote `resets_in_seconds` instead of `resets_at`; both are understood). The snapshot is as fresh as
// the last Codex turn, so `capturedAt` is the time of that record, not "now".
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageSnapshot, UsageWindow } from '../types';

const TAIL_BYTES = 256 * 1024;
const MAX_FILES = 25;

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

type RateWindow = { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown; resets_in_seconds?: unknown };

export type CodexRateLimits = { at: string; primary?: UsageWindow & { minutes?: number }; secondary?: UsageWindow & { minutes?: number } };

function toWindow(w: RateWindow | undefined, at: Date): (UsageWindow & { minutes?: number }) | undefined {
  if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return undefined;
  let resets: number | undefined;
  if (typeof w.resets_at === 'number') resets = w.resets_at * 1000;
  else if (typeof w.resets_in_seconds === 'number') resets = at.getTime() + w.resets_in_seconds * 1000;
  if (resets === undefined || !Number.isFinite(resets)) return undefined;
  return {
    usedPct: Math.min(100, Math.max(0, Math.round(w.used_percent * 100) / 100)),
    resetsAt: new Date(resets).toISOString(),
    minutes: typeof w.window_minutes === 'number' ? w.window_minutes : undefined,
  };
}

/** The newest `token_count` record with rate limits in a chunk of a rollout file (last line wins). */
export function parseCodexRateLimits(text: string): CodexRateLimits | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.includes('"rate_limits"')) continue;
    try {
      const ev = JSON.parse(line) as { timestamp?: string; payload?: { type?: string; rate_limits?: { primary?: RateWindow; secondary?: RateWindow } } };
      const rl = ev.payload?.rate_limits;
      const at = ev.timestamp && Number.isFinite(Date.parse(ev.timestamp)) ? new Date(ev.timestamp) : undefined;
      if (!rl || !at) continue;
      const primary = toWindow(rl.primary, at);
      const secondary = toWindow(rl.secondary, at);
      if (primary || secondary) return { at: at.toISOString(), primary, secondary };
    } catch { /* a cut first line of the tail chunk, or another record type */ }
  }
  return undefined;
}

/** A window of ~5 hours is the "5 год" bar, one of ~7 days the weekly bar; unknown lengths keep their position. */
export function toSnapshot(rl: CodexRateLimits): UsageSnapshot {
  const wins = [rl.primary, rl.secondary].filter((w): w is NonNullable<typeof w> => !!w);
  const strip = ({ usedPct, resetsAt }: UsageWindow): UsageWindow => ({ usedPct, resetsAt });
  let fiveHour: UsageWindow | undefined;
  let weekly: UsageWindow | undefined;
  for (const w of wins) {
    if (w.minutes !== undefined && w.minutes >= 6 * 24 * 60) weekly ??= strip(w);
    else if (w.minutes !== undefined && w.minutes <= 12 * 60) fiveHour ??= strip(w);
  }
  if (!fiveHour && !weekly) {
    // No window lengths: the first record is the short window, the second the long one.
    if (rl.primary) fiveHour = strip(rl.primary);
    if (rl.secondary) weekly = strip(rl.secondary);
  }
  return { agent: 'codex', fiveHour, weekly, source: 'local-logs', capturedAt: rl.at };
}

/** Rollout files, newest first (the date folders and file names sort chronologically). */
function newestRollouts(root: string): string[] {
  const out: string[] = [];
  const sortedDesc = (dir: string): string[] => {
    try { return readdirSync(dir).sort().reverse(); } catch { return []; }
  };
  for (const y of sortedDesc(root)) {
    for (const m of sortedDesc(join(root, y))) {
      for (const d of sortedDesc(join(root, y, m))) {
        for (const f of sortedDesc(join(root, y, m, d))) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) out.push(join(root, y, m, d, f));
          if (out.length >= MAX_FILES) return out;
        }
      }
    }
  }
  return out;
}

function readTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export async function fetchCodexUsage(): Promise<UsageSnapshot> {
  const root = join(codexHome(), 'sessions');
  let best: CodexRateLimits | undefined;
  for (const file of newestRollouts(root)) {
    let found: CodexRateLimits | undefined;
    try { found = parseCodexRateLimits(readTail(file)); } catch { continue; }
    if (found && (!best || Date.parse(found.at) > Date.parse(best.at))) best = found;
    // Files are walked newest first: the first one with a record is the freshest, except for parallel sessions.
    if (best && Date.now() - Date.parse(best.at) < 3600_000) break;
  }
  if (!best) throw new Error(`no rate-limit records in ${root}: they appear after the first Codex run (codex login, then any request)`);
  return toSnapshot(best);
}
