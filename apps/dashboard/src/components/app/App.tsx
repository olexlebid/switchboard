// The dashboard, top to bottom: limits of the three agents, manual marks, activity (tasks + chats), chat windows as tabs.
// Everything is built from shadcn/ui components; data comes from GET /api/state.
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_LABEL } from '@core/status';
import type { AgentStatus } from '@core/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useDashboard, useNow, useStoredString } from '@/hooks/use-dashboard';
import { post, type ActionResult } from '@/lib/api';
import { DirtyTreeDialog, type Blocked } from './DirtyTreeDialog';
import { MergeDialog, type MergeTarget } from './MergeDialog';
import { AgentCard } from './AgentCard';
import { ChatPanel } from './ChatPanel';
import { ManualMarks } from './ManualMarks';
import { StatusBadge } from './StatusBadge';
import { TaskPanel } from './TaskPanel';
import { ThemeToggle } from './ThemeToggle';

const ORDER: AgentStatus[] = ['available', 'low', 'reserve', 'exhausted', 'unknown'];

export default function App() {
  // Open chat tabs (comma-separated ids) and the selected one live in localStorage; the server holds the chats.
  const [openRaw, setOpenRaw] = useStoredString('sb-open-chats');
  const [selected, setSelected] = useStoredString('sb-chat');
  const openIds = useMemo(() => (openRaw ?? '').split(',').filter(Boolean), [openRaw]);
  const { state, offline, reload } = useDashboard(selected);
  const now = useNow(15_000);
  const [notice, setNotice] = useState<ActionResult>();
  const [refreshing, setRefreshing] = useState(false);
  const [blocked, setBlocked] = useState<Blocked>();
  const [mergeTarget, setMergeTarget] = useState<MergeTarget>();
  const noticeTimer = useRef<number>(undefined);

  const projects = state?.tasks.projects ?? [];
  const chats = state?.chat.chats ?? [];
  const tabs = openIds.map((id) => chats.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => c !== undefined);
  const activeId = tabs.some((t) => t.id === selected) ? selected : tabs[0]?.id;

  const openChat = (id: string) => {
    if (!openIds.includes(id)) setOpenRaw([...openIds, id].join(','));
    setSelected(id);
  };
  const closeChat = (id: string) => {
    const rest = openIds.filter((x) => x !== id);
    setOpenRaw(rest.join(','));
    if (activeId === id) setSelected(rest[0] ?? '');
  };

  // First visit: open the most recent chat. After that the user decides which tabs exist (closing all stays closed).
  useEffect(() => {
    if (openRaw === undefined && chats.length > 0) openChat(chats[0]!.id);
  }, [openRaw, chats.length]);
  // Keep the stored selection pointing at a real tab, so the server sends that conversation.
  useEffect(() => {
    if (activeId && activeId !== selected) setSelected(activeId);
  }, [activeId, selected]);

  const show = (r: ActionResult, retry?: () => void) => {
    // A dirty working tree is resolved in a dialog (stash + repeat) instead of a bare error line.
    if (!r.ok && r.blocked) {
      const name = projects.find((p) => p.path === r.blocked!.project)?.name ?? r.blocked.project;
      setBlocked({ project: r.blocked.project, projectName: name, files: r.blocked.files, retry });
      return;
    }
    const text = r.ok ? r.message : r.error;
    if (!text) return;
    setNotice(r);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), r.ok ? 6000 : 12000);
  };
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const reloadAsync = async () => { await reload(); };

  // A new chat per project; an untouched one is reused instead of piling up empty chats.
  const newChat = async (project: string) => {
    const spare = chats.find((c) => c.project === project && c.title === 'Новий чат' && c.status === 'idle');
    if (spare) { openChat(spare.id); return; }
    const r = await post('/api/chat', { op: 'new', project, mode: 'auto' });
    if (!r.ok || !r.chatId) { show(r); return; }
    openChat(r.chatId);
    await reload();
  };

  const refresh = async () => {
    setRefreshing(true);
    show(await post('/api/refresh', {}));
    await reload();
    setRefreshing(false);
  };

  const mark = async (id: string, value: 'available' | 'exhausted') => {
    const r = await post('/api/manual', { id, state: value });
    if (!r.ok) show(r);
    await reload();
  };

  if (!state) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4" aria-busy="true">
        <Skeleton className="h-9 w-72" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        {offline && <p role="status" className="text-sm text-destructive">Немає зв’язку із сервером Switchboard. Повторюю спробу…</p>}
      </div>
    );
  }

  const updated = new Date(state.overview.refreshedAt ?? state.overview.generatedAt);

  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">Switchboard</h1>
          <ul className="flex flex-wrap gap-1.5" aria-label="Зведення статусів">
            {ORDER.map((s) => (
              <li key={s}><StatusBadge status={s}><strong className="font-semibold">{state.overview.summary[s]}</strong> {STATUS_LABEL[s]}</StatusBadge></li>
            ))}
          </ul>
          <div className="ml-auto flex items-center gap-2">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              Оновлено <time dateTime={updated.toISOString()}>{updated.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            </p>
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? <Spinner /> : <RefreshCw aria-hidden="true" />} Оновити
            </Button>
            <ThemeToggle />
          </div>
        </header>

        {offline && <Alert variant="destructive" role="status"><AlertDescription>Немає зв’язку із сервером Switchboard. Повторюю спробу…</AlertDescription></Alert>}
        {notice && (notice.ok ? notice.message : notice.error) && (
          <Alert variant={notice.ok ? 'default' : 'destructive'} role="status">
            <AlertDescription>{notice.ok ? notice.message : notice.error}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          {state.overview.agents.map((a) => <AgentCard key={a.agent} agent={a} thresholds={state.overview.thresholds} now={now} />)}
        </div>

        <ManualMarks cards={state.overview.manual} onChange={(id, v) => void mark(id, v)} />

        <TaskPanel tasks={state.tasks} chats={chats} rules={state.uploads} now={now} onResult={show} onMerge={setMergeTarget} onOpenChat={openChat} reload={reloadAsync} />

        {/* The chat sits at the very bottom with a fixed height, so the page above it can grow freely. */}
        <div className="h-[44rem]">
          {projects.length > 0 ? (
            <ChatPanel
              chat={state.chat} tabs={tabs} activeId={activeId} projects={projects} models={state.models} rules={state.uploads} now={now}
              onResult={show} onMerge={setMergeTarget} onSelect={openChat} onClose={closeChat} onNew={(p) => void newChat(p)} reload={reloadAsync}
            />
          ) : (
            <NoProjects />
          )}
        </div>

        <DirtyTreeDialog blocked={blocked} onClose={() => setBlocked(undefined)} onResult={show} reload={reloadAsync} />

        <MergeDialog target={mergeTarget} onClose={() => setMergeTarget(undefined)} onResult={show} reload={reloadAsync} />
      </main>
    </TooltipProvider>
  );
}

function NoProjects() {
  return (
    <Alert>
      <AlertDescription>
        Немає дозволених проєктів. Додай один командою <code className="rounded bg-muted px-1">pnpm sb project add ~/шлях/до/проєкту</code>.
      </AlertDescription>
    </Alert>
  );
}
