// System notification (macOS `osascript`). Best effort: returns false instead of throwing.
import { runCommand } from './exec';

/** Escapes text for an AppleScript string literal. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').slice(0, 200);
}

export type Notify = (title: string, message: string) => Promise<boolean>;

export const notify: Notify = async (title, message) => {
  if (process.platform !== 'darwin') return false;
  const r = await runCommand('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], { timeoutMs: 5000 });
  return r.code === 0;
};
