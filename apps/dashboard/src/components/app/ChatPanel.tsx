// The chat: a chat list on the left (new chat on top), the conversation on the right with agent and model pickers;
// the agent may edit project files (branch sb/c-…). Attachments, stop button. Replies are rendered from the server's safe markdown subset.
import { Clock, FilePen, GitMerge, MessageSquarePlus, RotateCcw, Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessageView, ChatOverview } from '@core/chat-overview';
import type { UploadRules } from '@core/dashboard-state';
import { isAgentId, type AgentId, type ModelOption } from '@core/types';
import { formatDuration } from '@core/time';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Card } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { post, type ActionResult, type OnResult } from '@/lib/api';
import { cn } from 'cn';
import { AttachButton, AttachChips, dropHandlers } from './AttachPicker';
import type { MergeTarget } from './MergeDialog';

type Project = { path: string; name: string };

type Props = {
  chat: ChatOverview;
  activeId?: string;
  projects: Project[];
  models: Record<AgentId, ModelOption[]>;
  rules: UploadRules;
  now: number;
  onResult: OnResult;
  onMerge: (t: MergeTarget) => void;
  onSelect: (id: string) => void;
  onNew: (project: string) => void;
  reload: () => Promise<void>;
};

const DEFAULT_MODEL = '__default';

// Tailwind classes for the markdown subset (no typography plugin: the shadcn way is plain utilities).
const MARKDOWN =
  'text-sm [&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_strong]:font-semibold ' +
  '[&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-background [&_pre]:p-2 [&_pre_code]:p-0';

