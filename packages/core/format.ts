// Plain-text rendering of agent statuses for `sb status` (status is always text, never color-only).
import type { AgentOverview, Overview } from './overview';
import { STATUS_LABEL } from './status';
import { formatAge, formatDuration } from './time';
import type { UsageWindow } from './types';

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

export function renderStatus(rows: AgentOverview[], now: Date, color: boolean): string {
  const paint = (s: string, code: number) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const t = now.getTime();
  const out: string[] = [];

  for (const row of rows) {
    const { snapshot } = row;
    const account = snapshot?.account ? `  (${snapshot.account})` : '';
    out.push(`${paint(`● ${row.statusLabel.toUpperCase()}`, COLORS[row.status])}  ${row.title}${account}`);
    out.push(`    ${row.reason}`);

    if (snapshot) {
      out.push(`    5 год    ${bar(row.fiveHourPct)} ${pctText(row.fiveHourPct)}  ${reset(snapshot.fiveHour, t)}`);
      out.push(`    тиждень  ${bar(row.weeklyPct)} ${pctText(row.weeklyPct)}  ${reset(snapshot.weekly, t)}`);
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
export function renderSummary(overview: Pick<Overview, 'summary'>): string {
  const order = ['available', 'low', 'reserve', 'exhausted', 'unknown'] as const;
  return order.map((s) => `${overview.summary[s]} ${STATUS_LABEL[s]}`).join(' · ');
}
