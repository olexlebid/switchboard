// The dashboard is a status board: limits of both agents (left), tasks (right), manual marks.
// Work is started from the CLI (`sb run` / `sb chat`), not from the page.
// Everything is built from shadcn/ui components; data comes from GET /api/state.
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { STATUS_LABEL } from '@core/status';
import type { AgentStatus } from '@core/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useDashboard, useNow } from '@/hooks/use-dashboard';
import { post, type ActionResult } from '@/lib/api';
import { AgentCard } from './AgentCard';
import { ManualMarks } from './ManualMarks';
import { StatusBadge } from './StatusBadge';
import { TaskPanel } from './TaskPanel';
import { ThemeToggle } from './ThemeToggle';

const ORDER: AgentStatus[] = ['available', 'low', 'reserve', 'exhausted', 'unknown'];

export default function App() {
  const { state, offline, reload } = useDashboard();
  const now = useNow(15_000);
  const [notice, setNotice] = useState<ActionResult>();
  const [refreshing, setRefreshing] = useState(false);
  const noticeTimer = useRef<number>(undefined);

  const show = (r: ActionResult) => {
    const text = r.ok ? r.message : r.error;
    if (!text) return;
    setNotice(r);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), r.ok ? 6000 : 12000);
  };
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const reloadAsync = async () => { await reload(); };

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
        <div className="grid gap-4 lg:grid-cols-[26rem_1fr]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
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

        <section aria-label="Статус і задачі" className="grid items-start gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            {state.overview.agents.map((a) => <AgentCard key={a.agent} agent={a} thresholds={state.overview.thresholds} now={now} />)}
          </div>
          <TaskPanel tasks={state.tasks} rules={state.uploads} now={now} onResult={show} reload={reloadAsync} />
        </section>

        <ManualMarks cards={state.overview.manual} onChange={(id, v) => void mark(id, v)} />
      </main>
    </TooltipProvider>
  );
}
