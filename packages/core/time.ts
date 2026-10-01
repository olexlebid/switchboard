// Time zone helpers (no date library) and short human-readable durations.

/** Offset of `tz` from UTC at the given instant, in ms (positive = ahead of UTC). */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a wall-clock time in `tz` to a UTC timestamp. Day overflow (d+1) is allowed. */
export function zonedToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes handle the case where the offset differs around a DST change.
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

/** Calendar date of an instant as seen in `tz`. */
export function zonedDate(ms: number, tz: string): { y: number; mo: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: +p.year!, mo: +p.month!, d: +p.day! };
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "3 г 36 хв", "4 д 2 г", "12 хв", "<1 хв". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0 хв';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '<1 хв';
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const mins = min % 60;
  if (days > 0) return `${days} д ${hours} г`;
  if (hours > 0) return `${hours} г ${mins} хв`;
  return `${mins} хв`;
}

/** "2 хв тому", "3 г 5 хв тому". */
export function formatAge(ms: number): string {
  if (ms < 60_000) return 'щойно';
  return `${formatDuration(ms)} тому`;
}
