// One usage window: label, progress bar, percent and reset countdown (all as text too, for screen readers).
import { formatDuration } from '@core/time';
import type { Thresholds } from '@core/types';
import { Progress } from '@/components/ui/progress';
import { cn } from 'cn';

type Props = {
  label: string;
  /** Percent used, 0..100; undefined = no data. */
  pct?: number;
  resetsAt?: string;
  thresholds: Thresholds;
  now: number;
  dim?: boolean;
};

export function UsageMeter({ label, pct, resetsAt, thresholds, now, dim }: Props) {
  const known = pct !== undefined;
  const rounded = known ? Math.round(pct * 10) / 10 : 0;
  const bar = !known ? '' : rounded >= thresholds.exhausted ? '[&>div]:bg-destructive' : rounded >= thresholds.low ? '[&>div]:bg-warning' : '[&>div]:bg-success';
  const left = resetsAt ? Date.parse(resetsAt) - now : undefined;
  const countdown = left === undefined ? '' : left > 0 ? formatDuration(left) : 'скинуто';
  const text = known ? `${rounded}% використано${countdown ? `, скидання через ${countdown}` : ''}` : 'немає даних';

  return (
    <div className={cn('grid grid-cols-[4.5rem_1fr_2.75rem_5.5rem] items-center gap-2 text-sm', dim && 'opacity-60')}>
      <span className="text-muted-foreground" id={`${label}-${resetsAt ?? ''}`}>{label}</span>
      <Progress value={known ? Math.min(100, Math.max(0, rounded)) : 0} aria-label={`${label}: ${text}`} aria-valuetext={text} className={cn('h-2', bar)} />
      <span className="text-right tabular-nums">{known ? `${rounded}%` : '—'}</span>
      <span className="truncate text-xs text-muted-foreground" title={countdown ? `скидання через ${countdown}` : undefined}>
        {countdown && <><span aria-hidden="true">↻ </span>{countdown}</>}
      </span>
    </div>
  );
}
