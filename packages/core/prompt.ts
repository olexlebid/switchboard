// Prompts sent to agents. Written in English (more stable for the models); the language of the
// site texts is whatever the task says.
import type { AgentId, Task } from './types';

export type PromptContext = {
  agent: AgentId;
  /** Project files (relative paths) that exist right now; the orchestrator checked them. */
  existing: string[];
};

const PREAMBLE = (task: Task, ctx: PromptContext) => `You are working on a web project (Astro) through an automated orchestrator. Task id: ${task.id}.

Before you start, read these project files (they exist, no need to check):
${readList(task, ctx)}
${missingNote(task, ctx)}${ctx.agent === 'agy' ? NO_SHELL : ''}
Hard rules:
- Work only inside this project directory, on the current git branch (${task.branch}).
- Do NOT run git commit, push, merge, rebase, reset, checkout or deploy. The orchestrator commits for you.
- Do NOT install or remove dependencies and do NOT edit netlify.toml.
- Do not read or print secrets (.env files, tokens).
- If something is missing or unclear (a token, a breakpoint, a color), do not invent it: write it under "Open questions" in PROGRESS.md and continue with the rest.

When you finish, add or update this section in PROGRESS.md (create the file if needed):

## Task ${task.id}: <short title>
- Status: in-progress | blocked | done
- Last agent: <claude | agy>
- Done:
  - [x] <finished item (file path)>
- Next:
  - [ ] <what remains>
- Decisions:
  - <decision and why>
- Open questions:
  - <question>

Update PROGRESS.md after each finished item, not only at the end.`;

const NO_SHELL = `
You have NO shell access in this environment: do not run shell commands (no ls, cat, git, pnpm, node). Read and write files with your file tools only. Skip any verification step that needs a command and list it under "Open questions" in PROGRESS.md.
`;

function readList(task: Task, ctx: PromptContext): string {
  const have = (f: string) => ctx.existing.includes(f);
  const files = ['RULES.md', 'DESIGN.md', `.sb/tasks/${task.id}.md`, 'PROGRESS.md'].filter(have);
  return files.map((f, i) => `${i + 1}. ${f}`).join('\n');
}

function missingNote(task: Task, ctx: PromptContext): string {
  const missing = ['RULES.md', 'DESIGN.md', 'PROGRESS.md'].filter((f) => !ctx.existing.includes(f));
  return missing.length ? `Not present in this project: ${missing.join(', ')}. Do not look for them${missing.includes('PROGRESS.md') ? '; create PROGRESS.md when you finish' : ''}.\n` : '';
}

/** First-run prompt: preamble plus the task text. */
export function buildStartPrompt(task: Task, ctx: PromptContext): string {
  return `${PREAMBLE(task, ctx)}\n\n---\nTASK (${task.type}${task.priority === 'high' ? ', high priority' : ''}):\n\n${task.text.trim()}\n${task.figma ? `\nFigma frame: ${task.figma}\n` : ''}`;
}

/**
 * Prompt for the agent that takes over after another one hit its usage limit. Shell-less agents (agy)
 * cannot run git, so they get the changed-file list from the Handoff note in PROGRESS.md instead.
 */
export function buildContinuePrompt(task: Task, ctx: PromptContext, baseSha: string): string {
  const inspect =
    ctx.agent === 'agy'
      ? `2. You cannot run git here. Open the "Handoff" section at the end of PROGRESS.md: it lists the changed files (git diff --stat) and the previous agent's last output. Read those files to see what exists.`
      : `2. Run \`git log --oneline -5\` and \`git diff ${baseSha.slice(0, 12)}..HEAD --stat\` to see what exists.`;
  return `${PREAMBLE(task, ctx)}

---
You are continuing a task started by another AI agent that hit its usage limit.
1. Read RULES.md, DESIGN.md, .sb/tasks/${task.id}.md and PROGRESS.md.
${inspect}
3. Do not redo finished items. Continue from "Next".
4. Keep the existing code style; do not refactor what the previous agent wrote unless it is broken.
5. Update PROGRESS.md after each finished item.

ORIGINAL TASK (${task.type}${task.priority === 'high' ? ', high priority' : ''}):

${task.text.trim()}
${task.figma ? `\nFigma frame: ${task.figma}\n` : ''}`;
}
