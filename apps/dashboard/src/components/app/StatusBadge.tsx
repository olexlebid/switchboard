// Status as colored dot + text (never color alone), built from the shadcn Badge.
import type { AgentStatus } from '@core/types';
import { Badge } from '@/components/ui/badge';
import { cn } from 'cn';

const DOT: Record<AgentStatus | 'ok' | 'bad' | 'none', string> = {
  available: 'bg-success',
  low: 'bg-warning',
  reserve: 'bg-warning',
  exhausted: 'bg-destructive',
  unknown: 'bg-muted-foreground',
  ok: 'bg-success',
  bad: 'bg-destructive',
  none: 'bg-muted-foreground',
};

export function StatusBadge({ status, children, className }: { status: keyof typeof DOT; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1.5', className)}>
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', DOT[status])} />
      <span className="sr-only">Статус: </span>
      {children}
    </Badge>
  );
}
