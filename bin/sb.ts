#!/usr/bin/env -S npx tsx
// Switchboard CLI. Stage 1 implements `status` and `hook`; the rest arrive in later stages.
import { parseArgs } from 'node:util';
import { loadConfig } from '../packages/core/config';
import { renderStatus, renderSummary, type StatusRow } from '../packages/core/format';
import { installHook, uninstallHook } from '../packages/core/hook-install';
import { collectUsage } from '../packages/core/limits';
import { computeStatus } from '../packages/core/status';
import { readState } from '../packages/core/store';
import type { AgentId } from '../packages/core/types';

const TITLES: Record<AgentId, string> = { claude: 'Claude Code', agy: 'Antigravity' };

const HELP = `Switchboard

Використання: sb <команда> [опції]

  status [--cached] [--json]   ліміти обох агентів (за замовчуванням читає свіжі дані)
  hook install [--dry-run]     підключити statusLine-хук у ~/.claude/settings.json (з бекапом)
  hook uninstall               відкотити settings.json до стану до встановлення
  run | queue | resume | init | dashboard   (будуть у наступних етапах)
`;

async function status(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { cached: { type: 'boolean' }, json: { type: 'boolean' } } });
  const cfg = loadConfig();
  const now = new Date();

  const results = values.cached
    ? (['claude', 'agy'] as AgentId[]).map((agent) => ({ agent, snapshot: readState().snapshots[agent], error: undefined as string | undefined }))
    : await collectUsage(cfg, now);

  const state = readState();
  const rows: StatusRow[] = results.map((r) => ({
    agent: r.agent,
    title: TITLES[r.agent],
    snapshot: r.snapshot,
    error: r.error,
    result: computeStatus(r.snapshot, cfg.thresholds, cfg.limits.staleAfterMin, now, state.exhausted[r.agent]),
  }));

  if (values.json) {
    console.log(JSON.stringify({ generatedAt: now.toISOString(), agents: rows }, null, 2));
  } else {
    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    console.log(`\nЛіміти · ${renderSummary(rows)}\n`);
    console.log(renderStatus(rows, now, color));
  }
  // Exit 1 only when no data could be obtained for any agent.
  return rows.every((r) => !r.snapshot) ? 1 : 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'status':
      return status(rest);
    case 'hook': {
      const [sub, ...flags] = rest;
      const dryRun = flags.includes('--dry-run');
      if (sub === 'install') return installHook({ dryRun });
      if (sub === 'uninstall') return uninstallHook();
      console.error('Використання: sb hook install [--dry-run] | sb hook uninstall');
      return 2;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case 'run': case 'queue': case 'resume': case 'init': case 'dashboard':
      console.error(`"sb ${cmd}" ще не реалізовано (див. етапи в README).`);
      return 2;
    default:
      console.error(`Невідома команда: ${cmd}\n${HELP}`);
      return 2;
  }
}

main().then((code) => { process.exitCode = code; }, (e: Error) => {
  console.error(`Помилка: ${e.message}`);
  process.exitCode = 1;
});
