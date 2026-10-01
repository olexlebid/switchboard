// Task creation helpers: ids, titles, and the .sb/tasks/<id>.md file that agents read.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from './types';

/** "t-20261001-0742-k3f": sortable by time, short enough to type. */
export function newTaskId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `t-${stamp}-${Math.random().toString(36).slice(2, 5)}`;
}

export function taskTitle(text: string, max = 70): string {
  const first = (text.split('\n')[0] ?? '').trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

const DONE_CRITERIA: Record<string, string[]> = {
  section: [
    'The section matches DESIGN.md tokens (no hard-coded colors, sizes or spacing).',
    'Semantic markup, BEM class names, responsive at the breakpoints listed in DESIGN.md.',
    '`pnpm build` finishes without errors or warnings (if the project has a build script).',
  ],
  copy: ['Texts are in the language named in the task.', 'No placeholder text is left.'],
  review: ['Findings are listed in PROGRESS.md, ordered by severity, with file paths.', 'Do not rewrite code unless the task asks for fixes.'],
  qa: ['Findings are listed in PROGRESS.md: accessibility, responsive issues, performance notes.'],
  research: ['Findings and sources are written to the file named in the task (or PROGRESS.md).'],
  ideas: ['Ideas are written to the file named in the task (or PROGRESS.md), each with a short rationale.'],
};

export function taskFileContent(task: Task): string {
  const criteria = DONE_CRITERIA[task.type] ?? ['The result satisfies the description above.'];
  return [
    `# Task ${task.id}: ${taskTitle(task.text)}`,
    '',
    `- Type: ${task.type}`,
    `- Priority: ${task.priority}`,
    `- Branch: ${task.branch}`,
    ...(task.figma ? [`- Figma frame: ${task.figma}`] : []),
    '',
    '## Description',
    '',
    task.text.trim(),
    '',
    '## Definition of done',
    '',
    ...criteria.map((c) => `- ${c}`),
    '',
  ].join('\n');
}

/** Writes .sb/tasks/<id>.md inside the project and returns its relative path. */
export function writeTaskFile(task: Task): string {
  const rel = join('.sb', 'tasks', `${task.id}.md`);
  mkdirSync(join(task.project, '.sb', 'tasks'), { recursive: true });
  writeFileSync(join(task.project, rel), taskFileContent(task));
  return rel;
}
