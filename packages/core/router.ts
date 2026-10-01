// Picks the agent for a task from the routing matrix and the agents' current statuses.
// Pure function: the caller supplies the status overview, so it is easy to test.
import type { AgentOverview } from './overview';
import type { AgentId, SwitchboardConfig, UsageWindow } from './types';

export type RouteInput = {
  type: string;
  priority: 'normal' | 'high';
  /** Agents that wrote code for the task under review (review tasks must use a different one). */
  authors?: AgentId[];
  /** Agents that must not be picked (e.g. the one that just hit its limit). */
  exclude?: AgentId[];
};

export type RouteDecision =
  | { action: 'run'; agent: AgentId; reason: string }
  | { action: 'queue'; until: string; reason: string }
  | { action: 'none'; reason: string };

type Eligibility = { ok: true } | { ok: false; why: string };

function eligible(a: AgentOverview, type: string, priority: 'normal' | 'high', shortTypes: string[]): Eligibility {
  switch (a.status) {
    case 'exhausted':
      return { ok: false, why: `${a.title}: ліміт вичерпано` };
    case 'reserve':
      return priority === 'high' ? { ok: true } : { ok: false, why: `${a.title}: тижневий резерв, лише priority=high` };
    case 'low':
      return shortTypes.includes(type) ? { ok: true } : { ok: false, why: `${a.title}: мало ліміту, лише короткі задачі (${shortTypes.join(', ')})` };
    default:
      return { ok: true };
  }
}

/** When a blocked agent becomes usable again: the latest reset among the windows that block it. */
export function blockedUntil(a: AgentOverview, cfg: Pick<SwitchboardConfig, 'thresholds'>): number | undefined {
  const th = cfg.thresholds;
  const snap = a.snapshot;
  const times: number[] = [];
  const add = (w: UsageWindow | undefined, pct: number | undefined, limit: number) => {
    if (w && pct !== undefined && pct >= limit) times.push(Date.parse(w.resetsAt));
  };
  if (a.status === 'exhausted') {
    if (a.exhaustedUntil) times.push(Date.parse(a.exhaustedUntil));
    add(snap?.fiveHour, a.fiveHourPct, th.exhausted);
    add(snap?.weekly, a.weeklyPct, th.exhausted);
  } else if (a.status === 'reserve') {
    add(snap?.weekly, a.weeklyPct, th.weeklyReserve);
  } else if (a.status === 'low') {
    add(snap?.fiveHour, a.fiveHourPct, th.low);
    add(snap?.weekly, a.weeklyPct, th.low);
  }
  return times.length ? Math.max(...times) : undefined;
}

export function routeTask(cfg: SwitchboardConfig, agents: AgentOverview[], input: RouteInput, now = new Date()): RouteDecision {
  const order = cfg.routing[input.type];
  if (!order) return { action: 'none', reason: `невідомий тип задачі "${input.type}"` };

  // A review must come from a different agent than the author.
  const excluded = new Set<AgentId>(input.exclude ?? []);
  const authors = new Set(input.authors ?? []);
  const reviewNote: string[] = [];
  if (input.type === 'review' && authors.size === 1) {
    for (const a of authors) {
      excluded.add(a);
      reviewNote.push(`рев'ю не може робити автор (${a})`);
    }
  }

  const candidates = order.filter((id) => !excluded.has(id));
  if (candidates.length === 0) return { action: 'none', reason: ['немає допустимих агентів', ...reviewNote].join('; ') };

  const byId = new Map(agents.map((a) => [a.agent, a]));
  const considered = candidates.map((id) => {
    const a = byId.get(id);
    return { id, a, e: a ? eligible(a, input.type, input.priority, cfg.router.shortTypes) : ({ ok: false, why: `${id}: немає даних` } as Eligibility) };
  });

  const usable = considered.filter((c) => c.e.ok && c.a);
  if (usable.length > 0) {
    // An agent with unknown status is tried only after agents whose status is known.
    const known = usable.filter((c) => c.a!.status !== 'unknown');
    const pick = (known[0] ?? usable[0])!;
    const why = [`${pick.a!.title}: ${pick.a!.statusLabel}`, ...reviewNote];
    if (pick.a!.status === 'unknown' || known.length === 0) why.push('статус невідомий, інших агентів з відомим статусом немає');
    return { action: 'run', agent: pick.id, reason: why.join('; ') };
  }

  // Nobody can take it now: queue until the earliest moment one of the candidates is free again.
  const waits = considered
    .map((c) => (c.a ? blockedUntil(c.a, cfg) : undefined))
    .filter((t): t is number => t !== undefined && t > now.getTime());
  const whyNot = considered.map((c) => (c.e.ok ? '' : c.e.why)).filter(Boolean);
  if (waits.length > 0) {
    return { action: 'queue', until: new Date(Math.min(...waits)).toISOString(), reason: [...whyNot, ...reviewNote].join('; ') };
  }
  return { action: 'none', reason: [...whyNot, 'час скидання невідомий', ...reviewNote].join('; ') };
}
