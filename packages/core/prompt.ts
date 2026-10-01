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
