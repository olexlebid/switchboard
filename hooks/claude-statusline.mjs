#!/usr/bin/env node
// Claude Code statusLine hook for Switchboard.
// Reads the statusLine JSON from stdin, saves the rate-limit windows (if this Claude Code
// version provides `rate_limits`) to ~/.switchboard/claude-usage.json and prints a short line.
// If the user already had a statusLine command, it is passed as `--wrap-b64 <base64>`:
// we run it with the same stdin and print its output first, then ours.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString('utf8');

let data = {};
try { data = JSON.parse(raw); } catch { /* not JSON: print nothing of ours */ }

// Convert one rate-limit window to the UsageWindow shape used by Switchboard.
function windowOf(w) {
  if (!w || typeof w.used_percentage !== 'number' || w.resets_at == null) return undefined;
  const ms = typeof w.resets_at === 'number' ? (w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at) : Date.parse(w.resets_at);
  if (!Number.isFinite(ms)) return undefined;
  return { usedPct: w.used_percentage, resetsAt: new Date(ms).toISOString() };
}

const rl = data.rate_limits;
const fiveHour = windowOf(rl?.five_hour);
const weekly = windowOf(rl?.seven_day);

if (fiveHour || weekly) {
  try {
    const dir = process.env.SB_HOME ?? join(homedir(), '.switchboard');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'claude-usage.json');
    const tmp = `${file}.${process.pid}.tmp`;
    const snap = { agent: 'claude', fiveHour, weekly, source: 'statusline', capturedAt: new Date().toISOString() };
    writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch { /* never break the status line because of a write error */ }
}

const parts = [];
const wrapIdx = process.argv.indexOf('--wrap-b64');
if (wrapIdx > 0 && process.argv[wrapIdx + 1]) {
  const cmd = Buffer.from(process.argv[wrapIdx + 1], 'base64').toString('utf8');
  const r = spawnSync(cmd, { shell: true, input: raw, encoding: 'utf8', timeout: 5000 });
  const line = (r.stdout ?? '').split('\n')[0]?.trim();
  if (line) parts.push(line);
}
if (fiveHour) parts.push(`5h ${Math.round(fiveHour.usedPct)}%`);
if (weekly) parts.push(`7d ${Math.round(weekly.usedPct)}%`);
console.log(parts.join(' | '));
