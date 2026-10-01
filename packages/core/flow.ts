// One task from start to finish: pick an agent, run it on its own branch, and when it hits a usage
// limit hand the work over to the other agent (checkpoint + continuation prompt). Never merges, never deploys.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgyPermissionError, applyAgyRules, DEFAULT_AGY_SETTINGS, recoverAgyRules, type AgyRuleHandle } from './agy-permissions';
import { onExit } from './cleanup';
import { changedFiles, checkoutBranch, commitAll, currentBranch, dirtyFiles, headSha, isGitRepo, pushBranch, switchBack } from './git';
import { outputTail, writeCheckpoint } from './handoff';
import { interpretOutput, type Outcome } from './interpret';
import { detectLimit, type LimitSignal } from './limit-detect';
import { collectUsage } from './limits';
import { notify as defaultNotify, type Notify } from './notify';
import { getOverview, type AgentOverview } from './overview';
import { readProgress, type ProgressInfo } from './progress';
import { protectedTouched } from './protected';
import { buildContinuePrompt, buildStartPrompt } from './prompt';
import { routeTask } from './router';
import { buildAgentArgs, logPathFor, runAgentProcess, type ProcessResult } from './runner';
import { addProject, readState, saveRun, saveTask, setExhausted } from './store';
import { newTaskId, taskTitle, writeTaskFile } from './tasks';
import type { AgentId, Handoff, Run, SwitchboardConfig, Task, UsageSnapshot } from './types';

/** An error the CLI should show as-is, with a specific exit code. */
export class SbError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export type StartInput = {
  text: string;
  type: string;
  project: string;
  /** Pin the first agent instead of letting the router choose. */
  agent?: AgentId;
  priority?: 'normal' | 'high';
  figma?: string;
  timeoutMin?: number;
  /** review tasks: id of the task whose code is reviewed. */
  reviews?: string;
  /** Stop at the first usage limit instead of handing over to the other agent. */
  noHandoff?: boolean;
};

/** Everything that talks to the outside world, replaceable in tests. */
export type FlowDeps = {
  overview?: () => Promise<AgentOverview[]>;
  /** Fresh usage read for one agent, taken right after a failed run. */
  readUsage?: (agent: AgentId) => Promise<UsageSnapshot | undefined>;
  notify?: Notify;
  now?: () => Date;
};

export type StartResult = {
  task: Task;
  /** All runs of this call, oldest first (empty when the task was queued before any run). */
  runs: Run[];
  /** The last run, if any. */
  run?: Run;
  outcome?: Outcome;
  /** What the last agent wrote in PROGRESS.md (status, open questions). */
  progress: ProgressInfo;
  files: string[];
  warnings: string[];
  /** Set when the task is waiting for a limit reset. */
  waiting?: { until: string; reason: string };
  handoffs: Handoff[];
};

type Ctx = {
  cfg: SwitchboardConfig;
  say: (s: string) => void;
  overview: () => Promise<AgentOverview[]>;
  readUsage: (agent: AgentId) => Promise<UsageSnapshot | undefined>;
  notify: Notify;
  now: () => Date;
};

function makeCtx(cfg: SwitchboardConfig, say: (s: string) => void, deps: FlowDeps): Ctx {
  return {
    cfg,
    say,
    now: deps.now ?? (() => new Date()),
    notify: deps.notify ?? (cfg.notifications.enabled ? defaultNotify : async () => false),
    overview: deps.overview ?? (async () => (await getOverview('force', cfg)).agents),
    readUsage:
      deps.readUsage ??
      (async (agent) => (await collectUsage(cfg, new Date(), [agent])).find((r) => r.agent === agent)?.snapshot),
  };
}

function expandHome(p: string): string {
  return resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
}

