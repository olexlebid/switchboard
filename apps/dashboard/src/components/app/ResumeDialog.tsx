// "Продовжити": the user can answer the agent's open questions and attach files before the task resumes.
import { Play } from 'lucide-react';
import { useState } from 'react';
import type { UploadRules } from '@core/dashboard-state';
import type { TaskView } from '@core/task-overview';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { post, type ActionResult } from '@/lib/api';
import { AttachButton, AttachChips, dropHandlers } from './AttachPicker';

type Props = { task: TaskView; rules: UploadRules; onResult: (r: ActionResult) => void; reload: () => Promise<void> };

export function ResumeDialog({ task, rules, onResult, reload }: Props) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const problem = (message: string) => onResult({ ok: false, error: message });
  const drop = dropHandlers({ files, rules, onChange: setFiles, onProblem: problem });

  const submit = async () => {
    setBusy(true);
    const r = await post('/api/task-action', { op: 'resume', id: task.id, note }, files);
    onResult(r);
    setBusy(false);
    if (r.ok) { setOpen(false); setNote(''); setFiles([]); }
    await reload();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><Play aria-hidden="true" /> Продовжити</Button>
      </DialogTrigger>
      <DialogContent {...drop}>
        <DialogHeader>
          <DialogTitle>Продовжити задачу</DialogTitle>
          <DialogDescription>{task.title}</DialogDescription>
        </DialogHeader>
        {task.openQuestions.length > 0 && (
          <Alert>
            <AlertTitle>Питання агента</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">{task.openQuestions.map((q) => <li key={q}>{q}</li>)}</ul>
            </AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor={`note-${task.id}`}>Відповідь або уточнення <span className="font-normal text-muted-foreground">(необов’язково)</span></FieldLabel>
          <Textarea id={`note-${task.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={5000} placeholder="Наприклад: брейкпоінт планшета — 1024px, акцентний колір з tokens.css" />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <AttachButton files={files} rules={rules} onChange={setFiles} onProblem={problem} />
          <AttachChips files={files} onChange={setFiles} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Скасувати</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy ? <Spinner /> : <Play aria-hidden="true" />} Продовжити</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
