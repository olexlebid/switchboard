// "Влити в main": the owner confirms moving the work of a task or chat from its sb/* branch into the base branch.
// It is a fast-forward only (git merge --ff-only): no merge commit, no push, no deploy.
import { GitMerge } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MergePreview } from '@core/merge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { post, type ActionResult } from '@/lib/api';

export type MergeTarget = { kind: 'task' | 'chat'; id: string };

type Props = { target?: MergeTarget; onClose: () => void; onResult: (r: ActionResult) => void; reload: () => Promise<void> };

export function MergeDialog({ target, onClose, onResult, reload }: Props) {
  const [preview, setPreview] = useState<MergePreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Load what would be merged every time the dialog opens for a target.
  useEffect(() => {
    setPreview(undefined);
    setError(undefined);
    if (!target) return;
    let stale = false;
    void post('/api/merge', { op: 'preview', kind: target.kind, id: target.id }).then((r) => {
      if (stale) return;
      if (r.ok && r.preview) setPreview(r.preview);
      else setError(r.error ?? 'Не вдалося отримати перелік змін.');
    });
    return () => { stale = true; };
  }, [target?.kind, target?.id]);

  const merge = async () => {
    if (!target) return;
    setBusy(true);
    const r = await post('/api/merge', { op: 'merge', kind: target.kind, id: target.id });
    setBusy(false);
    onResult(r);
    if (r.ok) { onClose(); await reload(); }
  };

  const base = preview?.base ?? 'main';
  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Влити в {base}?</DialogTitle>
          <DialogDescription>
            {preview ? <>Гілка <code className="rounded bg-muted px-1">{preview.branch}</code> → <code className="rounded bg-muted px-1">{preview.base}</code>. </> : null}
            Це лише локальне швидке злиття (<code className="rounded bg-muted px-1">git merge --ff-only</code>): нічого не відправляється на віддалений репозиторій і не деплоїться.
          </DialogDescription>
        </DialogHeader>

        {!preview && !error && <Skeleton className="h-24" aria-busy="true" />}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {preview && (
          <>
            {preview.reason && <Alert variant="destructive"><AlertDescription>{preview.reason}</AlertDescription></Alert>}
            {preview.commits.length > 0 && (
              <div className="flex min-w-0 flex-col gap-2">
                <p className="text-sm font-medium">Коміти <Badge variant="secondary">{preview.commits.length}</Badge> · файли <Badge variant="secondary">{preview.files.length}</Badge></p>
                <div className="max-h-52 min-w-0 overflow-y-auto rounded-md border">
                  <ul className="flex flex-col gap-1 p-3 text-sm" aria-label="Коміти для злиття">
                    {preview.commits.map((c) => (
                      <li key={c.sha} className="flex items-baseline gap-2"><code className="text-xs text-muted-foreground">{c.sha}</code><span className="min-w-0 truncate">{c.subject}</span></li>
                    ))}
                  </ul>
                  <ul className="flex flex-wrap gap-1 border-t p-3" aria-label="Змінені файли">
                    {preview.files.map((f) => <li key={f}><code className="rounded bg-muted px-1 text-xs">{f}</code></li>)}
                  </ul>
                </div>
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Скасувати</Button>
          <Button onClick={() => void merge()} disabled={busy || !preview?.canMerge}>
            {busy ? <Spinner /> : <GitMerge aria-hidden="true" />} Влити в {base}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
