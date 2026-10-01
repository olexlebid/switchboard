// Installs/removes the statusLine hook in ~/.claude/settings.json.
// Always backs up the file first and wraps an existing statusLine instead of replacing it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sbHome, writeJsonAtomic } from './store';

type StatusLine = { type?: string; command?: string; [k: string]: unknown };

const HOOK_PATH = fileURLToPath(new URL('../../hooks/claude-statusline.mjs', import.meta.url));

function settingsPath(): string {
  return join(process.env.CLAUDE_HOME ?? join(homedir(), '.claude'), 'settings.json');
}
const backupInfoPath = () => join(sbHome(), 'hook-backup.json');

function readSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON; fix it first (nothing was changed)`);
  }
}

function hookCommand(original?: StatusLine): string {
  const base = `node ${JSON.stringify(HOOK_PATH)}`;
  if (original?.type === 'command' && original.command) {
    return `${base} --wrap-b64 ${Buffer.from(original.command).toString('base64')}`;
  }
  return base;
}

export function installHook(opts: { dryRun?: boolean } = {}): number {
  const path = settingsPath();
  const settings = readSettings(path);
  const current = settings.statusLine as StatusLine | undefined;

  if (typeof current?.command === 'string' && current.command.includes('claude-statusline.mjs')) {
    console.log('Хук вже встановлено, нічого не змінено.');
    return 0;
  }
  const next = { type: 'command', command: hookCommand(current) };
  console.log(`Файл: ${path}`);
  console.log(`Було:  ${current ? JSON.stringify(current) : '(statusLine не задано)'}`);
  console.log(`Стане: ${JSON.stringify(next)}`);
  if (opts.dryRun) {
    console.log('Dry-run: файл не змінено.');
    return 0;
  }

  mkdirSync(join(path, '..'), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.sb-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
  }
  writeJsonAtomic(backupInfoPath(), { settings: path, backup, originalStatusLine: current ?? null });
  settings.statusLine = next;
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  console.log(backup ? `Бекап: ${backup}` : 'Бекап не потрібен (файлу не було).');
  console.log('Готово. Перезапусти відкриті сесії claude, щоб хук підхопився.');
  return 0;
}

export function uninstallHook(): number {
  let info: { settings: string; backup: string | null; originalStatusLine: StatusLine | null };
  try {
    info = JSON.parse(readFileSync(backupInfoPath(), 'utf8'));
  } catch {
    console.error('Немає запису про встановлення хука (hook-backup.json): нічого відкочувати.');
    return 1;
  }
  const settings = readSettings(info.settings);
  if (info.originalStatusLine) settings.statusLine = info.originalStatusLine;
  else delete settings.statusLine;
  writeFileSync(info.settings, JSON.stringify(settings, null, 2) + '\n');
  console.log(`statusLine відновлено в ${info.settings}.`);
  if (info.backup) console.log(`Повна копія вихідного файлу: ${info.backup}`);
  return 0;
}
