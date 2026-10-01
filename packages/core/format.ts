// Plain-text rendering of agent statuses for `sb status` (status is always text, never color-only).
import type { StatusResult } from './status';
import { STATUS_LABEL } from './status';
import { formatAge, formatDuration } from './time';
import type { AgentId, UsageSnapshot, UsageWindow } from './types';

export type StatusRow = {
  agent: AgentId;
  title: string;
  result: StatusResult;
  snapshot?: UsageSnapshot;
  /** Why a fresh read failed, if it did. */
  error?: string;
};

const COLORS = { available: 32, low: 33, reserve: 33, exhausted: 31, unknown: 90 } as const;

function bar(pct: number | undefined, width = 20): string {
  if (pct === undefined) return '·'.repeat(width);
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pctText(pct: number | undefined): string {
  if (pct === undefined) return '  — ';
  return `${(Math.round(pct * 10) / 10).toString().padStart(4)}%`;
}

function reset(w: UsageWindow | undefined, now: number): string {
  if (!w) return '';
  const left = Date.parse(w.resetsAt) - now;
  return left > 0 ? `↻ ${formatDuration(left)}` : 'скинуто';
}

export function renderStatus(rows: StatusRow[], now: Date, color: boolean): string {
  const paint = (s: string, code: number) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const t = now.getTime();
  const out: string[] = [];

  for (const row of rows) {
    const { result, snapshot } = row;
    const label = STATUS_LABEL[result.status].toUpperCase();
    const account = snapshot?.account ? `  (${snapshot.account})` : '';
    out.push(`${paint(`● ${label}`, COLORS[result.status])}  ${row.title}${account}`);
    out.push(`    ${result.reason}`);

    if (snapshot) {
      out.push(`    5 год    ${bar(result.fiveHourPct)} ${pctText(result.fiveHourPct)}  ${reset(snapshot.fiveHour, t)}`);
      out.push(`    тиждень  ${bar(result.weeklyPct)} ${pctText(result.weeklyPct)}  ${reset(snapshot.weekly, t)}`);
      for (const g of snapshot.perGroup ?? []) {
        const w = g.window === 'fiveHour' ? '5 год  ' : 'тиждень';
        const rst = g.resetsAt ? reset({ usedPct: g.usedPct, resetsAt: g.resetsAt }, t) : '';
        out.push(`      · ${g.group.padEnd(22)} ${w} ${pctText(g.usedPct)}  ${rst}`);
      }
      out.push(`    джерело: ${snapshot.source} · дані ${formatAge(t - Date.parse(snapshot.capturedAt))}`);
    } else {
      out.push('    немає збереженого знімка');
    }
    if (row.error) out.push(`    ${paint('! не вдалося оновити:', 33)} ${row.error}`);
    out.push('');
  }
  return out.join('\n');
}

/** Header counters like "1 доступно · 0 мало · 0 резерв · 1 вичерпано · 0 невідомо". */
export function renderSummary(rows: StatusRow[]): string {
  const order = ['available', 'low', 'reserve', 'exhausted', 'unknown'] as const;
  return order.map((s) => `${rows.filter((r) => r.result.status === s).length} ${STATUS_LABEL[s]}`).join(' · ');
}
