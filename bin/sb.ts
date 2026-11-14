#!/usr/bin/env -S npx tsx
// Switchboard CLI: status, hook, init, run, resume, merge, queue, unblock, dashboard.
import { parseArgs } from 'node:util';
import { renderStatus, renderSummary } from '../packages/core/format';
import { installHook, uninstallHook } from '../packages/core/hook-install';
import { loadConfig } from '../packages/core/config';
import { runDashboard } from '../packages/core/dashboard';
import { resumeTask, SbError, startTask, type StartResult } from '../packages/core/flow';
import { addUserMessage, createChat, runChatTurn, setChatMode } from '../packages/core/chat';
import { mergeFor, previewMergeFor, type MergeKind } from '../packages/core/launch';
import { startApiServer } from '../packages/core/api-server';
import { createApiToken, tokenPath } from '../packages/core/api-token';
import { initProject } from '../packages/core/init';
import { notify } from '../packages/core/notify';
import { getOverview } from '../packages/core/overview';
import { addProject, clearExhausted, readState, removeProject } from '../packages/core/store';
import { formatDuration } from '../packages/core/time';
import { AGENT_IDS, isAgentId, type AgentId, type Run, type Task } from '../packages/core/types';

const HELP = `Switchboard

Використання: sb <команда> [опції]

  status [--cached] [--json]   ліміти обох агентів (за замовчуванням читає свіжі дані)
  hook install [--dry-run]     підключити statusLine-хук у ~/.claude/settings.json (з бекапом)
  hook uninstall               відкотити settings.json до стану до встановлення
  dashboard [--prod] [--port N]  дешборд на http://127.0.0.1:4321 (за замовчуванням dev з hot reload; --prod = збірка і запуск)
  init <проєкт>                створити RULES.md, DESIGN.md, CLAUDE.md, AGENTS.md, .sb/ (існуючі файли не чіпає)
  run "<задача>" --project <папка> [--type section] [--agent claude|agy|codex] [--priority high]
                               [--figma <url>] [--timeout <хв>] [--reviews <id задачі>] [--no-handoff]
                               запустити задачу в гілці sb/<id>. Без --agent агента обирає роутер за
                               лімітами; при ліміті задача передається іншому агентові. main і деплой за тобою.
  chat "<повідомлення>" --project <папка> [--agent claude|agy|codex|auto] [--new] [--attachments <dir>]
                               чат з агентом у терміналі (та сама розмова, що в дашборді; правки йдуть у гілку sb/c-…)
  queue [--run-due]            список задач; --run-due продовжує ті, що чекали скидання ліміту й уже можуть іти
  resume <id> [--agent ...] [--note "відповідь агенту"]   продовжити задачу, що чекає, заблокована або впала
  merge <id> [--yes]           влити гілку задачі (t-…) або чату (c-…) у main: без --yes лише показує, що буде влито;
                               з --yes робить git merge --ff-only. Без push і деплою. Запускай лише за прямим проханням власника.
  api [--port N]               публічний JSON API для Make (лише /v1/*, Bearer-токен, 127.0.0.1; тунель вказуй на цей порт)
  api token [--rotate]         створити токен API (~/.switchboard/api-token); --rotate замінює наявний
  unblock claude|agy|codex     зняти позначку «ліміт вичерпано» (якщо вона хибна)
  project add|remove|list      проєкти, у яких дешборд може запускати задачі (проєкти з sb run додаються самі)
  notify-test                  перевірити системне сповіщення (macOS)
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

function printResult(r: StartResult): number {
  const t = r.task;
  const secs = (run: Run) => Math.round((Date.parse(run.endedAt ?? run.startedAt) - Date.parse(run.startedAt)) / 1000);
  const icons: Record<string, string> = { done: '✔ ГОТОВО', blocked: '■ ЗАБЛОКОВАНО (агенту не дозволено дію)', failed: '✖ ПОМИЛКА' };

  let label: string;
  if (t.status === 'waiting' && r.waiting) label = '⏸ ЧЕКАЄ (ліміт агентів)';
  else if (t.status === 'waiting') label = '◐ НЕ ЗАВЕРШЕНО (агент: in-progress)';
  else label = icons[r.run?.status ?? ''] ?? t.status;

  console.log(`\n${label}  ${t.id}  (${r.runs.map((x) => `${x.agent} ${secs(x)} с`).join(' → ') || 'без запуску'})`);
  for (const h of r.handoffs) {
    const when = new Date(h.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    console.log(`  передача: ${h.from} → ${h.to ?? '(нікому)'} о ${when}, причина: ${h.reason}`);
  }
  if (r.waiting) console.log(`  чекає до: ${new Date(r.waiting.until).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })}  (${r.waiting.reason})\n  продовжити: pnpm sb resume ${t.id}`);
  if (r.run?.reason && !r.waiting) console.log(`  причина: ${r.run.reason}`);
  if (r.run?.summary) console.log(`  відповідь агента: ${r.run.summary.slice(0, 400).replace(/\n/g, ' ')}`);
  if (r.progress.status) console.log(`  PROGRESS.md: Status: ${r.progress.status}${r.progress.openQuestions.length ? `; відкриті питання: ${r.progress.openQuestions.join(' | ')}` : ''}`);
  console.log(`  гілка:   ${t.branch}   (проєкт повернуто на ${r.runs.length ? t.baseBranch : 'поточну гілку'})`);
  console.log(`  файли:   ${r.files.length ? r.files.join(', ') : '—'}`);
  if (r.run) console.log(`  лог:     ${r.run.logPath}`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
  console.log(`\nПереглянь: git -C ${t.project} diff ${t.baseBranch}..${t.branch}`);
  console.log('Мерж у main і деплой роби сам, Switchboard цього не робить.');
  return t.status === 'done' ? 0 : t.status === 'blocked' || t.status === 'waiting' ? 4 : 1;
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' }, type: { type: 'string' }, agent: { type: 'string' },
      priority: { type: 'string' }, figma: { type: 'string' }, timeout: { type: 'string' },
      reviews: { type: 'string' }, 'no-handoff': { type: 'boolean' }, attachments: { type: 'string' },
    },
  });
  const text = positionals.join(' ').trim();
  if (!text || !values.project) {
    console.error('Використання: sb run "<задача>" --project <папка> [--type section] [--agent claude|agy|codex]');
    return 2;
  }
  if (values.agent && !isAgentId(values.agent)) throw new SbError(`--agent: ${AGENT_IDS.join(', ')}`, 2);
  if (values.priority && values.priority !== 'normal' && values.priority !== 'high') throw new SbError('--priority: normal або high', 2);

  const r = await startTask(
    {
      text,
      project: values.project,
      type: values.type ?? 'section',
      agent: values.agent as AgentId | undefined,
      priority: values.priority as 'normal' | 'high' | undefined,
      figma: values.figma,
      timeoutMin: values.timeout ? Number(values.timeout) : undefined,
      reviews: values.reviews,
      noHandoff: values['no-handoff'],
      attachmentsDir: values.attachments,
    },
    loadConfig(),
    (line) => console.log(line),
  );
  return printResult(r);
}

async function resume(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { agent: { type: 'string' }, timeout: { type: 'string' }, 'no-handoff': { type: 'boolean' }, note: { type: 'string' }, attachments: { type: 'string' } },
  });
  const id = positionals[0];
  if (!id) {
    console.error('Використання: sb resume <id задачі> [--agent claude|agy|codex]');
    return 2;
  }
  if (values.agent && !isAgentId(values.agent)) throw new SbError(`--agent: ${AGENT_IDS.join(', ')}`, 2);
  const r = await resumeTask(id, loadConfig(), (line) => console.log(line), {}, {
    agent: values.agent as AgentId | undefined,
    timeoutMin: values.timeout ? Number(values.timeout) : undefined,
    noHandoff: values['no-handoff'],
    clarification: values.note,
    attachmentsDir: values.attachments,
  });
  return printResult(r);
}

/** Tasks parked until a limit reset, soonest first. */
function dueClock(t: Task): string {
  if (!t.waitUntil) return '';
  const left = Date.parse(t.waitUntil) - Date.now();
  const when = new Date(t.waitUntil).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
  return left > 0 ? `чекає до ${when} (через ${formatDuration(left)})` : `готова до продовження (з ${when})`;
}

async function queue(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { 'run-due': { type: 'boolean' } } });
  const tasks = Object.values(readState().tasks).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (values['run-due']) {
    const due = tasks.filter((t) => t.status === 'waiting' && t.waitUntil && Date.parse(t.waitUntil) <= Date.now());
    if (due.length === 0) {
      console.log('Немає задач, час очікування яких минув.');
      return 0;
    }
    let code = 0;
    for (const t of due) {
      console.log(`\n=== продовжую ${t.id} ===`);
      try {
        code = Math.max(code, printResult(await resumeTask(t.id, loadConfig(), (line) => console.log(line))));
      } catch (e) {
        console.error(`  ${t.id}: ${(e as Error).message}`);
        code = Math.max(code, e instanceof SbError ? e.exitCode : 1);
      }
    }
    return code;
  }

  if (tasks.length === 0) {
    console.log('Задач ще немає.');
    return 0;
  }
  for (const t of tasks) {
    console.log(`${t.id}  ${t.status.padEnd(8)} ${t.type.padEnd(8)} ${(t.agent ?? '-').padEnd(6)} ${t.branch}`);
    console.log(`    ${t.text.split('\n')[0]!.slice(0, 80)}`);
    if (t.status === 'waiting') console.log(`    ${dueClock(t)}`);
    if (t.note) console.log(`    ${t.note.replace(/\s+/g, ' ').slice(0, 160)}`);
    for (const h of t.handoffs ?? []) console.log(`    ↪ ${h.from} → ${h.to ?? '(нікому)'}: ${h.reason}`);
  }
  return 0;
}

async function chatCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: 'string' }, agent: { type: 'string' }, new: { type: 'boolean' }, attachments: { type: 'string' } },
  });
  const text = positionals.join(' ').trim();
  if (!text || !values.project) {
    console.error('Використання: sb chat "<повідомлення>" --project <папка> [--agent claude|agy|codex|auto] [--new]');
    return 2;
  }
  if (values.agent && values.agent !== 'auto' && !isAgentId(values.agent)) throw new SbError(`--agent: ${AGENT_IDS.join(', ')} або auto`, 2);
  const { realpathSync } = await import('node:fs');
  const project = realpathSync(values.project.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  const state = readState();
  const activeId = state.activeChats[project];
  let chat = !values.new && activeId ? state.chats[activeId] : undefined;
  if (!chat) chat = await createChat({ project, mode: (values.agent as 'auto' | AgentId | undefined) ?? 'auto' });
  else if (values.agent) setChatMode(chat.id, values.agent as 'auto' | AgentId);
  addUserMessage(chat.id, { text, attachmentsDir: values.attachments });
  const r = await runChatTurn(chat.id, loadConfig(), (line) => console.log(line));
  const reply = r.chat.messages.filter((m) => m.role !== 'user').slice(-1)[0];
  if (r.waiting) console.log(`\n⏸ ${r.waiting.reason}`);
  else if (reply) console.log(`\n${reply.agent ? `[${reply.agent}] ` : ''}${reply.text}`);
  if (r.files.length) console.log(`\nзміни: ${r.files.join(', ')}  (гілка ${r.chat.branch})`);
  for (const w of r.warnings) console.log(`! ${w}`);
  return r.ok ? 0 : r.waiting ? 4 : 1;
}

async function mergeCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: 'boolean' } } });
  const id = positionals[0] ?? '';
  const kind: MergeKind | undefined = id.startsWith('t-') ? 'task' : id.startsWith('c-') ? 'chat' : undefined;
  if (!kind) {
    console.error('Використання: sb merge <id задачі t-… або чату c-…> [--yes]');
    return 2;
  }
  const cfg = loadConfig();
  const p = await previewMergeFor(cfg, kind, id);
  if (!p.ok) { console.error(p.error); return 3; }
  const v = p.preview!;
  console.log(`Гілка ${v.branch} → ${v.base}: ${v.commits.length} комітів, ${v.files.length} файлів`);
  for (const c of v.commits.slice(0, 10)) console.log(`  ${c.sha} ${c.subject}`);
  if (v.files.length) console.log(`Файли: ${v.files.slice(0, 15).join(', ')}${v.files.length > 15 ? ` (+${v.files.length - 15})` : ''}`);
  if (!v.canMerge) { console.error(`\nНе можна влити зараз: ${v.reason}`); return 3; }
  if (!values.yes) { console.log('\nНічого не змінено. Щоб влити (merge --ff-only, без push): додай --yes.'); return 0; }
  const m = await mergeFor(cfg, kind, id);
  if (!m.ok) { console.error(m.error); return 3; }
  console.log(`\n✔ ${m.message}`);
  return 0;
}

async function apiCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === 'token') {
    const { values } = parseArgs({ args: rest, options: { rotate: { type: 'boolean' } } });
    const token = createApiToken({ rotate: values.rotate });
    if (token) {
      console.log(`Токен API (покажу лише зараз, збережено в ${tokenPath()}):\n\n${token}\n\nВставляй його в Make як заголовок Authorization: Bearer <токен>.`);
    } else {
      console.log(`Токен уже є: ${tokenPath()} (права 0600). Показати: cat "${tokenPath()}". Замінити: sb api token --rotate`);
    }
    return 0;
  }
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' } } });
  const cfg = loadConfig();
  try {
    const server = await startApiServer(cfg, { port: values.port ? Number(values.port) : undefined });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : cfg.api.port;
    console.log(`Switchboard API: http://127.0.0.1:${port}/v1  (Ctrl+C щоб зупинити)`);
    console.log('Назовні — лише через тунель, спрямований на цей порт (див. README, «API для Make»).');
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  return await new Promise<number>(() => { /* serve until the process is stopped */ });
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
      return queue(rest);
    case 'chat':
      return chatCommand(rest);
    case 'chat-turn': {
      // Internal: the dashboard spawns this for a pending chat message.
      const id = rest[0];
      if (!id) return 2;
      const r = await runChatTurn(id, loadConfig(), (line) => console.log(line));
      return r.ok ? 0 : r.waiting ? 4 : 1;
    }
    case 'resume':
      return resume(rest);
    case 'merge':
      return mergeCommand(rest);
    case 'api':
      return apiCommand(rest);
    case 'project': {
      const [sub, path] = rest;
      const { realpathSync, statSync } = await import('node:fs');
      const { allowedProjects } = await import('../packages/core/task-overview');
      if (sub === 'list') {
        const list = allowedProjects(loadConfig());
        console.log(list.length ? list.map((p) => `${p.name.padEnd(24)} ${p.path}`).join('\n') : 'Дозволених проєктів ще немає.');
        return 0;
      }
      if ((sub === 'add' || sub === 'remove') && path) {
        const abs = path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
        let real: string;
        try {
          real = realpathSync(abs);
          if (!statSync(real).isDirectory()) throw new Error('not a directory');
        } catch {
          console.error(`Папки не існує: ${abs}`);
          return 2;
        }
        if (sub === 'add') {
          addProject(real);
          console.log(`Проєкт дозволено для запуску з дешборду: ${real}`);
        } else {
          console.log(removeProject(real) ? `Прибрано: ${real}` : `Не було у списку (проєкти з минулих задач і з конфігу прибираються окремо): ${real}`);
        }
        return 0;
      }
      console.error('Використання: sb project add <папка> | sb project remove <папка> | sb project list');
      return 2;
    }
    case 'notify-test': {
      const ok = await notify('Switchboard', 'Тест сповіщення: якщо ти це бачиш, паузи задач нагадуватимуть про себе.');
      console.log(ok ? 'Сповіщення надіслано.' : 'Не вдалося надіслати сповіщення (працює лише на macOS через osascript).');
      return ok ? 0 : 1;
    }
    case 'unblock': {
      const agent = rest[0];
      if (!isAgentId(agent)) {
        console.error('Використання: sb unblock claude|agy|codex  (знімає позначку «ліміт вичерпано», якщо вона хибна)');
        return 2;
      }
      clearExhausted(agent);
      console.log(`Позначку про вичерпаний ліміт для ${agent} знято.`);
      return 0;
    }
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
      console.log(
        r.mode === 'existing'
          ? 'Знайшов власний CLAUDE.md проєкту: RULES.md, DESIGN.md і AGENTS.md лише вказують на нього, TODO заповнювати не треба.'
          : 'Заповни TODO в RULES.md і DESIGN.md: це все, що агенти знають про проєкт.',
      );
      console.log('Потім закоміть ці файли: `sb run` не стартує, поки робоче дерево не чисте.');
      return 0;
    }
    default:
      console.error(`Невідома команда: ${cmd}\n${HELP}`);
      return 2;
  }
}

main().then((code) => { process.exitCode = code; }, (e: Error) => {
  console.error(e instanceof SbError ? e.message : `Помилка: ${e.message}`);
  process.exitCode = e instanceof SbError ? e.exitCode : 1;
});
