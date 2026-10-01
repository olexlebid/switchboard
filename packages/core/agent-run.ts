// Runs one agent process once: argv, temporary agy rules, log, timeout, output interpretation.
// Shared by tasks (flow.ts) and chat turns (chat.ts).
import { realpathSync } from 'node:fs';
import { AgyPermissionError, applyAgyRules, DEFAULT_AGY_SETTINGS, recoverAgyRules, type AgyRuleHandle } from './agy-permissions';
import { SbError } from './errors';
import { interpretOutput, type Outcome } from './interpret';
import { buildAgentArgs, logPathFor, runAgentProcess, type ProcessResult } from './runner';
import type { AgentId, SwitchboardConfig } from './types';

export type AgentRunInput = {
  cfg: SwitchboardConfig;
  agent: AgentId;
  project: string;
  prompt: string;
  runId: string;
  timeoutMs: number;
  /** Continue this agent-side conversation. */
  sessionId?: string;
  say: (s: string) => void;
  warnings: string[];
  /** Extra text for the first log header line, e.g. "(continuation)". */
  logNote?: string;
  now?: () => Date;
};

export type AgentRunResult = { proc: ProcessResult; outcome: Outcome; logPath: string };

export async function runAgentOnce(input: AgentRunInput): Promise<AgentRunResult> {
  const { cfg, agent, project, prompt, runId, timeoutMs, say, warnings } = input;
  const args = buildAgentArgs(agent, cfg.agents[agent], prompt, cfg.permissions[agent], timeoutMs, input.sessionId);
  const logPath = logPathFor(runId);

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
      logHeader: `[switchboard] ${(input.now?.() ?? new Date()).toISOString()} run=${runId} agent=${agent}${input.logNote ? ` ${input.logNote}` : ''}\n[switchboard] ${cfg.agents[agent].cmd} ${args.map((a) => (a === prompt ? '<prompt>' : a)).join(' ')}`,
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
  return { proc, outcome, logPath };
}
