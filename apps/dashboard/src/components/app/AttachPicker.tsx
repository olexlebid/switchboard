// File attachments for the chat and the task forms: picker button, drag&drop, pasted screenshots, chips.
// Rules (types, counts, sizes) come from the server (`uploads` in /api/state); the server re-checks everything.
import { Paperclip, X } from 'lucide-react';
import { useRef } from 'react';
import type { UploadRules } from '@core/dashboard-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const MB = 1024 * 1024;
export const formatSize = (bytes: number) => (bytes < 1024 ? `${bytes} Б` : bytes < MB ? `${Math.round(bytes / 1024)} КБ` : `${(bytes / MB).toFixed(1)} МБ`);

/** Adds `incoming` to `current` and returns the accepted list plus a message about what was refused. */
export function mergeFiles(current: File[], incoming: File[], rules: UploadRules): { files: File[]; problem?: string } {
  const files = [...current];
  const problems: string[] = [];
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of incoming) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!rules.accept.includes(ext)) problems.push(`${f.name}: тип .${ext || '?'} не підтримується`);
    else if (f.size > rules.maxFileMB * MB) problems.push(`${f.name}: більше ${rules.maxFileMB} МБ`);
    else if (files.length >= rules.maxFiles) problems.push(`${f.name}: не більше ${rules.maxFiles} файлів`);
    else if (total + f.size > rules.maxTotalMB * MB) problems.push(`${f.name}: разом більше ${rules.maxTotalMB} МБ`);
    else {
      files.push(f);
      total += f.size;
    }
  }
  return { files, problem: problems.length ? problems.join('; ') : undefined };
}

type Props = {
  files: File[];
  rules: UploadRules;
  onChange: (files: File[]) => void;
  onProblem: (message: string) => void;
  disabled?: boolean;
};

/** The "attach" button with its hidden input; chips are rendered by <AttachChips />. */
export function AttachButton({ files, rules, onChange, onProblem, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={rules.accept.map((e) => `.${e}`).join(',')}
        onChange={(e) => {
          const r = mergeFiles(files, [...(e.target.files ?? [])], rules);
          onChange(r.files);
          if (r.problem) onProblem(r.problem);
          e.target.value = '';
        }}
      />
      <Button type="button" variant="ghost" size="icon" disabled={disabled} onClick={() => input.current?.click()} aria-label="Додати файли" title="Додати файли (можна перетягнути або вставити скріншот)">
        <Paperclip aria-hidden="true" />
      </Button>
    </>
  );
}

export function AttachChips({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Прикріплені файли">
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`}>
          <Badge variant="secondary" className="h-6 gap-1 pr-1">
            <span className="max-w-40 truncate">{f.name}</span>
            <span className="text-muted-foreground">{formatSize(f.size)}</span>
            <button type="button" className="rounded-full p-0.5 hover:bg-background" aria-label={`Прибрати ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}>
              <X className="size-3" aria-hidden="true" />
            </button>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** Drag&drop and Ctrl+V handlers to spread on a container / textarea. */
export function dropHandlers({ files, rules, onChange, onProblem }: Omit<Props, 'disabled'>) {
  const add = (incoming: File[]) => {
    const r = mergeFiles(files, incoming, rules);
    onChange(r.files);
    if (r.problem) onProblem(r.problem);
  };
  return {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); },
    onDrop: (e: React.DragEvent) => {
      if (e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      add([...e.dataTransfer.files]);
    },
    onPaste: (e: React.ClipboardEvent) => {
      const pasted = [...e.clipboardData.files];
      if (pasted.length === 0) return; // plain text paste: leave to the browser
      e.preventDefault();
      // Pasted screenshots have a generic name; give each a unique one.
      add(pasted.map((f, i) => (f.name === 'image.png' ? new File([f], `screenshot-${Date.now()}-${i + 1}.png`, { type: f.type }) : f)));
    },
  };
}
