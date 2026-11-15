// Models an agent can be told to use (`--model`). claude: a fixed list from the config (aliases such as opus);
// agy: the list from `agy models`, cached because it hits the network and rarely changes (the dashboard's "Оновити"
// forces a re-read); codex: the visible models from codex's own ~/.codex/models_cache.json (read live), else the config.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './exec';
import { codexHome } from './limits/codex';
import { readState, updateState } from './store';
import type { AgentId, ModelOption, SwitchboardConfig } from './types';

const TTL_MS = 6 * 3600_000;
let refreshing: Promise<void> | null = null;

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

function refreshAgyModels(cfg: SwitchboardConfig): Promise<void> {
  // One `agy models` call at a time; concurrent callers share it.
  refreshing ??= (async () => {
    try {
      const r = await runCommand(cfg.agents.agy.cmd, ['models'], { timeoutMs: cfg.limits.fetchTimeoutSec * 1000, cwd: tmpdir() });
      const list = r.code === 0 ? parseAgyModels(r.stdout) : [];
      if (list.length > 0) updateState((s) => { s.meta.agyModelList = { at: new Date().toISOString(), list }; });
    } catch { /* the cached list (or none) stays */ } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Forces a re-read of the model lists that come from a CLI (agy). Codex's list is read live, claude's are aliases. */
export async function refreshModels(cfg: SwitchboardConfig): Promise<void> {
  await refreshAgyModels(cfg);
}

/** Models codex itself reports as selectable (`visibility: "list"`); undefined when its cache is missing or unreadable. */
export function readCodexModels(file = join(codexHome(), 'models_cache.json')): ModelOption[] | undefined {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { models?: { slug?: unknown; display_name?: unknown; visibility?: unknown }[] };
    const list = (data.models ?? [])
      .filter((m) => typeof m.slug === 'string' && m.slug && (m.visibility === undefined || m.visibility === 'list'))
      .map((m) => ({ id: m.slug as string, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : (m.slug as string) }));
    return list.length > 0 ? list : undefined;
  } catch {
    return undefined;
  }
}

/** Never waits for the network: returns what is cached and refreshes in the background when it is stale. */
export function getModels(cfg: SwitchboardConfig): Record<AgentId, ModelOption[]> {
  const cached = readState().meta.agyModelList;
  if (!cached || Date.now() - Date.parse(cached.at) > TTL_MS) void refreshAgyModels(cfg);
  return {
    claude: (cfg.agents.claude.models.length ? cfg.agents.claude.models : DEFAULT_CLAUDE_MODELS).map((id) => ({ id, label: id })),
    agy: cached?.list ?? [],
    // codex cannot list models non-interactively, but it keeps the list for its plan in models_cache.json (refreshed by
    // the live probe); agents.codex.models is the fallback when that file is absent.
    codex: readCodexModels() ?? cfg.agents.codex.models.map((id) => ({ id, label: id })),
  };
}

/** Is `model` acceptable for `agent`? An unknown list (agy before the first refresh) falls back to a format check. */
export function isKnownModel(cfg: SwitchboardConfig, agent: AgentId, model: string): boolean {
  if (!model) return true;
  const list = getModels(cfg)[agent];
  return list.length > 0 ? list.some((m) => m.id === model) : /^[A-Za-z0-9][\w.:()-]{0,79}$/.test(model);
}
