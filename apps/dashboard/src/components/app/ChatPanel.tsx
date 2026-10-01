// The chat: conversation with an agent that may edit project files (branch sb/c-…), mode switch, history,
// attachments, stop button. Replies are rendered from the server's safe markdown subset.
import { FilePen, MessageSquarePlus, RotateCcw, Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessageView, ChatOverview } from '@core/chat-overview';
import type { UploadRules } from '@core/dashboard-state';
import { formatDuration } from '@core/time';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { post, type ActionResult } from '@/lib/api';
import { cn } from 'cn';
import { AttachButton, AttachChips, dropHandlers } from './AttachPicker';

type Props = {
  project: string;
  projectName: string;
  chat?: ChatOverview;
  rules: UploadRules;
  now: number;
  onResult: (r: ActionResult) => void;
  reload: () => Promise<void>;
};

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

export function ChatPanel({ project, projectName, chat, rules, now, onResult, reload }: Props) {
  const active = chat?.active;
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  // Mode chosen before the first message (a chat does not exist yet); afterwards the chat's own mode wins.
  const [draftMode, setDraftMode] = useState<'auto' | 'claude' | 'agy'>('auto');
  const mode = active?.mode ?? draftMode;
  const viewport = useRef<HTMLDivElement>(null);
  const running = active?.status === 'running';
  const lastId = active?.messages.at(-1)?.id;

  // Keep the newest message in view.
  useEffect(() => {
    const el = viewport.current?.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]');
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, running, active?.id]);

  const act = async (data: Record<string, string | undefined>, sendFiles: File[] = []) => {
    const r = await post('/api/chat', data, sendFiles);
    if (!r.ok || r.message) onResult(r);
    await reload();
    return r;
  };

  const send = async () => {
    if (sending || running || (!text.trim() && files.length === 0)) return;
    setSending(true);
    // A chat is created on the first message of a project.
    let chatId = active?.id;
    if (!chatId) {
      const created = await post('/api/chat', { op: 'new', project, mode });
      if (!created.ok) { onResult(created); setSending(false); return; }
      chatId = created.chatId;
    }
    const r = await act({ op: 'send', chat: chatId, text }, files);
    if (r.ok) { setText(''); setFiles([]); }
    setSending(false);
  };

  const drop = dropHandlers({ files, rules, onChange: setFiles, onProblem: (message) => onResult({ ok: false, error: message }) });
  const waitingLeft = active?.waitUntil ? Date.parse(active.waitUntil) - now : undefined;

  return (
    <Card size="sm" className="h-full" {...drop}>
      <CardHeader>
        <CardTitle><h2 className="text-base font-medium">Чат · {projectName}</h2></CardTitle>
        <CardDescription>
          {active ? <>Гілка <code className="rounded bg-muted px-1">{active.branch}</code> · у main нічого не мержиться</> : 'Напиши повідомлення, щоб почати розмову.'}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {chat && chat.chats.length > 0 && (
            <Select value={active?.id} onValueChange={(id) => void act({ op: 'select', chat: id })}>
              <SelectTrigger size="sm" className="w-44" aria-label="Історія чатів"><SelectValue placeholder="Історія" /></SelectTrigger>
              <SelectContent align="end">
                {chat.chats.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" size="sm" disabled={running || sending || (active?.messages.length ?? 1) === 0} title={active && active.messages.length === 0 ? 'Поточний чат ще порожній' : undefined} onClick={() => void act({ op: 'new', project, mode })}>
            <MessageSquarePlus aria-hidden="true" /> Новий чат
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="min-h-0 flex-1">
        <ScrollArea ref={viewport} className="h-full min-h-0 flex-1 rounded-md border">
          <div className="flex flex-col gap-3 p-3" aria-live="polite">
            {!active || active.messages.length === 0 ? (
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
                <Spinner /> Агент працює{active?.runningSince ? ` · ${formatDuration(now - Date.parse(active.runningSince))}` : ''}
                <Button variant="destructive" size="xs" className="ml-auto" onClick={() => void act({ op: 'stop', chat: active!.id })}>
                  <Square aria-hidden="true" /> Зупинити
                </Button>
              </p>
            )}
          </div>
        </ScrollArea>
        {active?.status === 'waiting' && (
          <Alert>
            <AlertTitle>Чекаю на вільного агента</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {waitingLeft !== undefined && waitingLeft > 0 ? `Скидання ліміту через ${formatDuration(waitingLeft)}.` : 'Ліміт уже мав скинутися.'}
              <Button variant="outline" size="xs" onClick={() => void act({ op: 'retry', chat: active.id })}><RotateCcw aria-hidden="true" /> Спробувати знову</Button>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-2">
        <AttachChips files={files} onChange={setFiles} />
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
          rows={2}
          maxLength={8000}
          placeholder="Напиши агентові… (Enter — надіслати, Shift+Enter — новий рядок; скріншот можна вставити Ctrl+V)"
          aria-label="Повідомлення агентові"
          className="min-h-14 resize-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <AttachButton files={files} rules={rules} onChange={setFiles} onProblem={(message) => onResult({ ok: false, error: message })} disabled={running} />
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={mode}
            onValueChange={(v) => {
              if (v !== 'auto' && v !== 'claude' && v !== 'agy') return;
              if (active) void act({ op: 'mode', chat: active.id, mode: v });
              else setDraftMode(v);
            }}
            aria-label="Хто відповідає"
          >
            <ToggleGroupItem value="auto" className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">Авто</ToggleGroupItem>
            <ToggleGroupItem value="claude" className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">Claude</ToggleGroupItem>
            <ToggleGroupItem value="agy" className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">Antigravity</ToggleGroupItem>
          </ToggleGroup>
          <Button className="ml-auto" onClick={() => void send()} disabled={sending || running || (!text.trim() && files.length === 0)}>
            {sending ? <Spinner /> : <Send aria-hidden="true" />} Надіслати
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
