// Checkpoint when an agent stops (usage limit): commit its work and leave a note in PROGRESS.md
// so the next agent can continue from the same place.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, dirtyFiles, stageAll, stagedStat } from './git';
import type { Outcome } from './interpret';
import { lastLines } from './limit-detect';
import { maskSecrets } from './mask';
import type { AgentId, Task } from './types';

const MAX_LINE = 400;

/** The last ~40 lines of what the agent said or printed, masked and with very long lines cut. */
export function outputTail(stdout: string, stderr: string, outcome: Outcome, lines = 40): string {
  const parts = [outcome.summary ?? '', lastLines(stderr, 15), lastLines(stdout, lines)].filter(Boolean);
  const text = lastLines(parts.join('\n'), lines)
    .split('\n')
    .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l))
    .join('\n');
  return maskSecrets(text);
}

export type CheckpointInput = {
  project: string;
  task: Task;
  from: AgentId;
  to?: AgentId;
  reason: string;
  resetsAt?: string;
  tail: string;
  now?: Date;
};

export type CheckpointResult = {
  sha?: string;
  /** True when the orchestrator had to write the Handoff section (the agent had not updated PROGRESS.md). */
  noteAdded: boolean;
};

/**
 * Commits everything the agent produced as `wip(sb): checkpoint <id> from <agent>`.
 * If the agent did not touch PROGRESS.md during this run, a "Handoff" section is appended first;
 * if it did, its own notes are left exactly as they are.
 */
export async function writeCheckpoint(input: CheckpointInput): Promise<CheckpointResult> {
  const { project, task } = input;
  const agentUpdated = (await dirtyFiles(project)).some((l) => /(^|\s|\/)PROGRESS\.md$/.test(l));

  let noteAdded = false;
  if (!agentUpdated) {
    await stageAll(project);
    const stat = await stagedStat(project, task.baseSha);
    const now = (input.now ?? new Date()).toISOString();
    const block = [
      '',
      `## Handoff ${task.id}: ${input.from} → ${input.to ?? 'next agent'}`,
      `- Time: ${now}`,
      `- Reason: ${input.reason}${input.resetsAt ? ` (resets ${input.resetsAt})` : ''}`,
      '- Changed files since the task started (git diff --stat):',
      '',
      '```',
      stat || '(no file changes yet)',
      '```',
      '',
      `- Last output of ${input.from} (about 40 lines):`,
      '',
      '```',
      input.tail || '(no output)',
      '```',
      '',
    ].join('\n');
    const path = join(project, 'PROGRESS.md');
    if (existsSync(path)) appendFileSync(path, block);
    else writeFileSync(path, `# Progress\n${block}`);
    noteAdded = true;
  }
  const sha = await commitAll(project, `wip(sb): checkpoint ${task.id} from ${input.from}`);
  return { sha, noteAdded };
}
