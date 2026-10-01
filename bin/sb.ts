#!/usr/bin/env -S npx tsx
// Switchboard CLI. Stage 1 implements `status` and `hook`; the rest arrive in later stages.
import { parseArgs } from 'node:util';
import { renderStatus, renderSummary } from '../packages/core/format';
import type { AgentId } from '../packages/core/types';
import { installHook, uninstallHook } from '../packages/core/hook-install';
import { loadConfig } from '../packages/core/config';
import { runDashboard } from '../packages/core/dashboard';
import { SbError, startTask } from '../packages/core/flow';
import { initProject } from '../packages/core/init';
import { getOverview } from '../packages/core/overview';
import { readState } from '../packages/core/store';

const HELP = `Switchboard

Використання: sb <команда> [опції]

  status [--cached] [--json]   ліміти обох агентів (за замовчуванням читає свіжі дані)
  hook install [--dry-run]     підключити statusLine-хук у ~/.claude/settings.json (з бекапом)
  hook uninstall               відкотити settings.json до стану до встановлення
  dashboard [--prod] [--port N]  дешборд на http://127.0.0.1:4321 (за замовчуванням dev з hot reload; --prod = збірка і запуск)
  init <проєкт>                створити RULES.md, DESIGN.md, CLAUDE.md, AGENTS.md, .sb/ (існуючі файли не чіпає)
  run "<задача>" --project <папка> [--type section] [--agent claude|agy] [--priority high]
                               [--figma <url>] [--timeout <хв>]
                               запустити задачу в гілці sb/<id>; main і деплой лишаються за тобою
  queue                        список задач і їхні статуси
  resume | (авто-передача між агентами)   (Етап 4)
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

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' }, type: { type: 'string' }, agent: { type: 'string' },
      priority: { type: 'string' }, figma: { type: 'string' }, timeout: { type: 'string' },
    },
  });
  const text = positionals.join(' ').trim();
  if (!text || !values.project) {
    console.error('Використання: sb run "<задача>" --project <папка> [--type section] [--agent claude|agy]');
    return 2;
  }
  if (values.agent && values.agent !== 'claude' && values.agent !== 'agy') throw new SbError('--agent: claude або agy', 2);
  if (values.priority && values.priority !== 'normal' && values.priority !== 'high') throw new SbError('--priority: normal або high', 2);

  const cfg = loadConfig();
  const r = await startTask(
    {
      text,
      project: values.project,
      type: values.type ?? 'section',
      agent: values.agent as AgentId | undefined,
      priority: values.priority as 'normal' | 'high' | undefined,
      figma: values.figma,
      timeoutMin: values.timeout ? Number(values.timeout) : undefined,
    },
    cfg,
    (line) => console.log(line),
  );

  const icon: Record<string, string> = { done: '✔ ГОТОВО', blocked: '■ ЗАБЛОКОВАНО (агенту не дозволено дію)', failed: '✖ ПОМИЛКА' };
  const label = r.task.status === 'waiting' ? '◐ НЕ ЗАВЕРШЕНО (агент: in-progress)' : (icon[r.run.status] ?? r.run.status);
  const secs = Math.round((Date.parse(r.run.endedAt ?? r.run.startedAt) - Date.parse(r.run.startedAt)) / 1000);
  console.log(`\n${label}  ${r.task.id}  (${r.run.agent}, ${secs} с)`);
  if (r.run.reason) console.log(`  причина: ${r.run.reason}`);
  if (r.run.summary) console.log(`  відповідь агента: ${r.run.summary.slice(0, 400).replace(/\n/g, ' ')}`);
  if (r.progress.status) console.log(`  PROGRESS.md: Status: ${r.progress.status}${r.progress.openQuestions.length ? `; відкриті питання: ${r.progress.openQuestions.join(' | ')}` : ''}`);
  console.log(`  гілка:   ${r.task.branch}   (проєкт повернуто на ${r.task.baseBranch})`);
  console.log(`  файли:   ${r.files.length ? r.files.join(', ') : '—'}`);
  console.log(`  лог:     ${r.run.logPath}`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
  console.log(`\nПереглянь: git -C ${r.task.project} diff ${r.task.baseBranch}..${r.task.branch}`);
  console.log('Мерж у main і деплой роби сам, Switchboard цього не робить.');
  return r.task.status === 'done' ? 0 : r.task.status === 'blocked' || r.task.status === 'waiting' ? 4 : 1;
}

function queue(): number {
  const tasks = Object.values(readState().tasks).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (tasks.length === 0) {
    console.log('Задач ще немає.');
    return 0;
  }
  for (const t of tasks) {
    console.log(`${t.id}  ${t.status.padEnd(8)} ${t.type.padEnd(8)} ${(t.agent ?? '-').padEnd(6)} ${t.branch}\n    ${t.text.split('\n')[0]!.slice(0, 80)}${t.note ? `\n    ${t.note}` : ''}`);
  }
  return 0;
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
    case 'run':
      return run(rest);
    case 'queue':
      return queue();
    case 'init': {
      const project = rest[0];
      if (!project) {
        console.error('Використання: sb init <папка проєкту>');
        return 2;
      }
      const r = initProject(project.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
      for (const f of r.created) console.log(`  створено   ${f}`);
      for (const f of r.skipped) console.log(`  пропущено  ${f} (вже є)`);
      for (const w of r.warnings) console.log(`  ! ${w}`);
      console.log('Заповни TODO в RULES.md і DESIGN.md: це все, що агенти знають про проєкт.');
      console.log('Потім закоміть ці файли: `sb run` не стартує, поки робоче дерево не чисте.');
      return 0;
    }
    case 'resume':
      console.error(`"sb ${cmd}" ще не реалізовано (див. етапи в README).`);
      return 2;
    default:
      console.error(`Невідома команда: ${cmd}\n${HELP}`);
      return 2;
  }
}

main().then((code) => { process.exitCode = code; }, (e: Error) => {
  console.error(e instanceof SbError ? e.message : `Помилка: ${e.message}`);
  process.exitCode = e instanceof SbError ? e.exitCode : 1;
});
