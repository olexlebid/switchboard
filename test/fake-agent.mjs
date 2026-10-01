#!/usr/bin/env node
// Mock agent CLI for tests. Never calls a real model, so failover tests burn no real limits.
// Behaviour is chosen with FAKE_AGENT_MODE; FAKE_AGENT_STYLE=agy switches the output format.
//   success  writes a component + PROGRESS.md and reports success
//   partial  writes a component, then reports a denied Write
//   denied   writes nothing, reports a denied Write
//   hang     never finishes (also spawns a child shell to test process-group kill)
//   error    prints to stderr and exits 1
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const prompt = args[0] === '-p' ? args[1] ?? '' : '';
const mode = process.env.FAKE_AGENT_MODE ?? 'success';
const style = process.env.FAKE_AGENT_STYLE ?? 'claude';
const taskId = /Task id: (t-[\w-]+)/.exec(prompt)?.[1] ?? 'unknown';

function report({ ok = true, denied = [], text = 'done' }) {
  if (style === 'agy') {
    console.log(JSON.stringify({
      conversation_id: 'fake', status: 'SUCCESS', response: text, duration_seconds: 0.1,
      denied_actions: denied.map((d) => ({ action: d.toLowerCase(), display_name: d })),
    }));
  } else {
    console.log(JSON.stringify({
      type: 'result', subtype: 'success', is_error: !ok, result: text, num_turns: 2,
      permission_denials: denied.map((d) => ({ tool_name: d, tool_input: {} })),
    }));
  }
}

function writeWork() {
  mkdirSync('src/components', { recursive: true });
  writeFileSync('src/components/Footer.astro', '---\n// fake footer\n---\n<footer class="footer section"></footer>\n');
}

function writeProgress(status = process.env.FAKE_PROGRESS_STATUS ?? 'done') {
  const questions = status === 'blocked' ? '- Open questions:\n  - No Astro project, build not verified\n' : '';
  appendFileSync('PROGRESS.md', `\n## Task ${taskId}: Footer\n- Status: ${status}\n- Last agent: ${style === 'agy' ? 'agy' : 'claude'}\n- Done:\n  - [x] Footer (src/components/Footer.astro)\n${questions}`);
}

switch (mode) {
  case 'success':
    console.log('working... api key sk-abcdefgh12345678 should never reach the log');
    writeWork();
    writeProgress();
    report({ text: 'Created Footer.astro' });
    break;
  case 'partial':
    writeWork();
    report({ denied: ['Write'], text: 'Could not finish' });
    break;
  case 'denied':
    report({ denied: ['Write'], text: 'Write was denied' });
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
