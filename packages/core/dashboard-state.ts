// One JSON document with everything the dashboard shows: limits, tasks, the project's chat and upload rules.
// The React dashboard polls this (GET /api/state); there is no server-rendered markup any more.
import { ACCEPTED_EXTENSIONS, LIMITS } from './attachments';
import { getChatOverview, type ChatOverview } from './chat-overview';
import { loadConfig } from './config';
import { getOverview, type Overview } from './overview';
import { getTasksOverview, type TasksOverview } from './task-overview';
import type { SwitchboardConfig } from './types';

export type UploadRules = { accept: string[]; maxFiles: number; maxFileMB: number; maxTotalMB: number };

export type DashboardState = {
  now: string;
  overview: Overview;
  tasks: TasksOverview;
  chat?: ChatOverview;
  /** True while a task or a chat turn runs: the UI polls faster. */
  busy: boolean;
  uploads: UploadRules;
};

export const uploadRules = (): UploadRules => ({
  accept: ACCEPTED_EXTENSIONS,
  maxFiles: LIMITS.count,
  maxFileMB: Math.round(LIMITS.perFile / 1048576),
  maxTotalMB: Math.round(LIMITS.total / 1048576),
});

/** `project` must already be an allowed project path (the UI only sends values from `tasks.projects`). */
export async function getDashboardState(project: string | undefined, cfg: SwitchboardConfig = loadConfig()): Promise<DashboardState> {
  const overview = await getOverview('if-stale', cfg);
  const tasks = getTasksOverview(cfg);
  const allowed = tasks.projects.find((p) => p.path === project) ?? tasks.projects[0];
  const chat = getChatOverview(allowed?.path);
  return {
    now: new Date().toISOString(),
    overview,
    tasks,
    chat,
    busy: tasks.hasRunning || chat?.active?.status === 'running',
    uploads: uploadRules(),
  };
}
