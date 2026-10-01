#!/usr/bin/env -S npx tsx
// Switchboard CLI. Stage 1 implements `status` and `hook`; the rest arrive in later stages.
import { parseArgs } from 'node:util';
import { renderStatus, renderSummary } from '../packages/core/format';
import { installHook, uninstallHook } from '../packages/core/hook-install';
import { runDashboard } from '../packages/core/dashboard';
import { getOverview } from '../packages/core/overview';

const HELP = `Switchboard

Використання: sb <команда> [опції]

  status [--cached] [--json]   ліміти обох агентів (за замовчуванням читає свіжі дані)
  hook install [--dry-run]     підключити statusLine-хук у ~/.claude/settings.json (з бекапом)
  hook uninstall               відкотити settings.json до стану до встановлення
  dashboard [--prod] [--port N]  дешборд на http://127.0.0.1:4321 (за замовчуванням dev з hot reload; --prod = збірка і запуск)
  run | queue | resume | init   (будуть у наступних етапах)
`;

async function status(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { cached: { type: 'boolean' }, json: { type: 'boolean' } } });
  const overview = await getOverview(values.cached ? 'cached' : 'force');

  if (values.json) {
    console.log(JSON.stringify(overview, null, 2));
  } else {
    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    console.log(`\nЛіміти · ${renderSummary(overview)}\n`);
    console.log(renderStatus(overview.agents, new Date(overview.generatedAt), color));
  }
  // Exit 1 only when no data could be obtained for any agent.
  return overview.agents.every((a) => !a.snapshot) ? 1 : 0;
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
    case 'dashboard': {
      const { values } = parseArgs({ args: rest, options: { prod: { type: 'boolean' }, port: { type: 'string' } } });
      return runDashboard({ prod: values.prod, port: values.port ? Number(values.port) : undefined });
    }
    case 'run': case 'queue': case 'resume': case 'init':
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
