import { describe, expect, it } from 'vitest';
import { computeStatus } from '../packages/core/status';
import type { UsageSnapshot } from '../packages/core/types';

const TH = { low: 60, exhausted: 90, weeklyReserve: 75 };
const NOW = new Date('2026-10-01T12:00:00Z');
const hours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

function snap(fiveHour: number | undefined, weekly: number | undefined, ageMin = 1): UsageSnapshot {
  return {
    agent: 'claude',
    source: 'cli',
    capturedAt: new Date(NOW.getTime() - ageMin * 60_000).toISOString(),
    fiveHour: fiveHour === undefined ? undefined : { usedPct: fiveHour, resetsAt: hours(3) },
    weekly: weekly === undefined ? undefined : { usedPct: weekly, resetsAt: hours(100) },
  };
}
const st = (s?: UsageSnapshot, mark?: Parameters<typeof computeStatus>[4]) => computeStatus(s, TH, 30, NOW, mark).status;

describe('computeStatus', () => {
  it('available below every threshold', () => expect(st(snap(10, 20))).toBe('available'));
  it('low when any window >= low', () => {
    expect(st(snap(60, 10))).toBe('low');
    expect(st(snap(10, 60))).toBe('low');
  });
  it('reserve when weekly >= weeklyReserve', () => expect(st(snap(10, 75))).toBe('reserve'));
  it('exhausted when any window >= exhausted', () => {
    expect(st(snap(90, 10))).toBe('exhausted');
    expect(st(snap(10, 95))).toBe('exhausted');
  });
  it('unknown without data, with stale data, or without windows', () => {
    expect(st(undefined)).toBe('unknown');
    expect(st(snap(10, 10, 31))).toBe('unknown');
    expect(st(snap(undefined, undefined))).toBe('unknown');
  });
  it('stale data that showed an exhausted window stays exhausted until the reset', () => {
    expect(st(snap(95, 10, 120))).toBe('exhausted');
  });
  it('a window past its reset counts as 0% used', () => {
    const s = snap(95, 10);
    s.fiveHour!.resetsAt = hours(-1);
    expect(st(s)).toBe('available');
  });
  it('a reactive mark wins while it is in the future, and expires afterwards', () => {
    const mark = { until: hours(2), reason: '5-год ліміт', since: hours(-1) };
    expect(st(snap(1, 1), mark)).toBe('exhausted');
    expect(st(snap(1, 1), { ...mark, until: hours(-0.1) })).toBe('available');
  });
});
