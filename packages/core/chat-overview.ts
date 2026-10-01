// What the dashboard shows about chats: the project's chat list and the active conversation.
import { basename } from 'node:path';
import { renderMarkdown } from './markdown';
import { AGENT_TITLES } from './overview';
import { readState, updateChat, updateState } from './store';
import type { AgentId, Chat } from './types';

export type ChatListItem = { id: string; title: string; updatedAt: string; turns: number };

export type ChatMessageView = {
  id: string;
  role: 'user' | 'agent' | 'system';
  /** Plain text (user messages are shown as text). */
  text: string;
  /** Safe HTML for agent replies (escaped, small markdown subset); empty for other roles. */
  html: string;
  at: string;
  agent?: AgentId;
  agentTitle?: string;
  files: string[];
  attachments: { name: string; kind: string }[];
  status?: string;
};

export type ChatView = {
  id: string;
  title: string;
  project: string;
  projectName: string;
  branch: string;
  mode: 'auto' | AgentId;
  status: Chat['status'];
  waitUntil?: string;
  /** Start of the running turn (the UI shows the elapsed time from here). */
  runningSince?: string;
  lastAgent?: AgentId;
  canStop: boolean;
  messages: ChatMessageView[];
};

export type ChatOverview = { project: string; chats: ChatListItem[]; active?: ChatView };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A chat stuck in "running" whose process is gone (kill -9, reboot) is freed again. */
function reconcile(chat: Chat): void {
  if (chat.status !== 'running' || (chat.pid && processAlive(chat.pid))) return;
  updateChat(chat.id, (c) => {
    c.status = 'idle';
    c.pid = undefined;
    for (const m of c.messages) if (m.role === 'user' && m.status === 'running') m.status = 'failed';
    c.messages.push({ id: `m-lost-${Date.now()}`, role: 'system', text: 'Процес відповіді зник (збій або перезавантаження). Надішли повідомлення ще раз.', at: new Date().toISOString() });
  });
}

function viewOf(chat: Chat): ChatView {
  const running = chat.status === 'running';
  const runningMessage = chat.messages.find((m) => m.role === 'user' && m.status === 'running');
  return {
    id: chat.id,
    title: chat.title,
    project: chat.project,
    projectName: basename(chat.project),
    branch: chat.branch,
    mode: chat.mode,
    status: chat.status,
    waitUntil: chat.waitUntil,
    runningSince: running ? runningMessage?.at : undefined,
    lastAgent: chat.lastAgent,
    canStop: running && Boolean(chat.pid),
    messages: chat.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      html: m.role === 'agent' ? renderMarkdown(m.text) : '',
      at: m.at,
      agent: m.agent,
      agentTitle: m.agent ? AGENT_TITLES[m.agent] : undefined,
      files: m.files ?? [],
      attachments: (m.attachments ?? []).map((a) => ({ name: a.name, kind: a.kind })),
      status: m.status,
    })),
  };
}

export function getChatOverview(project: string | undefined): ChatOverview | undefined {
  if (!project) return undefined;
  for (const c of Object.values(readState().chats)) if (c.project === project) reconcile(c);
  const state = readState();
  const chats = Object.values(state.chats)
    .filter((c) => c.project === project)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const activeId = state.activeChats[project];
  const active = (activeId && state.chats[activeId]) || chats[0];
  return {
    project,
    chats: chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, turns: c.turns })),
    active: active ? viewOf(active) : undefined,
  };
}

/** Makes `chatId` the chat shown for its project. */
export function selectChat(chatId: string): boolean {
  const chat = readState().chats[chatId];
  if (!chat) return false;
  updateState((s) => { s.activeChats[chat.project] = chatId; });
  return true;
}
