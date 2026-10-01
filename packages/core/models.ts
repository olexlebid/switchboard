// Models an agent can be told to use (`--model`). claude: a fixed list from the config (aliases such as opus);
// agy: the list from `agy models`, cached because it hits the network and rarely changes.
import { tmpdir } from 'node:os';
import { runCommand } from './exec';
import { readState, updateState } from './store';
import type { AgentId, ModelOption, SwitchboardConfig } from './types';

const TTL_MS = 6 * 3600_000;
let refreshing = false;

/** Used when `agents.claude.models` is empty: aliases that always point at the latest model. */
export const DEFAULT_CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];

/** "<id><tab><Display name>" per line; ignores the "Fetching…" banner and ANSI colors. */
export function parseAgyModels(text: string): ModelOption[] {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const out: ModelOption[] = [];
  for (const line of plain.split(/\r?\n/)) {
    const m = /^([a-z0-9][\w.-]*)\s+(\S.*)$/i.exec(line.trim());
    if (m && !/^fetching$/i.test(m[1]!)) out.push({ id: m[1]!, label: m[2]!.trim() });
  }
  return out;
}

async function refreshAgyModels(cfg: SwitchboardConfig): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const r = await runCommand(cfg.agents.agy.cmd, ['models'], { timeoutMs: cfg.limits.fetchTimeoutSec * 1000, cwd: tmpdir() });
    const list = r.code === 0 ? parseAgyModels(r.stdout) : [];
    if (list.length > 0) updateState((s) => { s.meta.agyModelList = { at: new Date().toISOString(), list }; });
  } catch { /* the cached list (or none) stays */ } finally {
    refreshing = false;
  }
}

/** Never waits for the network: returns what is cached and refreshes in the background when it is stale. */
export function getModels(cfg: SwitchboardConfig): Record<AgentId, ModelOption[]> {
  const cached = readState().meta.agyModelList;
  if (!cached || Date.now() - Date.parse(cached.at) > TTL_MS) void refreshAgyModels(cfg);
  return {
    claude: (cfg.agents.claude.models.length ? cfg.agents.claude.models : DEFAULT_CLAUDE_MODELS).map((id) => ({ id, label: id })),
    agy: cached?.list ?? [],
  };
}

/** Is `model` acceptable for `agent`? An unknown list (agy before the first refresh) falls back to a format check. */
export function isKnownModel(cfg: SwitchboardConfig, agent: AgentId, model: string): boolean {
  if (!model) return true;
  const list = getModels(cfg)[agent];
  return list.length > 0 ? list.some((m) => m.id === model) : /^[A-Za-z0-9][\w.:()-]{0,79}$/.test(model);
}
