// One agent: identity, status, two usage windows, per-model-group rows (collapsed) and a footer.
import { ChevronDown, Sparkles, Triangle } from 'lucide-react';
import { formatAge } from '@core/time';
import type { AgentOverview } from '@core/overview';
import type { GroupWindow, Thresholds } from '@core/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { StatusBadge } from './StatusBadge';
import { UsageMeter } from './UsageMeter';

type Props = { agent: AgentOverview; thresholds: Thresholds; now: number };

export function AgentCard({ agent, thresholds, now }: Props) {
  const { snapshot } = agent;
  // Group the flat per-group rows into { name, fiveHour, weekly } blocks, keeping first-seen order.
  const groups = new Map<string, { fiveHour?: GroupWindow; weekly?: GroupWindow }>();
  for (const g of snapshot?.perGroup ?? []) {
    const entry = groups.get(g.group) ?? {};
    entry[g.window] = g;
    groups.set(g.group, entry);
  }
  const Icon = agent.agent === 'claude' ? Sparkles : Triangle;
  const age = snapshot ? formatAge(now - Date.parse(snapshot.capturedAt)) : undefined;

  return (
    <Card size="sm" data-agent={agent.agent}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-base font-medium">{agent.title}</h2>
        </CardTitle>
        {snapshot?.account && <CardDescription>{snapshot.account}</CardDescription>}
        <CardAction>
          <StatusBadge status={agent.status}>{agent.statusLabel}</StatusBadge>
        </CardAction>
      </CardHeader>

      <CardContent>
        {/* "everything is fine" needs no sentence; the badge already says it */}
        {agent.status !== 'available' && <p className="text-sm text-muted-foreground">{agent.reason}</p>}
        {snapshot ? (
          <div className="flex flex-col gap-2">
            <UsageMeter label="5 год" pct={agent.fiveHourPct} resetsAt={snapshot.fiveHour?.resetsAt} thresholds={thresholds} now={now} dim={agent.stale} />
            <UsageMeter label="Тиждень" pct={agent.weeklyPct} resetsAt={snapshot.weekly?.resetsAt} thresholds={thresholds} now={now} dim={agent.stale} />
            {groups.size > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="group/trigger flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronDown className="size-3.5 transition-transform group-data-[state=open]/trigger:rotate-180" aria-hidden="true" />
                  Групи моделей ({groups.size})
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 flex flex-col gap-3">
                  {[...groups.entries()].map(([name, g]) => (
                    <div key={name} className="flex flex-col gap-1.5">
                      <h3 className="text-xs font-medium">{name}</h3>
                      <UsageMeter label="5 год" pct={g.fiveHour?.usedPct} resetsAt={g.fiveHour?.resetsAt} thresholds={thresholds} now={now} dim={agent.stale} />
                      <UsageMeter label="Тиждень" pct={g.weekly?.usedPct} resetsAt={g.weekly?.resetsAt} thresholds={thresholds} now={now} dim={agent.stale} />
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Немає збереженого знімка. Натисни «Оновити».</p>
        )}
        {agent.error && (
          <p className="text-sm text-destructive" role="status">
            <strong className="font-medium">Не вдалося оновити:</strong> {agent.error}
          </p>
        )}
      </CardContent>

      {snapshot && (
        <CardFooter className="flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {snapshot.modelCount !== undefined && <span>Моделей: {snapshot.modelCount}</span>}
          <span>Джерело: {snapshot.source}</span>
          <time dateTime={snapshot.capturedAt}>{age}</time>
          {agent.stale && <Badge variant="secondary">застаріло</Badge>}
        </CardFooter>
      )}
    </Card>
  );
}
