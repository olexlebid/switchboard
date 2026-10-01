// "Нова задача": starts `sb run` through /api/tasks (multipart, with files).
import { Play } from 'lucide-react';
import { useState } from 'react';
import type { UploadRules } from '@core/dashboard-state';
import type { TasksOverview } from '@core/task-overview';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { post, type ActionResult } from '@/lib/api';
import { AttachButton, AttachChips, dropHandlers } from './AttachPicker';

const TYPE_LABEL: Record<string, string> = {
  research: 'Дослідження',
  ideas: 'Ідеї',
  copy: 'Тексти',
  section: 'Секція (Astro)',
  review: 'Рев’ю',
  qa: 'QA',
};

type Props = {
  project: string;
  projectName: string;
  types: TasksOverview['types'];
  rules: UploadRules;
  onResult: (r: ActionResult) => void;
  reload: () => Promise<void>;
};

export function TaskForm({ project, projectName, types, rules, onResult, reload }: Props) {
  const [text, setText] = useState('');
  const [type, setType] = useState('section');
  const [priority, setPriority] = useState('normal');
  const [figma, setFigma] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const problem = (message: string) => onResult({ ok: false, error: message });
  const drop = dropHandlers({ files, rules, onChange: setFiles, onProblem: problem });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    const r = await post('/api/tasks', { text, type, priority, project, figma }, files);
    onResult(r);
    if (r.ok) { setText(''); setFigma(''); setFiles([]); }
    setBusy(false);
    await reload();
  };

  return (
    <Card size="sm" {...drop}>
      <CardHeader>
        <CardTitle><h3 className="text-base font-medium">Нова задача</h3></CardTitle>
        <CardDescription>Проєкт: <strong className="font-medium text-foreground">{projectName}</strong>. Задача піде в окрему гілку <code className="rounded bg-muted px-1">sb/…</code>.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="task-text">Що зробити</FieldLabel>
              <Textarea id="task-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={5000} required placeholder="Наприклад: зроби секцію Features за DESIGN.md, мобільна версія спочатку" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="task-type">Тип</FieldLabel>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger id="task-type" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {types.map((t) => <SelectItem key={t.id} value={t.id}>{TYPE_LABEL[t.id] ?? t.id}{t.short ? '' : ' (довга)'}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="task-priority">Пріоритет</FieldLabel>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger id="task-priority" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">звичайний</SelectItem>
                    <SelectItem value="high">високий</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="task-figma">Figma-фрейм <span className="font-normal text-muted-foreground">(необов’язково)</span></FieldLabel>
              <Input id="task-figma" type="url" inputMode="url" value={figma} onChange={(e) => setFigma(e.target.value)} placeholder="https://www.figma.com/design/…" />
            </Field>
            <Field>
              <FieldLabel>Файли <span className="font-normal text-muted-foreground">(скріншоти, PDF, документи)</span></FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                <AttachButton files={files} rules={rules} onChange={setFiles} onProblem={problem} label="Додати файли" />
                <AttachChips files={files} onChange={setFiles} />
              </div>
              <FieldDescription>Не більше {rules.maxFiles} файлів, до {rules.maxFileMB} МБ кожен. Можна перетягнути сюди.</FieldDescription>
            </Field>
            <Button type="submit" disabled={busy || !text.trim()}>
              {busy ? <Spinner /> : <Play aria-hidden="true" />} Запустити
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
