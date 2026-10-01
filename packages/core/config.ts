// Loads switchboard.config.yaml and validates the parts the code relies on.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { AgentConfig, AgentId, SwitchboardConfig } from './types';

const AGENT_IDS: AgentId[] = ['claude', 'agy'];

/** Regex sources (case-insensitive) searched in the LAST lines of an agent's output. */
export const DEFAULT_LIMIT_PATTERNS = [
  'usage limit', 'rate limit', 'quota', '\\b429\\b', 'resets? at', 'limit reached',
  'hit your .{0,20}limit', 'RESOURCE_EXHAUSTED', 'too many requests', 'limit will reset',
];

/**
 * Config lookup order: SB_CONFIG, then walking up from the working directory (works for the
 * bundled dashboard server, where import.meta.url no longer points into the repo), then the
 * repo root relative to this source file.
 */
export function defaultConfigPath(): string {
  if (process.env.SB_CONFIG) return process.env.SB_CONFIG;
  for (let dir = resolve(process.cwd()); ; dir = dirname(dir)) {
    const candidate = join(dir, 'switchboard.config.yaml');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  return fileURLToPath(new URL('../../switchboard.config.yaml', import.meta.url));
}

function fail(msg: string): never {
  throw new Error(`Invalid config: ${msg}`);
}

function num(v: unknown, name: string, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a number`);
  return v;
}

function strArray(v: unknown, name: string, fallback: string[]): string[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(`${name} must be a list of strings`);
  return v as string[];
}

export function parseConfig(text: string): SwitchboardConfig {
  const raw = (parse(text) ?? {}) as Record<string, any>;

  const agents = {} as Record<AgentId, AgentConfig>;
  for (const id of AGENT_IDS) {
    const a = raw.agents?.[id];
    if (!a || typeof a.cmd !== 'string') fail(`agents.${id}.cmd is required`);
    agents[id] = {
      cmd: a.cmd,
      headlessArgs: strArray(a.headlessArgs, `agents.${id}.headlessArgs`, ['-p']),
      usageArgs: strArray(a.usageArgs, `agents.${id}.usageArgs`, id === 'claude' ? ['-p', '/usage'] : ['-p', '/quota']),
      models: strArray(a.models, `agents.${id}.models`, []),
      settingsPath: typeof a.settingsPath === 'string' ? a.settingsPath : undefined,
    };
  }

  const t = raw.thresholds ?? {};
  const thresholds = {
    low: num(t.low, 'thresholds.low', 60),
    exhausted: num(t.exhausted, 'thresholds.exhausted', 90),
    weeklyReserve: num(t.weeklyReserve, 'thresholds.weeklyReserve', 75),
  };
  if (thresholds.low >= thresholds.exhausted) fail('thresholds.low must be below thresholds.exhausted');

  const routing: Record<string, AgentId[]> = {};
  for (const [type, list] of Object.entries(raw.routing ?? {})) {
    if (!Array.isArray(list) || list.some((x) => !AGENT_IDS.includes(x as AgentId))) {
      fail(`routing.${type} must be a list of ${AGENT_IDS.join(' | ')}`);
    }
    routing[type] = list as AgentId[];
  }

  const permissions = {} as SwitchboardConfig['permissions'];
  for (const id of AGENT_IDS) {
    const p = raw.permissions?.[id] ?? {};
    permissions[id] = {
      allow: strArray(p.allow, `permissions.${id}.allow`, []),
      deny: strArray(p.deny, `permissions.${id}.deny`, []),
      args: strArray(p.args, `permissions.${id}.args`, []),
    };
  }
  for (const id of AGENT_IDS) {
    if (agents[id].headlessArgs[0] !== '-p') fail(`agents.${id}.headlessArgs must start with "-p"`);
  }
  const l = raw.limits ?? {};
  const d = raw.dashboard ?? {};
  const manualCards = Array.isArray(d.manualCards)
    ? d.manualCards.map((c: any, i: number) => {
        if (!c || typeof c.id !== 'string' || typeof c.title !== 'string') fail(`dashboard.manualCards[${i}] needs id and title`);
        return { id: c.id, title: c.title };
      })
    : [{ id: 'gemini-chat', title: 'Gemini (чат)' }, { id: 'stitch', title: 'Stitch' }];
  return {
    agents,
    limits: {
      staleAfterMin: num(l.staleAfterMin, 'limits.staleAfterMin', 30),
      fetchTimeoutSec: num(l.fetchTimeoutSec, 'limits.fetchTimeoutSec', 30),
    },
    dashboard: { refreshTtlSec: num(d.refreshTtlSec, 'dashboard.refreshTtlSec', 60), manualCards, projects: strArray(d.projects, 'dashboard.projects', []) },
    thresholds,
    routing,
    run: { timeoutMin: num(raw.run?.timeoutMin, 'run.timeoutMin', 20) },
    git: {
      pushBranches: raw.git?.pushBranches === true,
      protectedPaths: strArray(raw.git?.protectedPaths, 'git.protectedPaths', ['netlify.toml', '.env*']),
    },
    permissions,
    router: { shortTypes: strArray(raw.router?.shortTypes, 'router.shortTypes', ['section', 'copy', 'qa']) },
    limitDetection: {
      tailLines: num(raw.limitDetection?.tailLines, 'limitDetection.tailLines', 15),
      patterns: strArray(raw.limitDetection?.patterns, 'limitDetection.patterns', DEFAULT_LIMIT_PATTERNS),
    },
    handoff: { maxHandoffs: num(raw.handoff?.maxHandoffs, 'handoff.maxHandoffs', 2) },
    notifications: { enabled: raw.notifications?.enabled !== false },
    chat: {
      order: ((): AgentId[] => {
        const o = raw.chat?.order ?? ['claude', 'agy'];
        if (!Array.isArray(o) || o.some((x) => !AGENT_IDS.includes(x as AgentId))) fail('chat.order must be a list of claude | agy');
        return o as AgentId[];
      })(),
    },
  };
}

export function loadConfig(path = defaultConfigPath()): SwitchboardConfig {
  return parseConfig(readFileSync(path, 'utf8'));
}
