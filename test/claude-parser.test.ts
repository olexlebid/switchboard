import { describe, expect, it } from 'vitest';
import { parseClaudeUsage, parseResetTime, UsageParseError } from '../packages/core/limits/claude';
import { CLAUDE_USAGE } from './fixtures';

const NOW = new Date('2026-10-01T05:53:00Z'); // 07:53 in Berlin

describe('parseClaudeUsage', () => {
  it('parses the real /usage output', () => {
    const u = parseClaudeUsage(CLAUDE_USAGE, NOW);
    expect(u.fiveHour).toEqual({ usedPct: 2, resetsAt: '2026-10-01T10:30:00.000Z' });
    expect(u.weekly).toEqual({ usedPct: 3, resetsAt: '2026-10-01T07:00:00.000Z' });
    expect(u.perGroup).toEqual([]);
  });

  it('keeps model-specific weekly lines as groups', () => {
    const u = parseClaudeUsage(
      `Current session: 10% used · resets 3pm (Europe/Berlin)
Current week (all models): 20% used · resets Oct 5 at 9am (Europe/Berlin)
Current week (Opus): 41.5% used · resets Oct 5 at 9am (Europe/Berlin)`,
      NOW,
    );
    expect(u.weekly?.usedPct).toBe(20);
    expect(u.perGroup).toEqual([{ group: 'Opus', window: 'weekly', usedPct: 41.5, resetsAt: '2026-10-05T07:00:00.000Z' }]);
  });

  it('throws on unrelated output so the caller can fall back to "unknown"', () => {
    expect(() => parseClaudeUsage('/usage is only available for subscription plans', NOW)).toThrow(UsageParseError);
    expect(() => parseClaudeUsage('', NOW)).toThrow(UsageParseError);
  });

  it('ignores a window that has no parseable reset time', () => {
    const u = parseClaudeUsage('Current session: 5% used\nCurrent week (all models): 3% used · resets Oct 8 at 9am (Europe/Berlin)', NOW);
    expect(u.fiveHour).toBeUndefined();
    expect(u.weekly?.usedPct).toBe(3);
  });
});

describe('parseResetTime', () => {
  it('uses today when only a time is given and it is still ahead', () => {
    expect(parseResetTime('12:30pm (Europe/Berlin)', NOW)).toBe('2026-10-01T10:30:00.000Z');
  });

  it('rolls to tomorrow when the time already passed today', () => {
    expect(parseResetTime('6am (Europe/Berlin)', NOW)).toBe('2026-10-02T04:00:00.000Z');
  });

  it('rolls a past month/day to next year', () => {
    const dec = new Date('2026-12-30T10:00:00Z');
    expect(parseResetTime('Jan 2 at 9am (Europe/Berlin)', dec)).toBe('2027-01-02T08:00:00.000Z');
  });

  it('honours an explicit year and handles 12am / 12pm', () => {
    expect(parseResetTime('Jan 5, 2027 at 12am (UTC)', NOW)).toBe('2027-01-05T00:00:00.000Z');
    expect(parseResetTime('Oct 1 at 12pm (UTC)', NOW)).toBe('2026-10-01T12:00:00.000Z');
  });

  it('returns undefined for an unknown zone or garbage', () => {
    expect(parseResetTime('9am (Mars/Olympus)', NOW)).toBeUndefined();
    expect(parseResetTime('soon', NOW)).toBeUndefined();
  });
});
