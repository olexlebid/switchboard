// Turns a usage snapshot into one of the five agent statuses (spec table).
import type { AgentStatus, ExhaustedMark, Thresholds, UsageSnapshot, UsageWindow } from './types';

export type StatusResult = {
  status: AgentStatus;
  /** Short human-readable reason, in Ukrainian (shown in CLI/dashboard). */
  reason: string;
  /** Age of the data in ms, undefined when there is no snapshot. */
  ageMs?: number;
  /** Effective percent used per window after treating already-reset windows as 0. */
  fiveHourPct?: number;
  weeklyPct?: number;
};

/** A window whose reset time has passed no longer counts: its usage is back to zero. */
function effectivePct(w: UsageWindow | undefined, now: number): number | undefined {
  if (!w) return undefined;
  return Date.parse(w.resetsAt) <= now ? 0 : w.usedPct;
}

export function computeStatus(
  snap: UsageSnapshot | undefined,
  th: Thresholds,
  staleAfterMin: number,
  now: Date,
  reactive?: ExhaustedMark,
): StatusResult {
  const t = now.getTime();

  if (reactive && Date.parse(reactive.until) > t) {
    return { status: 'exhausted', reason: `ліміт вичерпано (${reactive.reason})` };
  }
  if (!snap) return { status: 'unknown', reason: 'даних немає' };

  const ageMs = t - Date.parse(snap.capturedAt);
  const fiveHourPct = effectivePct(snap.fiveHour, t);
  const weeklyPct = effectivePct(snap.weekly, t);
  const base = { ageMs, fiveHourPct, weeklyPct };
  const pcts = [fiveHourPct, weeklyPct].filter((p): p is number => p !== undefined);

  // Usage never drops before the reset, so an exhausted window stays exhausted even if data is old.
  if (pcts.some((p) => p >= th.exhausted)) return { ...base, status: 'exhausted', reason: `вікно ≥ ${th.exhausted}%` };
  if (pcts.length === 0) return { ...base, status: 'unknown', reason: 'немає даних про вікна' };
  if (ageMs > staleAfterMin * 60_000) return { ...base, status: 'unknown', reason: `дані застаріли (> ${staleAfterMin} хв)` };
  if (weeklyPct !== undefined && weeklyPct >= th.weeklyReserve) {
    return { ...base, status: 'reserve', reason: `тиждень ≥ ${th.weeklyReserve}%` };
  }
  if (pcts.some((p) => p >= th.low)) return { ...base, status: 'low', reason: `вікно ≥ ${th.low}%` };
  return { ...base, status: 'available', reason: 'ліміти в нормі' };
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  available: 'доступно',
  low: 'мало',
  reserve: 'резерв',
  exhausted: 'вичерпано',
  unknown: 'невідомо',
};
