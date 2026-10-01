// Antigravity (agy) usage: parses the text printed by `agy -p "/quota"`.
// Sample (recon row 16); columns may be separated by spaces OR a single tab:
//   Gemini Models           Weekly Limit Remaining     100%  2026-10-08T05:45:23Z
//   Claude and GPT models   Five Hour Limit Remaining  100%  2026-10-01T10:57:03Z
import { tmpdir } from 'node:os';
import { runCommand } from '../exec';
import type { AgentConfig, GroupWindow, UsageSnapshot, UsageWindow } from '../types';
import { snippet, stripAnsi, UsageParseError } from './claude';

const LINE_RE =
  /^\s*(.+?)\s+(Weekly|Five\s+Hour)\s+Limit\s+Remaining\s+(\d+(?:\.\d+)?)\s*%\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*$/gim;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseAgyQuota(text: string): GroupWindow[] {
  const groups: GroupWindow[] = [];
  for (const m of stripAnsi(text).matchAll(LINE_RE)) {
    const remaining = Number(m[3]);
    groups.push({
      group: m[1]!.trim(),
      window: m[2]!.toLowerCase().startsWith('weekly') ? 'weekly' : 'fiveHour',
      usedPct: round2(Math.min(100, Math.max(0, 100 - remaining))),
      resetsAt: m[4],
    });
  }
  if (groups.length === 0) throw new UsageParseError('no "... Limit Remaining" lines found in /quota output');
  return groups;
}

/**
 * Agent-level window = the group with the LEAST usage. A task can pick a model from any
 * group, so the agent counts as available while at least one group has room. The router
 * (stage 4) must still choose a model from a group that is not exhausted.
 */
export function pickAgentWindow(groups: GroupWindow[], window: GroupWindow['window']): UsageWindow | undefined {
  const rows = groups.filter((g) => g.window === window && g.resetsAt);
  if (rows.length === 0) return undefined;
  const best = rows.reduce((a, b) => (b.usedPct < a.usedPct ? b : a));
  return { usedPct: best.usedPct, resetsAt: best.resetsAt! };
}

export async function fetchAgyUsage(cfg: AgentConfig, timeoutMs: number, now = new Date()): Promise<UsageSnapshot> {
  const r = await runCommand(cfg.cmd, cfg.usageArgs, { timeoutMs, cwd: tmpdir() });
  if (r.spawnError) throw new Error(`cannot run "${cfg.cmd}": ${r.spawnError}`);
  if (r.timedOut) throw new Error(`"${cfg.cmd} ${cfg.usageArgs.join(' ')}" timed out`);

  let groups: GroupWindow[];
  try {
    groups = parseAgyQuota(r.stdout);
  } catch (e) {
    throw new UsageParseError(`${(e as Error).message}; got: ${snippet(r.stdout || r.stderr)}`);
  }
  return {
    agent: 'agy',
    fiveHour: pickAgentWindow(groups, 'fiveHour'),
    weekly: pickAgentWindow(groups, 'weekly'),
    perGroup: groups,
    source: 'cli',
    capturedAt: now.toISOString(),
  };
}