function Message({ m }: { m: ChatMessageView }) {
  const time = new Date(m.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  if (m.role === 'system') {
    return <p className="mx-auto max-w-[90%] rounded-md bg-muted px-3 py-1.5 text-center text-xs text-muted-foreground">{m.text}</p>;
  }
  const mine = m.role === 'user';
  return (
    <div className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {!mine && m.agentTitle && <Badge variant="outline">{m.agentTitle}</Badge>}
        <time dateTime={m.at}>{time}</time>
        {mine && m.status === 'failed' && <Badge variant="destructive">не виконано</Badge>}
        {mine && m.status === 'pending' && <Badge variant="secondary">у черзі</Badge>}
      </div>
      <div className={cn('max-w-[92%] rounded-xl px-3 py-2', mine ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
        {mine ? <p className="whitespace-pre-wrap text-sm">{m.text}</p> : <div className={MARKDOWN} dangerouslySetInnerHTML={{ __html: m.html }} />}
        {m.attachments.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Вкладення">
            {m.attachments.map((a) => <li key={a.name}><Badge variant={mine ? 'secondary' : 'outline'}>{a.name}</Badge></li>)}
          </ul>
        )}
      </div>
      {m.files.length > 0 && (
        <p className="flex max-w-[92%] flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <FilePen className="size-3" aria-hidden="true" /> Змінено:
          {m.files.map((f) => <code key={f} className="rounded bg-muted px-1">{f}</code>)}
        </p>
      )}
    </div>
  );
}

export function ChatPanel({ chat, activeId, projects, models, rules, now, onResult, onMerge, onSelect, onNew, reload }: Props) {
  // Only show a conversation that is really the selected tab (the data may still be loading after a switch).
  const active = chat.active && chat.active.id === activeId ? chat.active : undefined;
  // Drafts are kept per chat, so switching tabs never loses what was typed.
  const [drafts, setDrafts] = useState<Record<string, { text: string; files: File[] }>>({});
  const draft = (active && drafts[active.id]) || { text: '', files: [] };
  const setDraft = (id: string, next: { text?: string; files?: File[] }) => setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? { text: '', files: [] }), ...next } }));
  const text = draft.text;
  const files = draft.files;
  const [sending, setSending] = useState(false);
  const mode = active?.mode ?? 'auto';
  const viewport = useRef<HTMLDivElement>(null);
  const running = active?.status === 'running';
  const lastId = active?.messages.at(-1)?.id;

  // Keep the newest message in view.
  useEffect(() => {
    const el = viewport.current?.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]');
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, running, active?.id]);

  const act = async (data: Record<string, string | undefined>, sendFiles: File[] = [], retry?: () => void) => {
    const r = await post('/api/chat', data, sendFiles);
    if (!r.ok || r.message) onResult(r, retry);
    await reload();
    return r;
  };

  const send = async () => {
    if (!active || sending || running || (!text.trim() && files.length === 0)) return;
    setSending(true);
    await sendTo(active.id, text, files);
    setSending(false);
  };

  // `sendTo` is also the retry after the user stashes a dirty tree: same chat, same text and files.
  const sendTo = async (chatId: string, body: string, attached: File[]): Promise<void> => {
    const r = await act({ op: 'send', chat: chatId, text: body }, attached, () => void sendTo(chatId, body, attached));
    if (r.ok) setDraft(chatId, { text: '', files: [] });
  };

  const drop = dropHandlers({ files, rules, onChange: (f) => active && setDraft(active.id, { files: f }), onProblem: (message) => onResult({ ok: false, error: message }) });
  const waitingLeft = active?.waitUntil ? Date.parse(active.waitUntil) - now : undefined;
  const modelList = mode === 'auto' ? [] : models[mode];
  const chosenModel = mode === 'auto' ? undefined : active?.models[mode];

  // "New chat": one project creates it right away, several open a small project menu.
  const newChatButton =
    projects.length === 1 ? (
      <Button variant="outline" className="w-full justify-start" onClick={() => onNew(projects[0]!.path)}><MessageSquarePlus aria-hidden="true" /> Новий чат</Button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-start" disabled={projects.length === 0}><MessageSquarePlus aria-hidden="true" /> Новий чат</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Проєкт нового чату</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {projects.map((p) => <DropdownMenuItem key={p.path} onSelect={() => onNew(p.path)}>{p.name}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    );

  return (
    <Card size="sm" className="h-full gap-0 overflow-hidden py-0" {...drop}>
      <div className="grid h-full min-h-0 md:grid-cols-[17rem_minmax(0,1fr)]">
        {/* Left: the new-chat button on top, all chats below (newest first). */}
        <aside className="flex min-h-0 min-w-0 flex-col gap-2 border-b p-3 md:border-r md:border-b-0" aria-label="Чати">
          {newChatButton}
          <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
            <nav className="flex w-full min-w-0 flex-col gap-0.5 pr-2" aria-label="Список чатів">
              {chat.chats.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">Чатів ще немає</p>}
              {chat.chats.map((c) => (
                <Button
                  key={c.id}
                  variant={c.id === activeId ? 'secondary' : 'ghost'}
                  className="h-auto w-full min-w-0 justify-start gap-2 overflow-hidden px-2 py-1.5 text-left font-normal"
                  aria-current={c.id === activeId ? 'true' : undefined}
                  title={`${c.projectName}: ${c.title}`}
                  onClick={() => onSelect(c.id)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{c.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{c.projectName}{c.agentTitle ? ` · ${c.agentTitle}` : ''}</span>
                  </span>
                  {c.status === 'running' && <><Spinner className="size-3.5" /><span className="sr-only">виконується</span></>}
                  {c.status === 'waiting' && <><Clock className="size-3.5" aria-hidden="true" /><span className="sr-only">чекає</span></>}
                </Button>
              ))}
            </nav>
          </ScrollArea>
        </aside>

        {/* Right: the conversation with the agent and model pickers at the top. */}
        <section className="flex min-h-0 flex-col" aria-label="Розмова">
          {!active ? (
            <Empty className="m-auto border-0 p-6">
              <EmptyHeader>
                <EmptyTitle>{chat.chats.length === 0 ? 'Створи чат' : 'Обери чат ліворуч'}</EmptyTitle>
                <EmptyDescription>Кожен чат працює у своєму проєкті й може йти паралельно з іншими. Натисни «Новий чат».</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h2 className="line-clamp-1 text-base font-medium" title={active.title}>{active.title}</h2>
                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    {active.projectName} ·{' '}
                    {active.readOnly ? 'лише відповідь: файли не змінюються, гілки немає' : <>гілка <code className="rounded bg-muted px-1">{active.branch}</code>, у {active.baseBranch} потрапляє лише після твого «Влити»</>}
                    {active.source === 'api' && <Badge variant="secondary" className="ml-2">API</Badge>}
                  </p>
                </div>
                <Select value={mode} onValueChange={(v) => { if (v === 'auto' || isAgentId(v)) void act({ op: 'mode', chat: active.id, mode: v }); }} disabled={running}>
                  <SelectTrigger size="sm" className="w-40" aria-label="Агент"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Авто</SelectItem>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="agy">Antigravity</SelectItem>
                    <SelectItem value="codex">ChatGPT</SelectItem>
                  </SelectContent>
                </Select>
                {mode !== 'auto' && (
                  <Select
                    value={chosenModel ?? DEFAULT_MODEL}
                    onValueChange={(v) => void act({ op: 'model', chat: active.id, agent: mode, model: v === DEFAULT_MODEL ? '' : v })}
                    disabled={running}
                  >
                    <SelectTrigger size="sm" className="w-52" aria-label="Модель і версія"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_MODEL}>Модель за замовчуванням</SelectItem>
                      {chosenModel && !modelList.some((m) => m.id === chosenModel) && <SelectItem value={chosenModel}>{chosenModel}</SelectItem>}
                      {modelList.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {!active.readOnly && active.messages.some((m) => m.role === 'agent') && (
                  <Button variant="outline" size="sm" disabled={running || sending} onClick={() => onMerge({ kind: 'chat', id: active.id })}>
                    <GitMerge aria-hidden="true" /> Влити в {active.baseBranch}
                  </Button>
                )}
              </header>

              <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
                <ScrollArea ref={viewport} className="h-full min-h-0 flex-1">
                  <div className="mx-auto flex max-w-3xl flex-col gap-3 p-1" aria-live="polite">
                    {active.messages.length === 0 ? (
                      <Empty className="border-0 p-6">
                        <EmptyHeader>
                          <EmptyTitle>Чат порожній</EmptyTitle>
                          <EmptyDescription>Опиши, що змінити, або прикріпи скріншот/PDF/документ. Агент може редагувати файли проєкту.</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      active.messages.map((m) => <Message key={m.id} m={m} />)
                    )}
                    {running && (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                        <Spinner /> Агент працює{active.runningSince ? ` · ${formatDuration(now - Date.parse(active.runningSince))}` : ''}
                        <Button variant="destructive" size="xs" className="ml-auto" onClick={() => void act({ op: 'stop', chat: active.id })}>
                          <Square aria-hidden="true" /> Зупинити
                        </Button>
                      </p>
                    )}
                  </div>
                </ScrollArea>
                {active.status === 'waiting' && (
                  <Alert>
                    <AlertTitle>Чекаю на вільного агента</AlertTitle>
                    <AlertDescription className="flex flex-wrap items-center gap-2">
                      {waitingLeft !== undefined && waitingLeft > 0 ? `Скидання ліміту через ${formatDuration(waitingLeft)}.` : 'Ліміт уже мав скинутися.'}
                      <Button variant="outline" size="xs" onClick={() => void act({ op: 'retry', chat: active.id })}><RotateCcw aria-hidden="true" /> Спробувати знову</Button>
                    </AlertDescription>
                  </Alert>
                )}
              </div>

              <footer className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 pb-3">
                <AttachChips files={files} onChange={(f) => setDraft(active.id, { files: f })} />
                <Textarea
                  value={text}
                  onChange={(e) => setDraft(active.id, { text: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
                  rows={2}
                  maxLength={8000}
                  placeholder="Напиши агентові… (Enter — надіслати, Shift+Enter — новий рядок; скріншот можна вставити Ctrl+V)"
                  aria-label="Повідомлення агентові"
                  className="min-h-14 resize-none"
                />
                <div className="flex items-center gap-2">
                  <AttachButton files={files} rules={rules} onChange={(f) => setDraft(active.id, { files: f })} onProblem={(message) => onResult({ ok: false, error: message })} disabled={running} />
                  <Button className="ml-auto" onClick={() => void send()} disabled={sending || running || (!text.trim() && files.length === 0)}>
                    {sending ? <Spinner /> : <Send aria-hidden="true" />} Надіслати
                  </Button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>
    </Card>
  );
}
