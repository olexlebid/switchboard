// Temporary permission rules for headless `agy` runs.
//
// Findings (docs/recon.md): agy reads rules only from its USER-level settings file, a write rule
// must be a directory prefix `write_file(<dir>/)`, `deny` is unreliable for shell commands, and a
// shell rule cannot be made safe. So Switchboard adds a directory-scoped write rule for the run
// and removes exactly that rule afterwards. It never grants shell access.
//
// Safety net: the original file is backed up first, a journal records what was changed, a second
// concurrent run is refused, and a crashed run is repaired by the next `sb run` (recoverAgyRules).
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { onExit } from './cleanup';
import { sbHome, writeJsonAtomic } from './store';

export class AgyPermissionError extends Error {}

type Journal = {
  settingsPath: string;
  backupPath: string;
  originalExisted: boolean;
  permissionsExisted: boolean;
  /** sha256 of the settings text we wrote; tells us whether anyone changed it afterwards. */
  writtenHash: string;
  added: { allow: string[]; deny: string[] };
  pid: number;
  project: string;
  startedAt: string;
};

export const DEFAULT_AGY_SETTINGS = '~/.gemini/antigravity-cli/settings.json';

export function expandHome(path: string): string {
  return path.replace(/^~(?=$|\/)/, process.env.HOME ?? homedir());
}

const journalPath = () => join(sbHome(), 'agy-rules-journal.json');
const backupsDir = () => join(sbHome(), 'backups');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.sb-${process.pid}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

/** Removes only the rules we added; everything else in the file (also edits made meanwhile) stays. */
function removeAddedRules(current: string, j: Journal): string | undefined {
  let data: Record<string, any>;
  try {
    data = JSON.parse(current);
  } catch {
    return undefined;
  }
  const perms = data.permissions;
  if (perms && typeof perms === 'object') {
    for (const key of ['allow', 'deny'] as const) {
      if (!Array.isArray(perms[key])) continue;
      perms[key] = perms[key].filter((r: string) => !j.added[key].includes(r));
      if (perms[key].length === 0 && j.added[key].length > 0) delete perms[key];
    }
    if (!j.permissionsExisted && Object.keys(perms).length === 0) delete data.permissions;
  }
  return JSON.stringify(data, null, 2) + '\n';
}

function restoreFromJournal(j: Journal): string {
  const { settingsPath } = j;
  const current = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;

  if (current !== undefined && sha(current) === j.writtenHash) {
    // Untouched since we wrote it: put the original back byte for byte (or remove the file we created).
    if (j.originalExisted) copyFileSync(j.backupPath, settingsPath);
    else unlinkSync(settingsPath);
    return 'restored from backup';
  }
  if (current === undefined) {
    if (j.originalExisted) copyFileSync(j.backupPath, settingsPath);
    return 'settings file was missing; original restored';
  }
  const cleaned = removeAddedRules(current, j);
  if (cleaned === undefined) throw new AgyPermissionError(`${settingsPath} is not valid JSON now; remove the rules "${[...j.added.allow, ...j.added.deny].join('", "')}" by hand (backup: ${j.backupPath})`);
  writeAtomic(settingsPath, cleaned);
  return 'settings changed during the run; only the temporary rules were removed';
}

function pruneBackups(keep = 5): void {
  try {
    const files = readdirSync(backupsDir()).filter((f) => f.startsWith('agy-settings-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(backupsDir(), f), { force: true });
  } catch { /* nothing to prune */ }
}

/**
 * Repairs settings left behind by a crashed run. Returns a message when something was recovered.
 * Throws when another run is still active (its pid is alive).
 */
export function recoverAgyRules(): string | undefined {
  if (!existsSync(journalPath())) return undefined;
  const j = JSON.parse(readFileSync(journalPath(), 'utf8')) as Journal;
  if (j.pid !== process.pid && processAlive(j.pid)) {
    throw new AgyPermissionError(`Інший запуск agy ще триває (pid ${j.pid}, проєкт ${j.project}). Дочекайся його завершення.`);
  }
  const how = restoreFromJournal(j);
  rmSync(journalPath(), { force: true });
  return `Відновлено налаштування agy після незавершеного запуску (${how}).`;
}

export type AgyRuleHandle = {
  /** Removes the temporary rules (idempotent, synchronous). */
  restore(): string;
  added: { allow: string[]; deny: string[] };
};

export function applyAgyRules(opts: { settingsPath: string; project: string; allow: string[]; deny: string[] }): AgyRuleHandle {
  const settingsPath = expandHome(opts.settingsPath);
  const recovered = recoverAgyRules(); // also refuses when another run is active
  void recovered;

  const originalExisted = existsSync(settingsPath);
  const originalText = originalExisted ? readFileSync(settingsPath, 'utf8') : '{}';
  let data: Record<string, any>;
  try {
    data = JSON.parse(originalText);
  } catch {
    throw new AgyPermissionError(`${settingsPath} не є коректним JSON: виправ його (нічого не змінено).`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new AgyPermissionError(`${settingsPath}: очікувався JSON-об'єкт.`);

  mkdirSync(backupsDir(), { recursive: true, mode: 0o700 });
  const backupPath = join(backupsDir(), `agy-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(backupPath, originalText, { mode: 0o600 });

  const permissionsExisted = data.permissions !== undefined;
  data.permissions = data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
  // Only add rules that are not there yet, so removal never deletes a rule the user owns.
  const added = { allow: [] as string[], deny: [] as string[] };
  for (const key of ['allow', 'deny'] as const) {
    const existing: string[] = Array.isArray(data.permissions[key]) ? data.permissions[key] : [];
    added[key] = opts[key].filter((r) => !existing.includes(r));
    data.permissions[key] = [...existing, ...added[key]];
  }

  const text = JSON.stringify(data, null, 2) + '\n';
  const journal: Journal = {
    settingsPath, backupPath, originalExisted, permissionsExisted, writtenHash: sha(text), added,
    pid: process.pid, project: opts.project, startedAt: new Date().toISOString(),
  };
  // Journal first: if we crash between the two writes, recovery still knows what to do.
  writeJsonAtomic(journalPath(), journal);
  writeAtomic(settingsPath, text, originalExisted ? statSync(settingsPath).mode & 0o777 : 0o600);
  if (!originalExisted) chmodSync(settingsPath, 0o600);

  let done = false;
  const restore = (): string => {
    if (done) return 'already restored';
    done = true;
    unregister();
    const how = restoreFromJournal(journal);
    rmSync(journalPath(), { force: true });
    pruneBackups();
    return how;
  };
  // Restore even if the process is killed or Ctrl+C is pressed during the run.
  const unregister = onExit(() => { restore(); }, 1);
  return { restore, added };
}
