// "Stash and continue": the project has uncommitted changes, so an agent cannot start on its branch.
// The user can move them aside with one click (git stash, recoverable) and the blocked action is repeated.
import { Archive } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { post, type ActionResult } from '@/lib/api';

export type Blocked = { project: string; projectName: string; files: string[]; retry?: () => void };

type Props = { blocked?: Blocked; onClose: () => void; onResult: (r: ActionResult) => void; reload: () => Promise<void> };

// `git status --porcelain` codes, as words (status is never conveyed by the code alone).
const KIND = (code: string): string => {
  if (code === '??') return 'нове';
  if (code.includes('D')) return 'видалено';
  if (code.includes('R')) return 'перейменовано';
  return 'змінено';
};

function parse(line: string): { kind: string; path: string } {
  const m = /^(\S{1,2})\s+(.*)$/.exec(line.trim());
  return m ? { kind: KIND(m[1]!), path: m[2]! } : { kind: 'змінено', path: line.trim() };
}

export function DirtyTreeDialog({ blocked, onClose, onResult, reload }: Props) {
  const [busy, setBusy] = useState(false);

  const stash = async () => {
    if (!blocked) return;
    setBusy(true);
    const r = await post('/api/tree', { op: 'stash', project: blocked.project });
    setBusy(false);
    onResult(r);
    if (!r.ok) return;
    const retry = blocked.retry;
    onClose();
    await reload();
    retry?.();
  };

  return (
    <Dialog open={blocked !== undefined} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>У проєкті є незакомічені зміни</DialogTitle>
          <DialogDescription>
            Агент працює в окремій гілці, тому спершу дерево проєкту <strong className="font-medium text-foreground">{blocked?.projectName}</strong> має бути чистим.
            Відкладені зміни нікуди не зникають: їх можна повернути командою <code className="rounded bg-muted px-1">git stash pop</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-60 min-w-0 overflow-y-auto rounded-md border">
          <ul className="flex flex-col gap-1 p-3 text-sm" aria-label="Незакомічені файли">
            {blocked?.files.map(parse).map((f) => (
              <li key={f.path} className="flex items-center gap-2">
                <Badge variant="outline">{f.kind}</Badge>
                <code className="min-w-0 truncate">{f.path}</code>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Скасувати</Button>
          <Button onClick={() => void stash()} disabled={busy}>
            {busy ? <Spinner /> : <Archive aria-hidden="true" />} Відкласти й повторити
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
