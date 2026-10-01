// Decides whether a failed agent run hit a usage limit, and when the limit resets.
//
// A run counts as "limit hit" only when ALL of these hold:
//  - it failed (not ok), did not time out and was not merely blocked by permissions;
//  - a configured pattern matches the LAST lines of its output, ignoring any text copied from the
//    task itself (so a task that talks about "quota" never triggers a handover);
// or when a fresh usage snapshot shows a window at 100%.
import { parseResetTime } from './limits/claude';
import { maskSecrets } from './mask';
import type { Outcome } from './interpret';
import type { UsageSnapshot } from './types';

export type LimitSignal = {
  hit: boolean;
  /** Short Ukrainian label for the history, e.g. "5-год ліміт". */
  reason: string;
  /** ISO time when the agent can be used again, when known. */
  resetsAt?: string;
  /** What matched (pattern text or "snapshot"), for logs and tests. */
  evidence?: string;
};

export type DetectInput = {
  stdout: string;
  stderr: string;
  outcome: Outcome;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: boolean;
  /** Task text; copies of it are removed from the output before matching. */
  taskText: string;
  patterns: string[];
  tailLines: number;
  /** Fresh usage read taken right after the failure, if available. */
  snapshot?: UsageSnapshot;
  now?: Date;
};

export function lastLines(text: string, n: number): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-n).join('\n');
}

/** Removes every line of the task text (and long fragments of it) from `tail`. */
function stripTaskText(tail: string, taskText: string): string {
  let out = tail;
  for (const line of taskText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 12)) {
    out = out.split(line).join(' ').split(line.toLowerCase()).join(' ');
  }
  return out;
}

/** True when `window` (the match with some context) is simply a quote from the task text. */
function isFromTask(match: string, tail: string, taskText: string): boolean {
  const i = tail.toLowerCase().indexOf(match.toLowerCase());
  if (i < 0) return false;
  const ctx = tail.slice(Math.max(0, i - 25), i + match.length + 25).toLowerCase().replace(/\s+/g, ' ').trim();
  return taskText.toLowerCase().replace(/\s+/g, ' ').includes(ctx);
}

function windowReason(snap: UsageSnapshot | undefined, text: string): string {
  if (snap?.fiveHour && snap.fiveHour.usedPct >= 100) return '5-год ліміт';
  if (snap?.weekly && snap.weekly.usedPct >= 100) return 'тижневий ліміт';
  if (/week|7[- ]?day|weekly/i.test(text)) return 'тижневий ліміт';
  if (/5[- ]?h|five[- ]?hour|5-hour/i.test(text)) return '5-год ліміт';
  return 'ліміт використання';
}

/** Reset time from the snapshot (preferred) or from wording in the message. */
export function findResetTime(snap: UsageSnapshot | undefined, text: string, now: Date): string | undefined {
  const full = [snap?.fiveHour, snap?.weekly].filter((w): w is NonNullable<typeof w> => !!w && w.usedPct >= 100 && Date.parse(w.resetsAt) > now.getTime());
  if (full.length) return new Date(Math.max(...full.map((w) => Date.parse(w.resetsAt)))).toISOString();

  // ISO timestamp in the message (agy), or "...limit reached|<unix seconds>" (claude -p).
  const iso = /\b(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\b/.exec(text)?.[1];
  if (iso && Date.parse(iso) > now.getTime()) return new Date(iso).toISOString();
  const epoch = /\|\s*(\d{10})\b/.exec(text)?.[1];
  if (epoch && Number(epoch) * 1000 > now.getTime()) return new Date(Number(epoch) * 1000).toISOString();
  const words = /resets?\s+(?:at\s+)?([^.\n|]{3,60})/i.exec(text)?.[1];
  const parsed = words ? parseResetTime(words, now) : undefined;
  if (parsed && Date.parse(parsed) > now.getTime()) return parsed;

  const other = [snap?.fiveHour, snap?.weekly].filter((w): w is NonNullable<typeof w> => !!w && Date.parse(w.resetsAt) > now.getTime());
  return other.length ? new Date(Math.min(...other.map((w) => Date.parse(w.resetsAt)))).toISOString() : undefined;
}

export function detectLimit(input: DetectInput): LimitSignal {
  const now = input.now ?? new Date();
  const none: LimitSignal = { hit: false, reason: '' };
  const failed = !input.outcome.ok;
  if (!failed || input.timedOut || input.spawnError) return none;
  // Denied tools are a permissions problem, not a limit.
  if (input.outcome.denied.length > 0) return none;

  const raw = lastLines(`${input.stdout}\n${input.stderr}`, input.tailLines);
  const tail = stripTaskText(raw, input.taskText);

  for (const source of input.patterns) {
    let re: RegExp;
    try {
      re = new RegExp(source, 'i');
    } catch {
      continue; // an invalid user pattern must not break a run
    }
    const m = re.exec(tail);
    if (m && !isFromTask(m[0], tail, input.taskText)) {
      return {
        hit: true,
        reason: windowReason(input.snapshot, tail),
        resetsAt: findResetTime(input.snapshot, tail, now),
        evidence: `pattern /${source}/ matched "${maskSecrets(m[0])}"`,
      };
    }
  }

  // No wording matched, but the usage read right after the failure shows a full window.
  const snap = input.snapshot;
  if (snap && [snap.fiveHour, snap.weekly].some((w) => w && w.usedPct >= 100 && Date.parse(w.resetsAt) > now.getTime())) {
    return { hit: true, reason: windowReason(snap, ''), resetsAt: findResetTime(snap, '', now), evidence: 'snapshot ≥ 100%' };
  }
  return none;
}
