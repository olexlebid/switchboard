import { describe, expect, it } from 'vitest';
import { formatDuration, tzOffsetMs, zonedToUtcMs } from '../packages/core/time';

describe('time zones', () => {
  it('knows Berlin offsets in summer and winter', () => {
    expect(tzOffsetMs(Date.UTC(2026, 6, 1), 'Europe/Berlin')).toBe(2 * 3600_000);
    expect(tzOffsetMs(Date.UTC(2026, 0, 1), 'Europe/Berlin')).toBe(3600_000);
  });

  it('converts Berlin wall-clock time to UTC', () => {
    expect(new Date(zonedToUtcMs(2026, 10, 1, 12, 30, 'Europe/Berlin')).toISOString()).toBe('2026-10-01T10:30:00.000Z');
    expect(new Date(zonedToUtcMs(2026, 12, 1, 9, 0, 'Europe/Berlin')).toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });

  it('handles the DST change day (clocks go back on 2026-10-25)', () => {
    expect(new Date(zonedToUtcMs(2026, 10, 25, 9, 0, 'Europe/Berlin')).toISOString()).toBe('2026-10-25T08:00:00.000Z');
  });

  it('formats durations', () => {
    expect(formatDuration(3 * 3600_000 + 36 * 60_000)).toBe('3 г 36 хв');
    expect(formatDuration(4 * 86400_000 + 2 * 3600_000)).toBe('4 д 2 г');
    expect(formatDuration(12 * 60_000)).toBe('12 хв');
    expect(formatDuration(10_000)).toBe('<1 хв');
  });
});
