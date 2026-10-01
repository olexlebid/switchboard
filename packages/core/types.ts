// Shared types for limits, statuses and config.

export type AgentId = 'claude' | 'agy';

export type UsageWindow = {
  /** Percent of the window already used, 0..100. */
  usedPct: number;
  /** ISO UTC time when the window resets. */
  resetsAt: string;
};

/** Quota of one window of one model group (agy shares limits inside a group). */
export type GroupWindow = {
  group: string;
  window: 'fiveHour' | 'weekly';
  usedPct: number;
  resetsAt?: string;
};

/** Normalized usage snapshot returned by every limits adapter. */
export type UsageSnapshot = {
  agent: AgentId;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  perGroup?: GroupWindow[];
  /** Masked account label, e.g. "ole…@gmail.com". */
  account?: string;
  /** Number of models the agent offers (agy: from `agy models`, cached). */
  modelCount?: number;
  source: 'statusline' | 'cli' | 'local-logs' | 'reactive' | 'manual';
  /** ISO time the numbers were read. */
  capturedAt: string;
};

export type AgentStatus = 'available' | 'low' | 'reserve' | 'exhausted' | 'unknown';

/** Reactive "agent is out of quota" mark, set when a run hits a limit. */
export type ExhaustedMark = {
  until: string;
  reason: string;
  since: string;
};

export type AgentConfig = {
  cmd: string;
  headlessArgs: string[];
  usageArgs: string[];
  models: string[];
};

export type Thresholds = {
  low: number;
  exhausted: number;
  weeklyReserve: number;
};

export type ManualCardConfig = { id: string; title: string };

export type SwitchboardConfig = {
  agents: Record<AgentId, AgentConfig>;
  limits: { staleAfterMin: number; fetchTimeoutSec: number };
  dashboard: { refreshTtlSec: number; manualCards: ManualCardConfig[] };
  thresholds: Thresholds;
  routing: Record<string, AgentId[]>;
};
