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
