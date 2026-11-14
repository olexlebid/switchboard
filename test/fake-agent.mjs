#!/usr/bin/env node
// Mock agent CLI for tests. Never calls a real model, so failover tests burn no real limits.
// Behaviour is chosen with FAKE_AGENT_MODE; FAKE_AGENT_STYLE=agy switches the output format.
//   success  writes a component + PROGRESS.md and reports success
//   partial  writes a component, then reports a denied Write
//   denied   writes nothing, reports a denied Write
//   answer   replies with the user's message and writes nothing (read-only API tests)
//   slow     like answer, but after 1.5 s
//   readurl  produces no reply, reports a denied read_url (a link the agent may not open)
//   hang     never finishes (also spawns a child shell to test process-group kill)
//   error    prints to stderr and exits 1
//   limit    writes partial work, then fails with a usage-limit message (reset time from FAKE_RESET_AT)
//   echo-fail fails for an unrelated reason but echoes the task line (which may mention quota)
// FAKE_PROMPT_DUMP=<file> appends every received prompt to that file.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const style = process.env.FAKE_AGENT_STYLE ?? 'claude';
// codex style: `exec --json <flags> [resume <id>] <prompt>`: the prompt is the last argument.
const prompt = style === 'codex' ? (args.at(-1) ?? '').replace(/^\n/, '') : args[0] === '-p' ? args[1] ?? '' : '';
const mode = process.env.FAKE_AGENT_MODE ?? 'success';
const taskId = /Task id: (t-[\w-]+)/.exec(prompt)?.[1] ?? 'unknown';
// Session continuity (chat): --resume <id> (claude) / --conversation <id> (agy).
const sessionFlag = style === 'agy' ? '--conversation' : style === 'codex' ? 'resume' : '--resume';
const resumeId = args[args.indexOf(sessionFlag) + 1];
const hasSession = args.includes(sessionFlag);
if (process.env.FAKE_PROMPT_DUMP) appendFileSync(process.env.FAKE_PROMPT_DUMP, `=== ${style}\n${prompt}\n`);
// FAKE_ARGV_DUMP=<file>: one line per run with the model argument (if any), to check `--model`.
if (process.env.FAKE_ARGV_DUMP) appendFileSync(process.env.FAKE_ARGV_DUMP, `${style} model=${args.includes('--model') ? args[args.indexOf('--model') + 1] : '-'}\n`);

// FAKE_ARGS_DUMP=<file>: the full argv of every run as one JSON line (prompt replaced by <prompt>).
if (process.env.FAKE_ARGS_DUMP) appendFileSync(process.env.FAKE_ARGS_DUMP, `${JSON.stringify({ style, args: args.map((a) => (a === prompt ? '<prompt>' : a)) })}\n`);

const sessionOut = hasSession ? resumeId : `${style}-${Math.random().toString(36).slice(2, 8)}`;
function report({ ok = true, denied = [], text = 'done' }) {
  if (style === 'codex') {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: sessionOut }));
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
  } else if (style === 'agy') {
    console.log(JSON.stringify({
      conversation_id: sessionOut, status: 'SUCCESS', response: text, duration_seconds: 0.1,
      denied_actions: denied.map((d) => ({ action: d.toLowerCase(), display_name: d })),
    }));
  } else {
    console.log(JSON.stringify({
      type: 'result', subtype: 'success', is_error: !ok, result: text, num_turns: 2, session_id: sessionOut,
      permission_denials: denied.map((d) => ({ tool_name: d, tool_input: {} })),
    }));
  }
}

// With FAKE_AGY_SETTINGS the fake behaves like agy: a write only works when the settings file holds a
// matching directory rule `write_file(<dir>/)` (and no matching deny rule). Denied writes are reported.
const denied = [];
function canWrite(rel) {
  const settingsPath = process.env.FAKE_AGY_SETTINGS;
  if (style !== 'agy' || !settingsPath) return true;
  let s = {};
  try { s = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* no settings: nothing allowed */ }
  const abs = resolve(realpathSync(process.cwd()), rel);
  const rules = (list) => (list ?? []).map((r) => /^write_file\((.*)\)$/.exec(r)?.[1]).filter(Boolean);
  const hit = (r) => (r.endsWith('/') ? abs.startsWith(r) : abs === r);
  const ok = rules(s.permissions?.allow).some(hit) && !rules(s.permissions?.deny).some(hit);
  if (!ok) denied.push('write_file');
  return ok;
}

