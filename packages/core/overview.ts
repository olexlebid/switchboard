// Single source of truth for "what to show": used by `sb status`, the dashboard page and /api/status.
import { loadConfig } from './config';
import { collectUsage } from './limits';
import { computeStatus, STATUS_LABEL } from './status';
import { readState } from './store';
import type { AgentId, AgentStatus, SwitchboardConfig, Thresholds, UsageSnapshot } from './types';

export const AGENT_TITLES: Record<AgentId, string> = { claude: 'Claude Code', agy: 'Antigravity' };
const AGENT_ORDER: AgentId[] = ['claude', 'agy'];

export type AgentOverview = {
  agent: AgentId;
  title: string;
  status: AgentStatus;
  statusLabel: string;
  reason: string;
  snapshot?: UsageSnapshot;
  ageMs?: number;
  /** True when the data is older than limits.staleAfterMin (bars are dimmed in the UI). */
  stale: boolean;
  fiveHourPct?: number;
  weeklyPct?: number;
  /** Why the last fresh read failed, if it did. */
  error?: string;
};

export type ManualCardOverview = { id: string; title: string; state?: 'available' | 'exhausted'; at?: string };

export type Overview = {
  generatedAt: string;
  /** When limits were last read from the CLIs by this process (undefined if never). */
  refreshedAt?: string;
  summary: Record<AgentStatus, number>;
  thresholds: Thresholds;
  agents: AgentOverview[];
  manual: ManualCardOverview[];
};

export type RefreshMode = 'cached' | 'if-stale' | 'force';

// Process-wide refresh bookkeeping: one CLI round at a time, shared by all requests.
let lastRefreshAt = 0;
let lastErrors: Partial<Record<AgentId, string>> = {};
let inflight: Promise<void> | null = null;

async function refresh(cfg: SwitchboardConfig): Promise<void> {
  if (!inflight) {
    inflight = collectUsage(cfg)
      .then((results) => {
        lastErrors = {};
        for (const r of results) if (r.error) lastErrors[r.agent] = r.error;
        lastRefreshAt = Date.now();
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function buildOverview(cfg: SwitchboardConfig, now = new Date(), errors: Partial<Record<AgentId, string>> = {}): Overview {
  const state = readState();
  const agents = AGENT_ORDER.map((agent): AgentOverview => {
    const snapshot = state.snapshots[agent];
    const r = computeStatus(snapshot, cfg.thresholds, cfg.limits.staleAfterMin, now, state.exhausted[agent]);
    return {
      agent,
      title: AGENT_TITLES[agent],
      status: r.status,
      statusLabel: STATUS_LABEL[r.status],
      reason: r.reason,
      snapshot,
      ageMs: r.ageMs,
      stale: r.ageMs !== undefined && r.ageMs > cfg.limits.staleAfterMin * 60_000,
      fiveHourPct: r.fiveHourPct,
      weeklyPct: r.weeklyPct,
      error: errors[agent],
    };
  });

  const summary: Record<AgentStatus, number> = { available: 0, low: 0, reserve: 0, exhausted: 0, unknown: 0 };
  for (const a of agents) summary[a.status]++;

  return {
    generatedAt: now.toISOString(),
    refreshedAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : undefined,
    summary,
    thresholds: cfg.thresholds,
    agents,
    manual: cfg.dashboard.manualCards.map((c) => ({ ...c, ...state.manual[c.id] })),
  };
}

/**
 * Builds the overview. 'if-stale' re-reads the CLIs only when the last read is older than
 * dashboard.refreshTtlSec; 'force' always re-reads; 'cached' never runs a CLI.
 */
export async function getOverview(mode: RefreshMode = 'if-stale', cfg = loadConfig()): Promise<Overview> {
  const ttlMs = cfg.dashboard.refreshTtlSec * 1000;
  if (mode === 'force' || (mode === 'if-stale' && Date.now() - lastRefreshAt > ttlMs)) await refresh(cfg);
  return buildOverview(cfg, new Date(), lastErrors);
}
