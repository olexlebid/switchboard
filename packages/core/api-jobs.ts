// Prompt jobs of the public API: one job = one user message of a chat. Read-only unless `write: true`.
// The HTTP layer (api-server.ts) only validates and serializes; everything that touches chats lives here.
import { basename } from 'node:path';
import { createChat, setChatMode, setChatModel } from './chat';
import { reconcile } from './chat-overview';
import { sendChatMessage, stopChat } from './launch';
import { maskSecrets } from './mask';
import { getModels, isKnownModel } from './models';
import { readState, updateChat } from './store';
import { allowedProjects } from './task-overview';
import { AGENT_IDS, isAgentId, type AgentId, type Chat, type ChatMessage, type SwitchboardConfig } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const MAX_PROMPT = 8000;
export const MAX_WAIT_SEC = 25;

export type PromptRequest = {
  prompt?: unknown;
  project?: unknown;
  agent?: unknown;
  model?: unknown;
  write?: unknown;
  wait?: unknown;
  chat?: unknown;
};

export type JobStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export type PromptJob = {
  id: string;
  chat: string;
  status: JobStatus;
  agent?: AgentId;
  model?: string;
  project: string;
  write: boolean;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  answer?: string;
  error?: string;
  files?: string[];
  branch?: string;
  waitUntil?: string;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Hides the absolute project path (and secrets) in text that is sent out. */
function clean(text: string, chat: Chat): string {
  return maskSecrets(text.replaceAll(chat.project, basename(chat.project)));
}

function jobOf(chat: Chat, message: ChatMessage): PromptJob {
  const idx = chat.messages.findIndex((m) => m.id === message.id);
  const after = chat.messages.slice(idx + 1);
  const reply = after.find((m) => m.role === 'agent');
  const failure = after.find((m) => m.role === 'system');
  let status: JobStatus;
  if (message.status === 'done') status = 'done';
  else if (message.status === 'running') status = 'running';
  else if (message.status === 'failed') status = failure && /Зупинено|Скасовано/.test(failure.text) ? 'cancelled' : 'failed';
  else status = chat.status === 'waiting' ? 'waiting' : 'queued';

  const end = status === 'done' ? reply : status === 'failed' || status === 'cancelled' ? failure : undefined;
  const agent = reply?.agent ?? chat.lastAgent ?? (chat.mode === 'auto' ? undefined : chat.mode);
  return {
    id: message.id,
    chat: chat.id,
    status,
    agent,
    model: agent ? chat.models?.[agent] : undefined,
    project: basename(chat.project),
    write: !chat.readOnly,
    createdAt: message.at,
    finishedAt: end?.at,
    durationMs: end ? Math.max(0, Date.parse(end.at) - Date.parse(message.at)) : undefined,
    answer: status === 'done' && reply ? clean(reply.text, chat) : undefined,
    error: status === 'failed' || status === 'cancelled' ? clean(failure?.text ?? 'Невідома помилка.', chat) : undefined,
    files: reply?.files?.length ? reply.files : undefined,
    branch: chat.readOnly ? undefined : chat.branch,
    waitUntil: status === 'waiting' ? chat.waitUntil : undefined,
  };
}

/** Finds a job by its message id (message ids are unique across chats). */
export function getJob(id: string): PromptJob | undefined {
  for (const c of Object.values(readState().chats)) {
    if (c.source !== 'api' || !c.messages.some((m) => m.id === id && m.role === 'user')) continue;
    reconcile(c); // frees a turn whose process died
    const fresh = readState().chats[c.id]!;
    const msg = fresh.messages.find((m) => m.id === id)!;
    return jobOf(fresh, msg);
  }
  return undefined;
}

const TERMINAL: JobStatus[] = ['done', 'failed', 'cancelled'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** API jobs that are queued or running right now (for the concurrency cap). */
export function activeJobs(): number {
  return Object.values(readState().chats).filter(
    (c) => c.source === 'api' && c.messages.some((m) => m.role === 'user' && (m.status === 'pending' || m.status === 'running')),
  ).length;
}

function resolveProject(cfg: SwitchboardConfig, input: string | undefined): string {
  const list = allowedProjects(cfg);
  if (!input) {
    if (list.length === 1) return list[0]!.path;
    throw new ApiError(400, 'project_required', `Вкажи "project": одне з ${list.map((p) => p.name).join(', ') || '(проєктів немає)'}.`);
  }
  const found = list.find((p) => p.name === input || p.path === input);
  if (!found) throw new ApiError(400, 'unknown_project', `Невідомий проєкт. Доступні: ${list.map((p) => p.name).join(', ') || '(немає)'}.`);
  return found.path;
}

/** Creates (or continues) a chat, queues the prompt and optionally waits a few seconds for the answer. */
export async function createPrompt(cfg: SwitchboardConfig, req: PromptRequest): Promise<PromptJob> {
  const prompt = str(req.prompt);
  if (!prompt) throw new ApiError(400, 'prompt_required', 'Поле "prompt" обов’язкове.');
  if (prompt.length > MAX_PROMPT) throw new ApiError(400, 'prompt_too_long', `"prompt" задовгий (максимум ${MAX_PROMPT} символів).`);

  const agentRaw = req.agent === undefined ? 'auto' : req.agent;
  if (agentRaw !== 'auto' && !isAgentId(agentRaw)) throw new ApiError(400, 'unknown_agent', `"agent": ${AGENT_IDS.join(', ')} або auto.`);
  const mode = agentRaw as 'auto' | AgentId;
  const model = req.model === undefined || req.model === null || req.model === '' ? undefined : str(req.model);
  if (req.model !== undefined && req.model !== null && req.model !== '' && !model) throw new ApiError(400, 'bad_model', '"model" має бути рядком.');
  if (model && mode === 'auto') throw new ApiError(400, 'model_needs_agent', `Щоб вибрати "model", вкажи конкретного "agent" (${AGENT_IDS.join(', ')}).`);
  if (model && mode !== 'auto' && !isKnownModel(cfg, mode, model)) {
    const known = getModels(cfg)[mode].map((m) => m.id).join(', ');
    throw new ApiError(400, 'unknown_model', `Моделі "${model}" немає в списку ${mode}${known ? `: ${known}` : ''}.`);
  }
  if (req.write !== undefined && typeof req.write !== 'boolean') throw new ApiError(400, 'bad_write', '"write" має бути true або false.');
  const wait = req.wait === undefined ? 0 : Number(req.wait);
  if (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_SEC) throw new ApiError(400, 'bad_wait', `"wait": 0..${MAX_WAIT_SEC} секунд.`);

  if (activeJobs() >= cfg.api.maxConcurrent) throw new ApiError(429, 'too_many_jobs', 'Забагато одночасних запитів. Повтори пізніше.');

  let chat: Chat;
  const chatId = str(req.chat);
  let write: boolean;
  if (chatId) {
    const existing = readState().chats[chatId];
    if (!existing || existing.source !== 'api') throw new ApiError(404, 'unknown_chat', 'Такої API-розмови немає.');
    chat = existing;
    write = typeof req.write === 'boolean' ? req.write : !chat.readOnly;
    if (write === Boolean(chat.readOnly)) throw new ApiError(409, 'write_mismatch', 'Ця розмова створена з іншим режимом "write": почни нову розмову.');
    if (mode !== 'auto') setChatMode(chat.id, mode);
    if (model && mode !== 'auto') setChatModel(chat.id, mode, model);
  } else {
    write = req.write === true;
    if (write && !cfg.api.allowWrite) throw new ApiError(403, 'write_disabled', 'Режим "write" вимкнено в конфігурації (api.allowWrite).');
    const project = resolveProject(cfg, str(req.project));
    chat = await createChat({
      project,
      mode,
      title: `API: ${prompt.replace(/\s+/g, ' ').slice(0, 50)}`,
      readOnly: !write,
      source: 'api',
      models: model && mode !== 'auto' ? { [mode]: model } : undefined,
    }).catch((e: Error) => { throw new ApiError(500, 'chat_failed', e.message); });
  }
  if (write && !cfg.api.allowWrite) throw new ApiError(403, 'write_disabled', 'Режим "write" вимкнено в конфігурації (api.allowWrite).');

  const sent = await sendChatMessage(cfg, chat.id, prompt, undefined, { readOnly: !write });
  if (!sent.ok) {
    const code = sent.blocked ? 'tree_dirty' : sent.status === 409 ? 'busy' : 'rejected';
    throw new ApiError(sent.status === 400 ? 400 : 409, code, sent.error);
  }
  const fresh = readState().chats[chat.id]!;
  const message = [...fresh.messages].reverse().find((m) => m.role === 'user')!;

  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const job = getJob(message.id)!;
    if (TERMINAL.includes(job.status) || Date.now() >= deadline) return job;
    await sleep(300);
  }
}

/** Stops a running job or cancels a queued one. */
export function cancelJob(id: string): PromptJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  if (job.status === 'running') {
    stopChat(job.chat);
  } else if (job.status === 'queued' || job.status === 'waiting') {
    updateChat(job.chat, (c) => {
      const m = c.messages.find((x) => x.id === id);
      if (m) m.status = 'failed';
      c.status = 'idle';
      c.waitUntil = undefined;
      c.messages.push({ id: `m-cancel-${Date.now()}`, role: 'system', text: 'Скасовано через API.', at: new Date().toISOString() });
    });
  }
  return getJob(id);
}

