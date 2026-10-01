// Collects fresh snapshots from every adapter and persists them.
import { readState, saveSnapshot } from '../store';
import type { AgentId, SwitchboardConfig, UsageSnapshot } from '../types';
import { fetchAgyUsage } from './agy';
import { fetchClaudeUsage } from './claude';

export type CollectResult = {
  agent: AgentId;
  snapshot?: UsageSnapshot;
  /** Set when the fresh read failed; `snapshot` then holds the last stored one (if any). */
  error?: string;
};

export async function collectUsage(cfg: SwitchboardConfig, now = new Date()): Promise<CollectResult[]> {
  const timeoutMs = cfg.limits.fetchTimeoutSec * 1000;
  const jobs: Record<AgentId, () => Promise<UsageSnapshot>> = {
    claude: () => fetchClaudeUsage(cfg.agents.claude, timeoutMs, now),
    agy: () => fetchAgyUsage(cfg.agents.agy, timeoutMs, now),
  };

  const ids = Object.keys(jobs) as AgentId[];
  const settled = await Promise.allSettled(ids.map((id) => jobs[id]()));

  return ids.map((agent, i): CollectResult => {
    const r = settled[i]!;
    if (r.status === 'fulfilled') {
      saveSnapshot(r.value);
      return { agent, snapshot: r.value };
    }
    return { agent, snapshot: readState().snapshots[agent], error: (r.reason as Error).message };
  });
}