export async function startTask(
  input: StartInput,
  cfg: SwitchboardConfig,
  say: (s: string) => void = () => {},
  deps: FlowDeps = {},
): Promise<StartResult> {
  const project = expandHome(input.project);
  if (!existsSync(project) || !statSync(project).isDirectory()) throw new SbError(`Папки проєкту не існує: ${project}`, 2);
  if (!(await isGitRepo(project))) throw new SbError(`${project} не є git-репозиторієм.`, 2);
  if (!cfg.routing[input.type]) throw new SbError(`Невідомий тип задачі "${input.type}". Доступні: ${Object.keys(cfg.routing).join(', ')}.`, 2);
  if (!input.text.trim()) throw new SbError('Порожній текст задачі.', 2);
  if (input.reviews && !readState().tasks[input.reviews]) throw new SbError(`--reviews: задачі ${input.reviews} не існує.`, 2);

  const dirty = await dirtyFiles(project);
  if (dirty.length > 0) {
    throw new SbError(
      `Робоче дерево в ${project} не чисте (${dirty.length} змін). Закоміть або відклади зміни й повтори.\n  ${dirty.slice(0, 8).join('\n  ')}`,
      3,
    );
  }

  const id = newTaskId();
  const task: Task = {
    id,
    text: input.text,
    type: input.type,
    project,
    priority: input.priority ?? 'normal',
    figma: input.figma,
    status: 'queued',
    branch: `sb/${id}`,
    baseBranch: await currentBranch(project),
    baseSha: await headSha(project),
    agent: input.agent,
    runs: [],
    handoffs: [],
    reviews: input.reviews,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveTask(task);
  addProject(project); // the dashboard form offers every project that was used at least once
  return drive(task, makeCtx(cfg, say, deps), { pinned: input.agent, timeoutMin: input.timeoutMin, noHandoff: input.noHandoff, resuming: false });
}

/** `sb resume <id>`: continue a waiting, blocked or failed task (the handover counter starts again). */
export async function resumeTask(
  id: string,
  cfg: SwitchboardConfig,
  say: (s: string) => void = () => {},
  deps: FlowDeps = {},
  opts: { agent?: AgentId; timeoutMin?: number; noHandoff?: boolean } = {},
): Promise<StartResult> {
  const task = readState().tasks[id];
  if (!task) throw new SbError(`Задачі ${id} не існує. Подивись \`sb queue\`.`, 2);
  if (task.status === 'done') throw new SbError(`Задача ${id} уже виконана.`, 2);
  if (task.status === 'running') throw new SbError(`Задача ${id} зараз виконується.`, 2);
  if (!existsSync(task.project) || !(await isGitRepo(task.project))) throw new SbError(`Проєкт задачі недоступний: ${task.project}`, 2);

  const dirty = await dirtyFiles(task.project);
  if (dirty.length > 0) {
    throw new SbError(`Робоче дерево в ${task.project} не чисте (${dirty.length} змін). Закоміть або відклади зміни й повтори.\n  ${dirty.slice(0, 8).join('\n  ')}`, 3);
  }
  task.waitUntil = undefined;
  // A branch with earlier runs means there is work to continue; a never-started task begins normally.
  return drive(task, makeCtx(cfg, say, deps), { pinned: opts.agent, timeoutMin: opts.timeoutMin, noHandoff: opts.noHandoff, resuming: task.runs.length > 0 });
}

type DriveOpts = { pinned?: AgentId; timeoutMin?: number; noHandoff?: boolean; resuming: boolean };

async function drive(task: Task, ctx: Ctx, opts: DriveOpts): Promise<StartResult> {
  const { cfg, say } = ctx;
  const project = task.project;
  const warnings: string[] = [];
  const runs: Run[] = [];
  const returnTo = await currentBranch(project);
  let lastOutcome: Outcome | undefined;
  let lastProgress: ProgressInfo = { openQuestions: [] };
  let files: string[] = [];
  let waiting: StartResult['waiting'];
  let handoverCount = 0;
  let continuing = opts.resuming;
  let pinned = opts.pinned;

  // If sb is interrupted (Ctrl+C / kill) while an agent works, keep its work as a wip checkpoint
  // and mark the task, instead of leaving uncommitted changes and a task stuck in "running".
  const unregisterInterrupt = onExit(() => {
    if (task.status !== 'running') return;
    const git = (...args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8' });
    if (git('status', '--porcelain').stdout.trim()) {
      const identity = git('config', 'user.email').stdout.trim() ? [] : ['-c', 'user.name=Switchboard', '-c', 'user.email=switchboard@localhost'];
      git('add', '-A');
      git(...identity, 'commit', '-m', `wip(sb): checkpoint ${task.id} interrupted`);
    }
    task.status = 'failed';
    task.pid = undefined;
    task.note = `перервано користувачем; робота збережена в ${task.branch} (проєкт лишився на цій гілці)`;
    saveTask(task);
  }, 2);

  const authors = reviewAuthors(task);

  /** Puts the task in the queue until `until` and tells the user. */
  const park = async (until: string, reason: string) => {
    task.status = 'waiting';
    task.waitUntil = until;
    task.note = reason;
    saveTask(task);
    waiting = { until, reason };
    const clock = new Date(until).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
    say(`⏸ Задача чекає до ${clock}: ${reason}`);
    await ctx.notify('Switchboard: задача чекає', `${taskTitle(task.text, 50)}: ${reason} (до ${clock})`);
  };

  try {
    for (let attempt = 0; ; attempt++) {
      // ---- 1. choose the agent
      let agent: AgentId;
      if (pinned) {
        agent = pinned;
        pinned = undefined;
        say(`Агент вказаний вручну: ${agent}`);
      } else {
        const decision = routeTask(cfg, await ctx.overview(), { type: task.type, priority: task.priority, authors }, ctx.now());
        if (decision.action === 'queue') {
          await park(decision.until, `немає вільного агента: ${decision.reason}`);
          break;
        }
        if (decision.action === 'none') {
          await park(new Date(ctx.now().getTime() + 3600_000).toISOString(), `немає допустимого агента: ${decision.reason}`);
          break;
        }
        agent = decision.agent;
        say(`Роутер: ${agent} (${decision.reason})`);
      }

      // ---- 2. be on the task branch with the task file in place
      if ((await currentBranch(project)) !== task.branch) {
        if ((await dirtyFiles(project)).length > 0) throw new SbError('Робоче дерево не чисте: не можу перейти на гілку задачі.', 3);
        await checkoutBranch(project, task.branch);
      }
      writeTaskFile(task);
      if (!existsSync(resolve(project, 'RULES.md'))) warnings.push('У проєкті немає RULES.md: запусти `sb init <проєкт>`, щоб агенти знали правила.');
      if (cfg.permissions[agent].allow.length === 0) {
        warnings.push(`Для ${agent} не задано дозволів (permissions.${agent}.allow): запис файлів, імовірно, буде заблоковано.`);
      }

      // ---- 3. run it
      task.status = 'running';
      task.pid = process.pid;
      task.agent = agent;
      task.waitUntil = undefined;
      const { run, proc, outcome } = await runAttempt(task, agent, continuing, opts.timeoutMin, ctx, warnings);
      runs.push(run);
      lastOutcome = outcome;

      // The agent's own verdict in PROGRESS.md counts too: "blocked" or "in-progress" means not finished.
      lastProgress = outcome.ok ? readProgress(project, task.id) : { openQuestions: [] };
      const agentBlocked = outcome.ok && lastProgress.status === 'blocked';
      const agentUnfinished = outcome.ok && lastProgress.status === 'in-progress';

      // ---- 4. did it hit a usage limit?
      let limit: LimitSignal = { hit: false, reason: '' };
      if (!outcome.ok && !proc.timedOut && !proc.spawnError && outcome.denied.length === 0) {
        const snapshot = await ctx.readUsage(agent).catch(() => undefined);
        limit = detectLimit({
          stdout: proc.stdout, stderr: proc.stderr, outcome, exitCode: proc.code, timedOut: proc.timedOut,
          taskText: task.text, patterns: cfg.limitDetection.patterns, tailLines: cfg.limitDetection.tailLines,
          snapshot, now: ctx.now(),
        });
      }

      if (limit.hit) {
        const now = ctx.now();
        const until = limit.resetsAt ?? new Date(now.getTime() + 3600_000).toISOString();
        setExhausted(agent, { until, reason: limit.reason, since: now.toISOString() });
        run.status = 'failed';
        run.reason = `ліміт: ${limit.reason}${limit.evidence ? ` (${limit.evidence})` : ''}`;
        run.endedAt = now.toISOString();
        saveRun(run);
        say(`⚠ ${agent}: ${limit.reason}. Агент недоступний до ${new Date(until).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })}.`);

        const tail = outputTail(proc.stdout, proc.stderr, outcome);
        const nextAgent = other(agent);
        const stopHere = opts.noHandoff || handoverCount >= cfg.handoff.maxHandoffs;
        await writeCheckpoint({ project, task, from: agent, to: stopHere ? undefined : nextAgent, reason: limit.reason, resetsAt: limit.resetsAt, tail, now });
        files = await changedFiles(project, task.baseSha);
        continuing = true;
        // No exclusion needed: the agent that just hit its limit now carries an "exhausted until" mark,
        // so the router skips it, and queues the task until the earliest reset when nobody is free.

        if (stopHere) {
          const why = opts.noHandoff ? 'передачу вимкнено (--no-handoff)' : `вичерпано ліміт передач (${cfg.handoff.maxHandoffs})`;
          task.handoffs = [...(task.handoffs ?? []), { from: agent, at: now.toISOString(), reason: limit.reason }];
          await park(until, `${agent}: ${limit.reason}; ${why}`);
          break;
        }

        // Is another agent available right now? If not, the loop parks the task until the earliest reset.
        const next = routeTask(cfg, await ctx.overview(), { type: task.type, priority: task.priority, authors }, now);
        task.handoffs = [...(task.handoffs ?? []), { from: agent, to: next.action === 'run' ? next.agent : undefined, at: now.toISOString(), reason: limit.reason }];
        saveTask(task);
        if (next.action === 'run') handoverCount++;
        continue; // next iteration routes again (and parks if nobody is free)
      }

      // ---- 5. normal end of the task (finished, blocked, failed or unfinished)
      const status: Run['status'] = outcome.ok && !agentBlocked ? 'done' : outcome.denied.length > 0 || agentBlocked ? 'blocked' : 'failed';
      run.status = status;
      run.endedAt = ctx.now().toISOString();
      run.exitCode = proc.code;
      run.summary = outcome.summary;
      run.reason = outcome.denied.length
        ? `denied: ${outcome.denied.join(', ')}`
        : agentBlocked
          ? `агент позначив blocked у PROGRESS.md${lastProgress.openQuestions[0] ? `: ${lastProgress.openQuestions[0]}` : ''}`
          : agentUnfinished
            ? 'агент не завершив задачу (Status: in-progress у PROGRESS.md)'
            : outcome.error;

      // A finished task gets a final commit; anything else a checkpoint, so nothing is lost.
      const finished = outcome.ok && !agentBlocked && !agentUnfinished;
      const sha = await commitAll(project, finished ? `feat(sb): ${taskTitle(task.text)} [${task.id}]` : `wip(sb): checkpoint ${task.id} from ${agent}`);
      files = await changedFiles(project, task.baseSha);
      const touchedProtected = protectedTouched(files, cfg.git.protectedPaths);
      if (touchedProtected.length > 0) {
        run.status = 'blocked';
        run.reason = `агент змінив захищені файли: ${touchedProtected.join(', ')}`;
        warnings.push(`Захищені файли змінено (${touchedProtected.join(', ')}): гілку не буде запушено, перевір diff.`);
      }
      if (outcome.ok && !files.includes('PROGRESS.md')) warnings.push('Агент не оновив PROGRESS.md.');
      if (outcome.ok && !sha && files.length === 0) warnings.push('Агент нічого не змінив: комітити нічого.');

      if (cfg.git.pushBranches && files.length > 0 && touchedProtected.length === 0) {
        try {
          await pushBranch(project, task.branch);
        } catch (e) {
          warnings.push(`push не вдався: ${(e as Error).message}`);
        }
      }

      task.status = touchedProtected.length > 0 ? 'blocked' : agentUnfinished ? 'waiting' : status === 'done' ? 'done' : status === 'blocked' ? 'blocked' : 'failed';
      task.note = oneLine(run.reason ?? run.summary ?? '', 200) || undefined;
      saveRun(run);
      saveTask(task);
      break;
    }
    saveTask(task);
    const last = runs[runs.length - 1];
    return { task, runs, run: last, outcome: lastOutcome, progress: lastProgress, files, warnings, waiting, handoffs: task.handoffs ?? [] };
  } catch (e) {
    // Never leave a task stuck in "running" when the orchestrator itself failed.
    task.status = 'failed';
    task.note = (e as Error).message.slice(0, 200);
    saveTask(task);
    throw e;
  } finally {
    task.pid = undefined;
    saveTask(task);
    unregisterInterrupt();
    // Leave the project on the branch it was on before, with the task branch intact.
    try {
      if ((await currentBranch(project)) !== returnTo) await switchBack(project, returnTo);
    } catch (e) {
      warnings.push(`не вдалося повернутися на ${returnTo}: ${(e as Error).message}`);
    }
  }
}

/** Collapses whitespace so notes stay on one line in lists. */
function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const other = (a: AgentId): AgentId => (a === 'claude' ? 'agy' : 'claude');

/** Agents that wrote code for the task under review (empty when unknown). */
function reviewAuthors(task: Task): AgentId[] {
  if (task.type !== 'review' || !task.reviews) return [];
  const state = readState();
  const reviewed = state.tasks[task.reviews];
  const agents = (reviewed?.runs ?? []).map((r) => state.runs[r]?.agent).filter((a): a is AgentId => !!a);
  return [...new Set(agents)];
}

/** Starts one agent process (with temporary agy rules) and interprets its output. */
async function runAttempt(
  task: Task,
  agent: AgentId,
  continuing: boolean,
  timeoutMin: number | undefined,
  ctx: Ctx,
  warnings: string[],
): Promise<{ run: Run; proc: ProcessResult; outcome: Outcome }> {
  const { cfg, say } = ctx;
  const project = task.project;
  const runId = `r-${task.id.slice(2)}-${task.runs.length + 1}`;
  const timeoutMs = (timeoutMin ?? cfg.run.timeoutMin) * 60_000;
  const existing = ['RULES.md', 'DESIGN.md', 'PROGRESS.md', `.sb/tasks/${task.id}.md`].filter((f) => existsSync(resolve(project, f)));
  const prompt = continuing ? buildContinuePrompt(task, { agent, existing }, task.baseSha) : buildStartPrompt(task, { agent, existing });
  const args = buildAgentArgs(agent, cfg.agents[agent], prompt, cfg.permissions[agent], timeoutMs);
  const logPath = logPathFor(runId);
  const run: Run = { id: runId, taskId: task.id, agent, startedAt: ctx.now().toISOString(), status: 'running', logPath };
  task.runs.push(runId);
  saveTask(task);
  saveRun(run);

  say(`▶ ${agent}${continuing ? ' (продовження)' : ''}: ${taskTitle(task.text)}\n  гілка ${task.branch}, тайм-аут ${Math.round(timeoutMs / 60_000)} хв\n  лог: ${logPath}`);

  // agy takes permissions only from its user-level settings: add a directory-scoped rule for this run.
  let rules: AgyRuleHandle | undefined;
  if (agent === 'agy' && cfg.permissions.agy.allow.length > 0) {
    try {
      const recovered = recoverAgyRules();
      if (recovered) warnings.push(recovered);
      const real = realpathSync(project);
      const fill = (list: string[]) => list.map((r) => r.replaceAll('{project}', real));
      rules = applyAgyRules({
        settingsPath: cfg.agents.agy.settingsPath ?? DEFAULT_AGY_SETTINGS,
        project: real,
        allow: fill(cfg.permissions.agy.allow),
        deny: fill(cfg.permissions.agy.deny),
      });
      say(`  agy: тимчасовий дозвіл на запис лише в ${real}/ (знімається після запуску)`);
    } catch (e) {
      if (e instanceof AgyPermissionError) throw new SbError(e.message, 3);
      throw e;
    }
  }

  let proc: ProcessResult;
  try {
    proc = await runAgentProcess({
      cmd: cfg.agents[agent].cmd,
      args,
      cwd: project,
      timeoutMs,
      logPath,
      logHeader: `[switchboard] ${ctx.now().toISOString()} task=${task.id} agent=${agent} branch=${task.branch}${continuing ? ' (continuation)' : ''}\n[switchboard] ${cfg.agents[agent].cmd} ${args.map((a) => (a === prompt ? '<prompt>' : a)).join(' ')}`,
    });
  } finally {
    // Always take the temporary agy rules away again, also after a timeout or an error.
    if (rules) {
      try {
        rules.restore();
      } catch (e) {
        warnings.push(`Не вдалося зняти тимчасові правила agy: ${(e as Error).message}`);
      }
    }
  }

  const outcome: Outcome = proc.spawnError
    ? { ok: false, denied: [], error: `cannot run "${cfg.agents[agent].cmd}": ${proc.spawnError}` }
    : proc.timedOut
      ? { ok: false, denied: [], error: `timeout after ${Math.round(timeoutMs / 60_000)} min` }
      : interpretOutput(agent, proc.stdout, proc.stderr);
  // A non-zero exit with an otherwise clean result is still a failure.
  if (outcome.ok && proc.code !== 0) {
    outcome.ok = false;
    outcome.error = `exit code ${proc.code}`;
  }
  return { run, proc, outcome };
}
