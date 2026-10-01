// Prompts sent to agents. Written in English (more stable for the models); the language of the
// site texts is whatever the task says.
import type { Task } from './types';

const PREAMBLE = (task: Task) => `You are working on a web project (Astro) through an automated orchestrator. Task id: ${task.id}.

Before you start:
1. Read RULES.md (project rules) and DESIGN.md (design tokens) if they exist.
2. Read .sb/tasks/${task.id}.md (the task) and PROGRESS.md (what has been done so far) if it exists.

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

/** First-run prompt: preamble plus the task text. */
export function buildStartPrompt(task: Task): string {
  return `${PREAMBLE(task)}\n\n---\nTASK (${task.type}${task.priority === 'high' ? ', high priority' : ''}):\n\n${task.text.trim()}\n${task.figma ? `\nFigma frame: ${task.figma}\n` : ''}`;
}
