import { describe, expect, it } from 'vitest';
import { UsageParseError } from '../packages/core/limits/claude';
import { parseAgyQuota, pickAgentWindow } from '../packages/core/limits/agy';
import { AGY_QUOTA } from './fixtures';

describe('parseAgyQuota', () => {
  it('parses the real /quota output into usedPct per group and window', () => {
    const g = parseAgyQuota(AGY_QUOTA);
    expect(g).toHaveLength(4);
    expect(g[0]).toEqual({ group: 'Gemini Models', window: 'weekly', usedPct: 0, resetsAt: '2026-10-08T05:45:23Z' });
    expect(g[3]).toEqual({ group: 'Claude and GPT models', window: 'fiveHour', usedPct: 0, resetsAt: '2026-10-01T10:57:03Z' });
  });

  it('converts remaining to used and keeps fractions', () => {
    const g = parseAgyQuota('Gemini Models   Five Hour Limit Remaining  99.64%  2026-10-01T10:45:23Z');
    expect(g[0]?.usedPct).toBe(0.36);
  });

  it('accepts tab-separated columns, CRLF line endings and ANSI colors (real output differs from the screenshot)', () => {
    const tabbed = [
      'Quota:',
      'Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-08T05:45:23Z',
      'Gemini Models\tFive Hour Limit Remaining\t99.64%\t2026-10-01T10:45:23Z',
      'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-01T10:57:03Z',
    ].join('\r\n');
    const g = parseAgyQuota(tabbed);
    expect(g.map((x) => [x.group, x.window, x.usedPct])).toEqual([
      ['Gemini Models', 'weekly', 0],
      ['Gemini Models', 'fiveHour', 0.36],
      ['Claude and GPT models', 'fiveHour', 0],
    ]);
    expect(parseAgyQuota('\x1b[32mGemini Models Weekly Limit Remaining 50% 2026-10-08T05:45:23Z\x1b[0m')[0]?.usedPct).toBe(50);
  });

  it('accepts single-space separation (what the failed run printed)', () => {
    const g = parseAgyQuota('Gemini Models Weekly Limit Remaining 100% 2026-10-08T05:45:23Z\nGemini Models Five Hour Limit Remaining 100% 2026-10-01T10:45:23Z');
    expect(g).toHaveLength(2);
    expect(g[0]?.group).toBe('Gemini Models');
  });

  it('throws when nothing matches', () => {
    expect(() => parseAgyQuota('Quota:\n(nothing)')).toThrow(UsageParseError);
  });
});

describe('pickAgentWindow', () => {
  it('uses the least used group as the agent-level window', () => {
    const groups = parseAgyQuota(`A  Weekly Limit Remaining  10%  2026-10-08T00:00:00Z
B  Weekly Limit Remaining  80%  2026-10-09T00:00:00Z`);
    expect(pickAgentWindow(groups, 'weekly')).toEqual({ usedPct: 20, resetsAt: '2026-10-09T00:00:00Z' });
    expect(pickAgentWindow(groups, 'fiveHour')).toBeUndefined();
  });
});
