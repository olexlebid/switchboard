// One JSON document with everything the dashboard shows: limits, tasks, the chats, models and upload rules.
// The React dashboard polls this (GET /api/state); there is no server-rendered markup any more.
import { ACCEPTED_EXTENSIONS, LIMITS } from './attachments';
import { getChatOverview, type ChatOverview } from './chat-overview';
import { loadConfig } from './config';
import { getModels } from './models';
import { getOverview, type Overview } from './overview';
import { getTasksOverview, type TasksOverview } from './task-overview';
import type { AgentId, ModelOption, SwitchboardConfig } from './types';

export type UploadRules = { accept: string[]; maxFiles: number; maxFileMB: number; maxTotalMB: number };

export type DashboardState = {
  now: string;
  overview: Overview;
  tasks: TasksOverview;
  chat: ChatOverview;
  /** Models per agent for the chat's model picker (agy: from `agy models`, cached). */
  models: Record<AgentId, ModelOption[]>;
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

/** `chatId`: the conversation to show in full (default: the most recent chat). */
export async function getDashboardState(chatId?: string, cfg: SwitchboardConfig = loadConfig()): Promise<DashboardState> {
  const overview = await getOverview('if-stale', cfg);
  const tasks = getTasksOverview(cfg);
  const chat = getChatOverview(chatId);
  return {
    now: new Date().toISOString(),
    overview,
    tasks,
    chat,
    models: getModels(cfg),
    busy: tasks.hasRunning || chat.chats.some((c) => c.status === 'running'),
    uploads: uploadRules(),
  };
}
