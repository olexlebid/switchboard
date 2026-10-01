// One task, one agent: branch, task file, run, interpret, commit. (Routing and failover come in stage 4.)
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkoutBranch, changedFiles, commitAll, currentBranch, dirtyFiles, headSha, isGitRepo, pushBranch, switchBack } from './git';
import { interpretOutput, type Outcome } from './interpret';
import { readProgress, type ProgressInfo } from './progress';
import { buildStartPrompt } from './prompt';
import { buildAgentArgs, logPathFor, runAgentProcess } from './runner';
import { saveRun, saveTask } from './store';
import { newTaskId, taskTitle, writeTaskFile } from './tasks';
import type { AgentId, Run, SwitchboardConfig, Task } from './types';

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
  agent?: AgentId;
  priority?: 'normal' | 'high';
  figma?: string;
  timeoutMin?: number;
};

export type StartResult = {
  task: Task;
  run: Run;
  outcome: Outcome;
  /** What the agent itself wrote in PROGRESS.md (status, open questions). */
  progress: ProgressInfo;
  files: string[];
  warnings: string[];
};

export async function startTask(input: StartInput, cfg: SwitchboardConfig, say: (s: string) => void = () => {}): Promise<StartResult> {
  const project = resolve(input.project.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  if (!existsSync(project) || !statSync(project).isDirectory()) throw new SbError(`Папки проєкту не існує: ${project}`, 2);
  if (!(await isGitRepo(project))) throw new SbError(`${project} не є git-репозиторієм.`, 2);

  const order = cfg.routing[input.type];
  if (!order) throw new SbError(`Невідомий тип задачі "${input.type}". Доступні: ${Object.keys(cfg.routing).join(', ')}.`, 2);
  const agent = input.agent ?? order[0]!;
  if (!input.text.trim()) throw new SbError('Порожній текст задачі.', 2);

  const dirty = await dirtyFiles(project);
  if (dirty.length > 0) {
    throw new SbError(
      `Робоче дерево в ${project} не чисте (${dirty.length} змін). Закоміть або відклади зміни й повтори.\n  ${dirty.slice(0, 8).join('\n  ')}`,
      3,
    );
  }

  const warnings: string[] = [];
  const baseBranch = await currentBranch(project);
  const baseSha = await headSha(project);
  const id = newTaskId();
  const task: Task = {
    id,
    text: input.text,
    type: input.type,
    project,
    priority: input.priority ?? 'normal',
    figma: input.figma,
    status: 'running',
    branch: `sb/${id}`,
    baseBranch,
    baseSha,
    agent,
    runs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await checkoutBranch(project, task.branch);
  try {
    writeTaskFile(task);
    if (!existsSync(resolve(project, 'RULES.md'))) warnings.push('У проєкті немає RULES.md: запусти `sb init <проєкт>`, щоб агенти знали правила.');
    if (cfg.permissions[agent].allow.length === 0) {
      warnings.push(`Для ${agent} не задано дозволів (permissions.${agent}.allow): запис файлів, імовірно, буде заблоковано.`);
    }

    const runId = `r-${id.slice(2)}-1`;
    const timeoutMs = (input.timeoutMin ?? cfg.run.timeoutMin) * 60_000;
    const prompt = buildStartPrompt(task);
    const args = buildAgentArgs(agent, cfg.agents[agent], prompt, cfg.permissions[agent], timeoutMs);
    const logPath = logPathFor(runId);
    const run: Run = { id: runId, taskId: id, agent, startedAt: new Date().toISOString(), status: 'running', logPath };
    task.runs.push(runId);
    saveTask(task);
    saveRun(run);

    say(`▶ ${agent}: ${taskTitle(task.text)}\n  гілка ${task.branch}, тайм-аут ${Math.round(timeoutMs / 60_000)} хв\n  лог: ${logPath}`);
    const proc = await runAgentProcess({
      cmd: cfg.agents[agent].cmd,
      args,
      cwd: project,
      timeoutMs,
      logPath,
      logHeader: `[switchboard] ${new Date().toISOString()} task=${id} agent=${agent} branch=${task.branch}\n[switchboard] ${cfg.agents[agent].cmd} ${args.map((a) => (a === prompt ? '<prompt>' : a)).join(' ')}`,
    });

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

    // The agent's own verdict in PROGRESS.md counts too: "blocked" or "in-progress" means not finished.
    const progress: ProgressInfo = outcome.ok ? readProgress(project, id) : { openQuestions: [] };
    const agentBlocked = outcome.ok && progress.status === 'blocked';
    const agentUnfinished = outcome.ok && progress.status === 'in-progress';

    const status: Run['status'] = outcome.ok && !agentBlocked ? 'done' : outcome.denied.length > 0 || agentBlocked ? 'blocked' : 'failed';
    run.status = status;
    run.endedAt = new Date().toISOString();
    run.exitCode = proc.code;
    run.summary = outcome.summary;
    run.reason = outcome.denied.length
      ? `denied: ${outcome.denied.join(', ')}`
      : agentBlocked
        ? `агент позначив blocked у PROGRESS.md${progress.openQuestions[0] ? `: ${progress.openQuestions[0]}` : ''}`
        : agentUnfinished
          ? 'агент не завершив задачу (Status: in-progress у PROGRESS.md)'
          : outcome.error;

    // Keep whatever the agent produced: a final commit only for a finished task, a checkpoint otherwise.
    const finished = outcome.ok && !agentBlocked && !agentUnfinished;
    const message = finished
      ? `feat(sb): ${taskTitle(task.text)} [${id}]`
      : `wip(sb): checkpoint ${id} from ${agent}`;
    const sha = await commitAll(project, message);
    const files = await changedFiles(project, baseSha);
    if (outcome.ok && !files.includes('PROGRESS.md')) warnings.push('Агент не оновив PROGRESS.md.');
    if (outcome.ok && !sha) warnings.push('Агент нічого не змінив: комітити нічого.');

    if (cfg.git.pushBranches && files.length > 0) {
      try {
        await pushBranch(project, task.branch);
      } catch (e) {
        warnings.push(`push не вдався: ${(e as Error).message}`);
      }
    }

    task.status = agentUnfinished ? 'waiting' : status === 'done' ? 'done' : status === 'blocked' ? 'blocked' : 'failed';
    task.note = run.reason ?? run.summary?.slice(0, 200);
    saveRun(run);
    saveTask(task);
    return { task, run, outcome, progress, files, warnings };
  } catch (e) {
    // Never leave a task stuck in "running" when the orchestrator itself failed.
    task.status = 'failed';
    task.note = (e as Error).message.slice(0, 200);
    saveTask(task);
    throw e;
  } finally {
    // Leave the project on the branch it was on before, with the task branch intact.
    try {
      if ((await currentBranch(project)) !== baseBranch) await switchBack(project, baseBranch);
    } catch (e) {
      warnings.push(`не вдалося повернутися на ${baseBranch}: ${(e as Error).message}`);
    }
  }
}
