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
  /** agy only: user-level settings file where headless permission rules live. */
  settingsPath?: string;
};

export type Thresholds = {
  low: number;
  exhausted: number;
  weeklyReserve: number;
};

export type ManualCardConfig = { id: string; title: string };

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'failed' | 'done';

export type Task = {
  id: string;
  /** Free-text task description (what the agent must do). */
  text: string;
  type: string;
  project: string;
  priority: 'normal' | 'high';
  figma?: string;
  status: TaskStatus;
  branch: string;
  /** Branch the project was on when the task started; the runner returns to it. */
  baseBranch: string;
  baseSha: string;
  /** Agent of the latest run. */
  agent?: AgentId;
  runs: string[];
  createdAt: string;
  updatedAt: string;
  /** Short human-readable note about the last outcome. */
  note?: string;
  /** Set while the task waits for a limit reset (status "waiting"): earliest time to resume. */
  waitUntil?: string;
  /** Agent handovers so far, oldest first. */
  handoffs?: Handoff[];
  /** review tasks: id of the task whose code is reviewed (the reviewer must be another agent). */
  reviews?: string;
};

export type Handoff = { from: AgentId; to?: AgentId; at: string; reason: string };

export type Run = {
  id: string;
  taskId: string;
  agent: AgentId;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  status: 'running' | 'done' | 'blocked' | 'failed';
  logPath: string;
  /** Why it ended the way it did (denied tools, timeout, error text). */
  reason?: string;
  /** Agent's own final message (claude `result`, agy `response`), truncated. */
  summary?: string;
};

export type PermissionRules = { allow: string[]; deny: string[] };

export type SwitchboardConfig = {
  agents: Record<AgentId, AgentConfig>;
  limits: { staleAfterMin: number; fetchTimeoutSec: number };
  dashboard: { refreshTtlSec: number; manualCards: ManualCardConfig[] };
  thresholds: Thresholds;
  routing: Record<string, AgentId[]>;
  run: { timeoutMin: number };
  git: { pushBranches: boolean; protectedPaths: string[] };
  /** Per-agent permission rules and extra CLI args used for headless runs. */
  permissions: Record<AgentId, PermissionRules & { args: string[] }>;
  router: { shortTypes: string[] };
  limitDetection: { tailLines: number; patterns: string[] };
  handoff: { maxHandoffs: number };
  notifications: { enabled: boolean };
};
