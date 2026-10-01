// Reads the agent's own status for a task from PROGRESS.md (protocol section "## Task <id>: ...").
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProgressStatus = 'in-progress' | 'blocked' | 'done';

export type ProgressInfo = {
  status?: ProgressStatus;
  openQuestions: string[];
};

/** Extracts the section for `taskId`; undefined status means the agent wrote no usable section. */
export function parseProgress(text: string, taskId: string): ProgressInfo {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Task\s+/i.test(l) && l.includes(taskId));
  if (start === -1) return { openQuestions: [] };
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end === -1) end = lines.length;
  const section = lines.slice(start + 1, end);

  const statusLine = section.find((l) => /^\s*-\s*Status:/i.test(l));
  const raw = statusLine?.split(':')[1]?.trim().toLowerCase().replace(/\s+/g, '-');
  const status = raw === 'done' || raw === 'blocked' || raw === 'in-progress' ? raw : undefined;

  const qStart = section.findIndex((l) => /^\s*-\s*Open questions:/i.test(l));
  const openQuestions: string[] = [];
  if (qStart !== -1) {
    for (const l of section.slice(qStart + 1)) {
      // Sub-items are indented deeper than the "- Open questions:" bullet.
      const m = /^\s{2,}-\s+(.*\S)\s*$/.exec(l);
      if (!m) break;
      openQuestions.push(m[1]!);
    }
  }
  return { status, openQuestions };
}

export function readProgress(project: string, taskId: string): ProgressInfo {
  const path = join(project, 'PROGRESS.md');
  if (!existsSync(path)) return { openQuestions: [] };
  return parseProgress(readFileSync(path, 'utf8'), taskId);
}