function writeWork() {
  if (!canWrite('src/components/Footer.astro')) return;
  mkdirSync('src/components', { recursive: true });
  writeFileSync('src/components/Footer.astro', '---\n// fake footer\n---\n<footer class="footer section"></footer>\n');
}

function writeProgress(status = process.env.FAKE_PROGRESS_STATUS ?? 'done') {
  if (!canWrite('PROGRESS.md')) return;
  const questions = status === 'blocked' ? '- Open questions:\n  - No Astro project, build not verified\n' : '';
  appendFileSync('PROGRESS.md', `\n## Task ${taskId}: Footer\n- Status: ${status}\n- Last agent: ${style === 'agy' ? 'agy' : 'claude'}\n- Done:\n  - [x] Footer (src/components/Footer.astro)\n${questions}`);
}

switch (mode) {
  case 'success':
    console.log('working... api key sk-abcdefgh12345678 should never reach the log');
    writeWork();
    writeProgress();
    report({ text: `Created Footer.astro. (${prompt.split('\n').find((l) => /quota|rate limit/i.test(l)) ?? 'ok'})`, denied: [...new Set(denied)] });
    break;
  case 'chat': {
    // Chat turn: edits a file named after the agent and answers with the user's message, the session
    // state ("new" / "resumed") and whether a transcript of earlier messages was included.
    const msg = (prompt.split('USER MESSAGE:\n\n')[1] ?? prompt).split('\n')[0];
    mkdirSync('chat', { recursive: true });
    appendFileSync(`chat/${style}.txt`, `${msg}\n`);
    const transcript = prompt.includes('Conversation so far') ? 'transcript' : 'no-transcript';
    report({ text: `echo(${style}): ${msg} [${hasSession ? 'resumed' : 'new'}, ${transcript}]` });
    break;
  }
  case 'protected':
    writeWork();
    writeProgress();
    writeFileSync('netlify.toml', '[build]\n');
    report({ text: 'Also touched netlify.toml' });
    break;
  case 'limit': {
    writeWork();
    const reset = process.env.FAKE_RESET_AT ?? new Date(Date.now() + 2 * 3600_000).toISOString();
    if (style === 'codex') {
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-limit' }));
      console.log(JSON.stringify({ type: 'turn.failed', error: { message: `You've hit your usage limit. Try again at ${reset}.` } }));
    } else if (style === 'agy') {
      console.log(JSON.stringify({ conversation_id: 'fake', status: 'ERROR', response: '', error: `RESOURCE_EXHAUSTED: quota exceeded. Resets at ${reset}`, denied_actions: [] }));
      console.error(`Error: RESOURCE_EXHAUSTED (429) resets at ${reset}`);
    } else {
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${Math.floor(Date.parse(reset) / 1000)}`, permission_denials: [] }));
    }
    process.exit(1);
    break;
  }
  case 'echo-fail': {
    const line = prompt.split('\n').find((l) => /quota|rate limit/i.test(l)) ?? prompt.split('\n').pop();
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: `Cannot continue. Task says: ${line}`, permission_denials: [] }));
    process.exit(1);
    break;
  }
  case 'hang-agy':
    writeWork();
    setTimeout(() => {}, 60_000);
    break;
  case 'partial':
    writeWork();
    report({ denied: ['Write'], text: 'Could not finish' });
    break;
  case 'denied':
    report({ denied: ['Write'], text: 'Write was denied' });
    break;
  case 'answer':
  case 'slow': {
    const msg = (prompt.split('USER MESSAGE:\n\n')[1] ?? prompt).split('\n')[0];
    const text = msg.includes('SECRET') ? `key ghp_${'a'.repeat(30)} in ${process.cwd()}/src` : `Відповідь: ${msg}`;
    if (mode === 'slow') setTimeout(() => report({ text }), 1500);
    else report({ text });
    break;
  }
  case 'readurl':
    report({ denied: ['read_url'], text: '' });
    break;
  case 'hang':
    spawn('sleep', ['61'], { stdio: 'ignore' });
    setTimeout(() => {}, 60_000);
    break;
  case 'error':
    console.error('boom');
    process.exit(1);
    break;
  default:
    console.error(`unknown FAKE_AGENT_MODE ${mode}`);
    process.exit(2);
}
