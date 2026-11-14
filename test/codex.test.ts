// ChatGPT (Codex CLI): argv, JSONL output, rate-limit records from the local session logs, config defaults.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../packages/core/config';
import { interpretOutput } from '../packages/core/interpret';
import { detectLimit } from '../packages/core/limit-detect';
import { fetchCodexUsage, parseCodexRateLimits, toSnapshot } from '../packages/core/limits/codex';
import { getModels } from '../packages/core/models';
import { buildAgentArgs } from '../packages/core/runner';
import { computeStatus } from '../packages/core/status';
import { isAgentId } from '../packages/core/types';

const cfg = parseConfig('agents: { claude: { cmd: c }, agy: { cmd: a } }');
const rules = cfg.permissions.codex;

describe('config', () => {
  it('fills in codex for configs written before it existed', () => {
    expect(cfg.agents.codex).toMatchObject({ cmd: 'codex', headlessArgs: ['exec', '--json'], usageArgs: [] });
    expect(rules.args).toEqual(['--sandbox', 'workspace-write']);
    expect(isAgentId('codex')).toBe(true);
    expect(isAgentId('gpt')).toBe(false);
  });

  it('requires headlessArgs to start with exec and accepts codex in routing', () => {
    expect(() => parseConfig('agents: { claude: { cmd: c }, agy: { cmd: a }, codex: { cmd: x, headlessArgs: ["-p"] } }')).toThrow(/must start with "exec"/);
    expect(parseConfig('agents: { claude: { cmd: c }, agy: { cmd: a } }\nrouting: { qa: [claude, codex] }').routing.qa).toEqual(['claude', 'codex']);
  });

  it('lists the configured models in the picker', () => {
    const c = parseConfig('agents: { claude: { cmd: c }, agy: { cmd: a }, codex: { cmd: x, models: [m-1] } }');
    expect(getModels(c).codex).toEqual([{ id: 'm-1', label: 'm-1' }]);
  });
});

describe('buildAgentArgs', () => {
  it('puts flags before the prompt and the sandbox mode from the rules', () => {
    expect(buildAgentArgs('codex', cfg.agents.codex, 'do it', rules, 60_000)).toEqual(['exec', '--json', '--sandbox', 'workspace-write', 'do it']);
  });

  it('resumes a thread and passes the model', () => {
    expect(buildAgentArgs('codex', cfg.agents.codex, 'more', rules, 60_000, '0199a213-81c0-7800-8aa1-bbab2a035a53', 'm-1')).toEqual([
      'exec', '--json', '--sandbox', 'workspace-write', '--model', 'm-1', 'resume', '0199a213-81c0-7800-8aa1-bbab2a035a53', 'more',
    ]);
  });

  it('never lets a prompt or a model that starts with "-" become a flag', () => {
    const args = buildAgentArgs('codex', cfg.agents.codex, '--yolo', rules, 60_000, undefined, '--yolo');
    expect(args).not.toContain('--model');
    expect(args.at(-1)).toBe('\n--yolo');
  });
});

