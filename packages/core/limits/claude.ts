// Claude Code usage: parses the text printed by `claude -p "/usage"`.
// Sample (recon row 15):
//   Current session: 2% used · resets Oct 1 at 12:30pm (Europe/Berlin)
//   Current week (all models): 3% used · resets Oct 1 at 9am (Europe/Berlin)
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../exec';
import { maskEmail, maskSecrets } from '../mask';
import { sbHome } from '../store';
import { systemTimeZone, zonedDate, zonedToUtcMs } from '../time';
import type { AgentConfig, GroupWindow, UsageSnapshot, UsageWindow } from '../types';

export class UsageParseError extends Error {}

/** First chars of unexpected CLI output, single line, so a parse failure is debuggable. */
export function snippet(text: string, max = 120): string {
  const one = maskSecrets(text.replace(/\s+/g, ' ').trim());
  return one ? JSON.stringify(one.slice(0, max)) : '(empty output)';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const LINE_RE =
  /^\s*Current\s+(session|week)(?:\s*\(([^)]*)\))?\s*:\s*(\d+(?:\.\d+)?)\s*%\s*used(?:\s*[·•|–-]\s*resets?\s+(.+?))?\s*$/gim;

const RESET_RE =
  /^(?:(?<mon>[A-Za-z]{3,9})\.?\s+(?<day>\d{1,2})(?:,?\s+(?<year>\d{4}))?\s*(?:at\s+)?)?(?<h>\d{1,2})(?::(?<min>\d{2}))?\s*(?<ap>am|pm)\s*(?:\((?<tz>[^)]+)\))?/i;

/**
 * Parses a reset phrase like "Oct 1 at 12:30pm (Europe/Berlin)" or "9am (Europe/Berlin)"
 * into an ISO UTC string. The CLI prints no year, so the nearest future date is used.
 */
export function parseResetTime(text: string, now: Date): string | undefined {
  const m = RESET_RE.exec(text.trim());
  if (!m?.groups) return undefined;
  const g = m.groups;
  const tz = g.tz?.trim() || systemTimeZone();

  let h = Number(g.h) % 12;
  if (g.ap!.toLowerCase() === 'pm') h += 12;
  const min = g.min ? Number(g.min) : 0;

  try {
    const today = zonedDate(now.getTime(), tz);
    if (g.mon) {
      const mo = MONTHS.indexOf(g.mon.slice(0, 3).toLowerCase()) + 1;
      if (mo < 1) return undefined;
      const day = Number(g.day);
      let year = g.year ? Number(g.year) : today.y;
      let ms = zonedToUtcMs(year, mo, day, h, min, tz);
      // No explicit year and the date is clearly in the past: it means next year.
      if (!g.year && ms < now.getTime() - 36 * 3600_000) {
        year += 1;
        ms = zonedToUtcMs(year, mo, day, h, min, tz);
      }
      return new Date(ms).toISOString();
    }
    // Time only: today if still ahead, otherwise tomorrow.
    let ms = zonedToUtcMs(today.y, today.mo, today.d, h, min, tz);
    if (ms < now.getTime()) ms = zonedToUtcMs(today.y, today.mo, today.d + 1, h, min, tz);
    return new Date(ms).toISOString();
  } catch {
    // Unknown time zone name etc.
    return undefined;
  }
}

export type ParsedClaudeUsage = {
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  perGroup: GroupWindow[];
};

export function parseClaudeUsage(text: string, now = new Date()): ParsedClaudeUsage {
  const out: ParsedClaudeUsage = { perGroup: [] };
  for (const m of text.matchAll(LINE_RE)) {
    const kind = m[1]!.toLowerCase();
    const qualifier = m[2]?.trim().toLowerCase();
    const usedPct = Number(m[3]);
    const resetsAt = m[4] ? parseResetTime(m[4], now) : undefined;

    if (kind === 'session') {
      // A window without a parseable reset time is useless for routing: skip it.
      if (resetsAt) out.fiveHour = { usedPct, resetsAt };
    } else if (!qualifier || qualifier === 'all models') {
      if (resetsAt) out.weekly = { usedPct, resetsAt };
    } else {
      out.perGroup.push({ group: m[2]!.trim(), window: 'weekly', usedPct, resetsAt });
    }
  }
  if (!out.fiveHour && !out.weekly) {
    throw new UsageParseError('no "Current session / Current week" lines found in /usage output');
  }
  return out;
}

/** Account label from `claude auth status` (JSON). Best effort: any failure returns undefined. */
export async function fetchClaudeAccount(cfg: AgentConfig, timeoutMs: number): Promise<string | undefined> {
  const r = await runCommand(cfg.cmd, ['auth', 'status'], { timeoutMs, cwd: tmpdir() });
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout) as { email?: string; subscriptionType?: string };
    const mail = j.email ? maskEmail(j.email) : undefined;
    return [mail, j.subscriptionType].filter(Boolean).join(' · ') || undefined;
  } catch {
    return undefined;
  }
}

/** Optional fallback: snapshot written by hooks/claude-statusline.mjs (needs `rate_limits`). */
export function readStatuslineSnapshot(): UsageSnapshot | undefined {
  try {
    const s = JSON.parse(readFileSync(join(sbHome(), 'claude-usage.json'), 'utf8')) as UsageSnapshot;
    return s.agent === 'claude' && (s.fiveHour || s.weekly) ? s : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchClaudeUsage(cfg: AgentConfig, timeoutMs: number, now = new Date()): Promise<UsageSnapshot> {
  // Run outside any project so no project rules/hooks are loaded for a read-only command.
  const r = await runCommand(cfg.cmd, cfg.usageArgs, { timeoutMs, cwd: tmpdir() });
  if (r.spawnError) throw new Error(`cannot run "${cfg.cmd}": ${r.spawnError}`);
  if (r.timedOut) throw new Error(`"${cfg.cmd} ${cfg.usageArgs.join(' ')}" timed out`);

  let parsed: ParsedClaudeUsage;
  try {
    parsed = parseClaudeUsage(r.stdout, now);
  } catch (e) {
    const fallback = readStatuslineSnapshot();
    if (fallback) return fallback;
    throw new UsageParseError(`${(e as Error).message}; got: ${snippet(r.stdout || r.stderr)}`);
  }

  const account = await fetchClaudeAccount(cfg, timeoutMs);
  return {
    agent: 'claude',
    fiveHour: parsed.fiveHour,
    weekly: parsed.weekly,
    perGroup: parsed.perGroup.length ? parsed.perGroup : undefined,
    account,
    source: 'cli',
    capturedAt: now.toISOString(),
  };
}
