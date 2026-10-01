// Live task panel: running task with log tail, queue, recent tasks and handover history, as tabs.
import { Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UploadRules } from '@core/dashboard-state';
import type { TaskView, TasksOverview } from '@core/task-overview';
import { formatDuration } from '@core/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { post, type ActionResult } from '@/lib/api';
import { ResumeDialog } from './ResumeDialog';
import { StatusBadge } from './StatusBadge';

type Props = { tasks: TasksOverview; rules: UploadRules; now: number; onResult: (r: ActionResult) => void; reload: () => Promise<void> };

const clock = (iso: string) => new Date(iso).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
const outcome = (t: TaskView) => (t.status === 'done' ? 'ok' : t.status === 'failed' ? 'bad' : 'low');

function Count({ n }: { n: number }) {
  return n > 0 ? <Badge variant="secondary" className="ml-1 h-4 px-1.5">{n}</Badge> : null;
}

export function TaskPanel({ tasks, rules, now, onResult, reload }: Props) {
  const [tab, setTab] = useState('running');
  // Jump to the "running" tab when a task starts.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (tasks.hasRunning && !wasRunning.current) setTab('running');
    wasRunning.current = tasks.hasRunning;
  }, [tasks.hasRunning]);

  const stop = async (id: string) => {
    onResult(await post('/api/task-action', { op: 'stop', id }));
    await reload();
  };
  const resume = (t: TaskView) => <ResumeDialog task={t} rules={rules} onResult={onResult} reload={reload} />;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle><h3 className="text-base font-medium">Задачі</h3></CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="running">Виконується<Count n={tasks.running.length} /></TabsTrigger>
            <TabsTrigger value="queue">Черга<Count n={tasks.waiting.length} /></TabsTrigger>
            <TabsTrigger value="recent">Останні</TabsTrigger>
            <TabsTrigger value="handoffs">Передачі</TabsTrigger>
          </TabsList>

          <TabsContent value="running" className="flex flex-col gap-3">
            {tasks.running.length === 0 && <EmptyNote title="Нічого не виконується" text="Запусти задачу у формі «Нова задача»." />}
            {tasks.running.map((t) => (
              <article key={t.id} className="flex flex-col gap-2 rounded-lg border p-3" aria-labelledby={`task-${t.id}`}>
                <header className="flex items-center gap-2">
                  <h4 id={`task-${t.id}`} className="truncate text-sm font-medium">{t.title}</h4>
                  <StatusBadge status="low" className="ml-auto">{t.statusLabel}</StatusBadge>
                </header>
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <div><dt className="inline">Агент: </dt><dd className="inline text-foreground">{t.agentTitle ?? 'обирається…'}</dd></div>
                  <div><dt className="inline">Тип: </dt><dd className="inline text-foreground">{t.type}</dd></div>
                  <div><dt className="inline">Гілка: </dt><dd className="inline"><code className="text-foreground">{t.branch}</code></dd></div>
                  {t.startedAt && <div><dt className="inline">Триває: </dt><dd className="inline text-foreground">{formatDuration(now - Date.parse(t.startedAt))}</dd></div>}
                </dl>
                <ScrollArea className="h-32 rounded-md border bg-muted/40">
                  <pre tabIndex={0} aria-label="Хвіст логу (останні 20 рядків)" className="p-2 font-mono text-xs whitespace-pre-wrap">
                    {t.logTail.length ? t.logTail.join('\n') : 'Агент ще нічого не вивів (Claude віддає відповідь одним блоком наприкінці).'}
                  </pre>
                </ScrollArea>
                {t.canStop && (
                  <div>
                    <Button variant="destructive" size="sm" onClick={() => void stop(t.id)}><Square aria-hidden="true" /> Зупинити</Button>
                  </div>
                )}
              </article>
            ))}
          </TabsContent>

          <TabsContent value="queue">
            {tasks.waiting.length === 0 ? (
              <EmptyNote title="Черга порожня" text="Сюди потрапляють задачі, що чекають на скидання ліміту." />
            ) : (
              <ItemGroup className="gap-2">
                {tasks.waiting.map((t) => (
                  <Item key={t.id} variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle>{t.title}</ItemTitle>
                      {t.note && <ItemDescription>{t.note}</ItemDescription>}
                      {t.waitUntil && (
                        <ItemDescription>
                          Очікуваний старт: <time dateTime={t.waitUntil}>{clock(t.waitUntil)}</time>
                          {' '}({Date.parse(t.waitUntil) > now ? `через ${formatDuration(Date.parse(t.waitUntil) - now)}` : 'вже можна продовжити'})
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions>{t.canResume && resume(t)}</ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </TabsContent>

          <TabsContent value="recent">
            {tasks.recent.length === 0 ? (
              <EmptyNote title="Завершених ще немає" text="Тут з’являться виконані та перервані задачі." />
            ) : (
              <ItemGroup className="gap-2">
                {tasks.recent.slice(0, 6).map((t) => (
                  <Item key={t.id} variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle><StatusBadge status={outcome(t)}>{t.statusLabel}</StatusBadge> {t.title}</ItemTitle>
                      <ItemDescription>{t.agentTitle ?? '—'} · {t.projectName} · <code>{t.branch}</code></ItemDescription>
                      {t.note && <ItemDescription title={t.note}>{t.note}</ItemDescription>}
                    </ItemContent>
                    <ItemActions>{t.canResume && resume(t)}</ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </TabsContent>

          <TabsContent value="handoffs">
            {tasks.handoffs.length === 0 ? (
              <EmptyNote title="Передач ще не було" text="Коли агент упреться в ліміт, задача перейде до іншого агента — це буде тут." />
            ) : (
              <ItemGroup className="gap-2">
                {tasks.handoffs.slice(0, 6).map((h, i) => (
                  <Item key={`${h.taskId}-${i}`} variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle>{h.text}</ItemTitle>
                      <ItemDescription>{h.taskTitle}</ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function EmptyNote({ title, text }: { title: string; text: string }) {
  return (
    <Empty className="border-0 p-4">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
