// What the dashboard shows about chats: every chat (all projects) as a tab/list item and the selected conversation.
import { basename } from 'node:path';
import { renderMarkdown } from './markdown';
import { AGENT_TITLES } from './overview';
import { readState, updateChat, updateState } from './store';
import type { AgentId, Chat } from './types';

export type ChatListItem = {
  id: string;
  title: string;
  project: string;
  projectName: string;
  status: Chat['status'];
  mode: 'auto' | AgentId;
  lastAgent?: AgentId;
  /** Display name of the agent that answered last (or the fixed one); absent in "auto" before the first reply. */
  agentTitle?: string;
  updatedAt: string;
  turns: number;
  /** Start of the running turn (elapsed time in the activity list). */
  runningSince?: string;
  waitUntil?: string;
  /** First line of the latest agent reply, for the "recent" list. */
  lastReply?: string;
  /** Public-API chat; `readOnly` ones can only answer (no branch, no commits). */
  source?: 'api';
  readOnly?: boolean;
};

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
  /** Branch the chat started from; "merge into" targets it. */
  baseBranch: string;
  mode: 'auto' | AgentId;
  status: Chat['status'];
  waitUntil?: string;
  /** Start of the running turn (the UI shows the elapsed time from here). */
  runningSince?: string;
  lastAgent?: AgentId;
  /** Model chosen per agent in this chat (absent = the agent's default). */
  models: Partial<Record<AgentId, string>>;
  readOnly?: boolean;
  source?: 'api';
  canStop: boolean;
  messages: ChatMessageView[];
};

export type ChatOverview = { chats: ChatListItem[]; active?: ChatView };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A chat stuck in "running" whose process is gone (kill -9, reboot) is freed again. */
export function reconcile(chat: Chat): void {
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
    baseBranch: chat.baseBranch,
    mode: chat.mode,
    status: chat.status,
    waitUntil: chat.waitUntil,
    runningSince: running ? runningMessage?.at : undefined,
    lastAgent: chat.lastAgent,
    models: chat.models ?? {},
    readOnly: chat.readOnly,
    source: chat.source,
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

const firstLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 120);

function itemOf(c: Chat): ChatListItem {
  const running = c.status === 'running';
  const lastAgentMessage = [...c.messages].reverse().find((m) => m.role === 'agent');
  const agent = c.lastAgent ?? (c.mode === 'auto' ? undefined : c.mode);
  return {
    id: c.id,
    title: c.title,
    project: c.project,
    projectName: basename(c.project),
    status: c.status,
    mode: c.mode,
    lastAgent: c.lastAgent,
    agentTitle: agent ? AGENT_TITLES[agent] : undefined,
    updatedAt: c.updatedAt,
    turns: c.turns,
    runningSince: running ? c.messages.find((m) => m.role === 'user' && m.status === 'running')?.at : undefined,
    waitUntil: c.waitUntil,
    lastReply: lastAgentMessage ? firstLine(lastAgentMessage.text) : undefined,
    source: c.source,
    readOnly: c.readOnly,
  };
}

/** All chats, newest first, and the conversation of `chatId` (default: the most recently updated chat). */
export function getChatOverview(chatId?: string): ChatOverview {
  for (const c of Object.values(readState().chats)) reconcile(c);
  const chats = Object.values(readState().chats).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const active = (chatId && chats.find((c) => c.id === chatId)) || chats[0];
  return { chats: chats.slice(0, 60).map(itemOf), active: active ? viewOf(active) : undefined };
}

/** Makes `chatId` the chat shown for its project. */
export function selectChat(chatId: string): boolean {
  const chat = readState().chats[chatId];
  if (!chat) return false;
  updateState((s) => { s.activeChats[chat.project] = chatId; });
  return true;
}
