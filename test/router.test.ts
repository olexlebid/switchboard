import { describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/core/config';
import { detectLimit, findResetTime, lastLines } from '../packages/core/limit-detect';
import type { AgentOverview } from '../packages/core/overview';
import { routeTask } from '../packages/core/router';
import type { AgentId, AgentStatus, UsageSnapshot } from '../packages/core/types';

const cfg = parseConfig(`
agents: { claude: { cmd: claude }, agy: { cmd: agy } }
routing:
  section: [claude, agy]
  research: [agy, claude]
  review: [agy, claude]
`);
const NOW = new Date('2026-10-01T12:00:00Z');
const at = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

function ov(agent: AgentId, status: AgentStatus, extra: Partial<AgentOverview> = {}): AgentOverview {
  return { agent, title: agent === 'claude' ? 'Claude Code' : 'Antigravity', status, statusLabel: status, reason: '', stale: false, ...extra };
}
const route = (agents: AgentOverview[], type: string, priority: 'normal' | 'high' = 'normal', extra: object = {}) =>
  routeTask(cfg, agents, { type, priority, ...extra }, NOW);

describe('routeTask', () => {
  it('takes the first agent of the matrix that is available', () => {
    expect(route([ov('claude', 'available'), ov('agy', 'available')], 'section')).toMatchObject({ action: 'run', agent: 'claude' });
    expect(route([ov('claude', 'available'), ov('agy', 'available')], 'research')).toMatchObject({ action: 'run', agent: 'agy' });
  });

  it('skips an exhausted agent', () => {
    expect(route([ov('claude', 'exhausted'), ov('agy', 'available')], 'section')).toMatchObject({ action: 'run', agent: 'agy' });
  });

  it('"мало" takes only short task types', () => {
    const agents = [ov('claude', 'low'), ov('agy', 'exhausted')];
    expect(route(agents, 'section')).toMatchObject({ action: 'run', agent: 'claude' });
    expect(route([ov('claude', 'low'), ov('agy', 'available')], 'research')).toMatchObject({ action: 'run', agent: 'agy' });
    expect(route([ov('claude', 'low'), ov('agy', 'exhausted')], 'research').action).not.toBe('run');
  });

  it('"резерв" takes only priority=high', () => {
    const agents = [ov('claude', 'reserve'), ov('agy', 'exhausted')];
    expect(route(agents, 'section', 'normal').action).not.toBe('run');
    expect(route(agents, 'section', 'high')).toMatchObject({ action: 'run', agent: 'claude' });
  });

  it('"невідомо" is tried only after an agent with a known status', () => {
    expect(route([ov('claude', 'unknown'), ov('agy', 'available')], 'section')).toMatchObject({ agent: 'agy' });
    expect(route([ov('claude', 'unknown'), ov('agy', 'low')], 'section')).toMatchObject({ agent: 'agy' });
    expect(route([ov('claude', 'unknown'), ov('agy', 'exhausted')], 'section')).toMatchObject({ agent: 'claude' });
    expect(route([ov('claude', 'unknown'), ov('agy', 'unknown')], 'section')).toMatchObject({ agent: 'claude' }); // matrix order
  });

  it('queues until the earliest reset when every agent is exhausted', () => {
    const agents = [ov('claude', 'exhausted', { exhaustedUntil: at(3) }), ov('agy', 'exhausted', { exhaustedUntil: at(1) })];
    expect(route(agents, 'section')).toMatchObject({ action: 'queue', until: at(1) });
  });

  it('queues a long task until the "мало" window of the only candidate resets', () => {
    const snap: UsageSnapshot = { agent: 'claude', source: 'cli', capturedAt: NOW.toISOString(), fiveHour: { usedPct: 70, resetsAt: at(2) } };
    const agents = [ov('claude', 'low', { snapshot: snap, fiveHourPct: 70 }), ov('agy', 'exhausted', { exhaustedUntil: at(5) })];
    expect(route(agents, 'research')).toMatchObject({ action: 'queue', until: at(2) });
  });

  it('a review is never done by the agent that wrote the code', () => {
    const both = [ov('claude', 'available'), ov('agy', 'available')];
    expect(route(both, 'review', 'normal', { authors: ['agy'] })).toMatchObject({ agent: 'claude' });
    expect(route(both, 'review', 'normal', { authors: ['claude'] })).toMatchObject({ agent: 'agy' });
    // author busy: the review waits instead of falling back to the author
    const busy = [ov('claude', 'exhausted', { exhaustedUntil: at(2) }), ov('agy', 'available')];
    expect(route(busy, 'review', 'normal', { authors: ['agy'] })).toMatchObject({ action: 'queue', until: at(2) });
    // both agents wrote code: no exclusion is possible
    expect(route(both, 'review', 'normal', { authors: ['agy', 'claude'] })).toMatchObject({ agent: 'agy' });
  });

  it('honours an explicit exclusion and reports unknown types', () => {
    expect(route([ov('claude', 'available'), ov('agy', 'available')], 'section', 'normal', { exclude: ['claude'] })).toMatchObject({ agent: 'agy' });
    expect(route([ov('claude', 'available')], 'nope').action).toBe('none');
  });
});

describe('detectLimit', () => {
  const failed = { ok: false, denied: [] as string[], error: 'is_error' };
  const base = { stdout: '', stderr: '', outcome: failed, exitCode: 1, timedOut: false, taskText: 'Create a footer', patterns: ['usage limit', 'quota', 'resets? at', '\\b429\\b'], tailLines: 15, now: NOW };

  it('detects a claude-style limit message and its epoch reset time', () => {
    const epoch = Math.floor(Date.parse(at(3)) / 1000);
    const r = detectLimit({ ...base, stdout: JSON.stringify({ is_error: true, result: `Claude AI usage limit reached|${epoch}` }) });
    expect(r).toMatchObject({ hit: true, resetsAt: at(3) });
  });

  it('detects an agy-style error and reads the ISO reset time', () => {
    const r = detectLimit({ ...base, stderr: `Error: RESOURCE_EXHAUSTED quota exceeded (429), resets at ${at(2)}`, patterns: ['RESOURCE_EXHAUSTED'] });
    expect(r).toMatchObject({ hit: true, resetsAt: at(2) });
  });

  it('understands "resets 3pm (Europe/Berlin)" wording', () => {
    const r = detectLimit({ ...base, stdout: "You've hit your usage limit · resets 3pm (Europe/Berlin)" });
    expect(r.hit).toBe(true);
    expect(r.resetsAt).toBe('2026-10-01T13:00:00.000Z');
  });

  it('uses the snapshot for the reason and reset time', () => {
    const snap: UsageSnapshot = { agent: 'claude', source: 'cli', capturedAt: NOW.toISOString(), weekly: { usedPct: 100, resetsAt: at(48) }, fiveHour: { usedPct: 20, resetsAt: at(1) } };
    const r = detectLimit({ ...base, stdout: 'usage limit reached', snapshot: snap });
    expect(r).toMatchObject({ hit: true, reason: 'тижневий ліміт', resetsAt: at(48) });
  });

  it('a successful run is never a limit hit, even if its text says "quota"', () => {
    const r = detectLimit({ ...base, outcome: { ok: true, denied: [] }, exitCode: 0, stdout: 'Done. Added quota docs, rate limit notes.' });
    expect(r.hit).toBe(false);
  });

  it('ignores wording that is just a quote of the task text', () => {
    const taskText = 'Document the API quota and rate limit handling in the footer';
    const r = detectLimit({ ...base, taskText, stdout: JSON.stringify({ is_error: true, result: `Cannot continue. Task says: ${taskText}` }) });
    expect(r.hit).toBe(false);
  });

  it('only the LAST lines count', () => {
    const early = ['usage limit reached', ...Array.from({ length: 30 }, (_, i) => `step ${i}`)].join('\n');
    expect(detectLimit({ ...base, stdout: early }).hit).toBe(false);
    expect(lastLines(early, 3).split('\n')).toHaveLength(3);
  });

  it('timeouts, spawn errors and permission denials are not limits', () => {
    expect(detectLimit({ ...base, stdout: 'usage limit', timedOut: true }).hit).toBe(false);
    expect(detectLimit({ ...base, stdout: 'usage limit', spawnError: true }).hit).toBe(false);
    expect(detectLimit({ ...base, stdout: 'usage limit', outcome: { ok: false, denied: ['Write'] } }).hit).toBe(false);
  });

  it('a full window in a fresh snapshot is enough without any wording', () => {
    const snap: UsageSnapshot = { agent: 'agy', source: 'cli', capturedAt: NOW.toISOString(), fiveHour: { usedPct: 100, resetsAt: at(4) } };
    expect(detectLimit({ ...base, stdout: 'something went wrong', snapshot: snap })).toMatchObject({ hit: true, reason: '5-год ліміт', resetsAt: at(4), evidence: 'snapshot ≥ 100%' });
  });

  it('skips invalid user patterns instead of crashing', () => {
    expect(detectLimit({ ...base, stdout: 'quota exceeded', patterns: ['(', 'quota'] }).hit).toBe(true);
  });

  it('findResetTime ignores times in the past', () => {
    expect(findResetTime(undefined, `resets at ${new Date(NOW.getTime() - 3600_000).toISOString()}`, NOW)).toBeUndefined();
  });
});