describe('interpretOutput (codex)', () => {
  const j = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n');

  it('takes the thread id and the last agent message of a completed turn', () => {
    const out = j(
      { type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Repo contains docs.' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    );
    expect(interpretOutput('codex', out, '')).toMatchObject({ ok: true, denied: [], reply: 'Repo contains docs.', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
  });

  it('fails on turn.failed and reports its message', () => {
    const out = j({ type: 'thread.started', thread_id: 'abcd-1234' }, { type: 'turn.failed', error: { message: "You've hit your usage limit." } });
    expect(interpretOutput('codex', out, '')).toMatchObject({ ok: false, error: "You've hit your usage limit." });
  });

  it('ignores a non-fatal error event when the turn completed, but not when it did not', () => {
    const done = j({ type: 'error', message: 'Reconnecting... 1/5' }, { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }, { type: 'turn.completed' });
    expect(interpretOutput('codex', done, '').ok).toBe(true);
    const broken = j({ type: 'error', message: 'stream closed' });
    expect(interpretOutput('codex', broken, '')).toMatchObject({ ok: false, error: 'stream closed' });
  });

  it('reports stderr when there are no JSON events at all', () => {
    expect(interpretOutput('codex', '', 'codex: not logged in\n')).toMatchObject({ ok: false, error: 'codex: not logged in' });
  });

  it('a failed turn with a usage-limit message counts as a limit hit', () => {
    const stdout = j({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 2030-01-01T10:00:00Z." } });
    const outcome = interpretOutput('codex', stdout, '');
    const sig = detectLimit({ stdout, stderr: '', outcome, exitCode: 1, timedOut: false, taskText: 'build a footer', patterns: cfg.limitDetection.patterns, tailLines: 15, now: new Date('2029-12-31T00:00:00Z') });
    expect(sig.hit).toBe(true);
    expect(sig.resetsAt).toBe('2030-01-01T10:00:00.000Z');
  });
});

describe('rate limits from the local session logs', () => {
  const rec = (timestamp: string, rate_limits: object) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits } });
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sb-codex-')); process.env.CODEX_HOME = home; });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('maps the 5-hour and weekly windows and keeps the time of the record', () => {
    const text = [
      'cut line without json {',
      rec('2030-01-01T09:00:00.000Z', { primary: { used_percent: 1, window_minutes: 300, resets_at: 1893488400 }, secondary: { used_percent: 2, window_minutes: 10080, resets_at: 1893900000 } }),
      rec('2030-01-01T09:30:00.000Z', { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1893488400 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1893900000 } }),
    ].join('\n');
    const snap = toSnapshot(parseCodexRateLimits(text)!);
    expect(snap).toMatchObject({ agent: 'codex', source: 'local-logs', capturedAt: '2030-01-01T09:30:00.000Z' });
    expect(snap.fiveHour).toEqual({ usedPct: 12.5, resetsAt: new Date(1893488400 * 1000).toISOString() });
    expect(snap.weekly).toEqual({ usedPct: 3, resetsAt: new Date(1893900000 * 1000).toISOString() });
  });

  it('understands the older resets_in_seconds form and orders windows by length, not position', () => {
    const text = rec('2030-01-01T00:00:00.000Z', { primary: { used_percent: 40, window_minutes: 10080, resets_in_seconds: 3600 }, secondary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 60 } });
    const snap = toSnapshot(parseCodexRateLimits(text)!);
    expect(snap.weekly).toEqual({ usedPct: 40, resetsAt: '2030-01-01T01:00:00.000Z' });
    expect(snap.fiveHour).toEqual({ usedPct: 5, resetsAt: '2030-01-01T00:01:00.000Z' });
  });

  it('returns nothing for logs without rate limits', () => {
    expect(parseCodexRateLimits('{"type":"event_msg","payload":{"type":"agent_message"}}\n')).toBeUndefined();
  });

  it('reads the newest rollout file under CODEX_HOME and explains when there is none', async () => {
    await expect(fetchCodexUsage()).rejects.toThrow(/no rate-limit records/);
    const dir = join(home, 'sessions', '2030', '01', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rollout-2030-01-01T09-00-00-aaa.jsonl'), `${rec('2030-01-01T09:00:00.000Z', { primary: { used_percent: 7, window_minutes: 300, resets_at: 1893488400 } })}\n`);
    const snap = await fetchCodexUsage();
    expect(snap.fiveHour?.usedPct).toBe(7);
    expect(snap.weekly).toBeUndefined();
  });

  it('stays exhausted until the reset, and is "unknown" (stale data) afterwards instead of pretending to be free', () => {
    // record at 08:00Z; the 5-hour window resets at 09:00Z (epoch 1893488400)
    const snap = toSnapshot(parseCodexRateLimits(rec('2030-01-01T08:00:00.000Z', { primary: { used_percent: 95, window_minutes: 300, resets_at: 1893488400 } }))!);
    expect(computeStatus(snap, cfg.thresholds, 30, new Date('2030-01-01T08:10:00Z')).status).toBe('exhausted');
    expect(computeStatus(snap, cfg.thresholds, 30, new Date('2030-01-01T09:30:00Z')).status).toBe('unknown');
  });
});
