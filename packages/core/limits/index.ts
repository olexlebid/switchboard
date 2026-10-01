// Collects fresh snapshots from every adapter and persists them.
import { readState, saveSnapshot, updateState } from '../store';
import type { AgentId, SwitchboardConfig, UsageSnapshot } from '../types';
import { fetchAgyModelCount, fetchAgyUsage } from './agy';
import { fetchClaudeUsage } from './claude';

export type CollectResult = {
  agent: AgentId;
  snapshot?: UsageSnapshot;
  /** Set when the fresh read failed; `snapshot` then holds the last stored one (if any). */
  error?: string;
};

const MODEL_COUNT_TTL_MS = 6 * 3600_000;

/** `agy models` hits the network and rarely changes, so its count is cached for a few hours. */
async function agyModelCount(cfg: SwitchboardConfig, timeoutMs: number, now: Date): Promise<number | undefined> {
  const cached = readState().meta.agyModels;
  if (cached && now.getTime() - Date.parse(cached.at) < MODEL_COUNT_TTL_MS) return cached.count;
  const count = await fetchAgyModelCount(cfg.agents.agy, timeoutMs);
  if (count === undefined) return cached?.count;
  updateState((st) => { st.meta.agyModels = { count, at: now.toISOString() }; });
  return count;
}

export async function collectUsage(cfg: SwitchboardConfig, now = new Date(), only?: AgentId[]): Promise<CollectResult[]> {
  const timeoutMs = cfg.limits.fetchTimeoutSec * 1000;
  const jobs: Record<AgentId, () => Promise<UsageSnapshot>> = {
    claude: () => fetchClaudeUsage(cfg.agents.claude, timeoutMs, now),
    agy: async () => fetchAgyUsage(cfg.agents.agy, timeoutMs, now, await agyModelCount(cfg, timeoutMs, now)),
  };

  const ids = (Object.keys(jobs) as AgentId[]).filter((id) => !only || only.includes(id));
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
