// Spawns an agent CLI in the project directory, logs its output (secrets masked) and enforces a timeout.
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { maskSecrets } from './mask';
import { runsDir } from './store';
import type { AgentConfig, AgentId, PermissionRules } from './types';

const MAX_CAPTURE = 5_000_000;
const MAX_LINE = 1_000_000;

/** Line-buffered masking writer: a secret never gets cut in half by a chunk boundary. */
class MaskedLog {
  private fd: number;
  private pending: Record<'out' | 'err', string> = { out: '', err: '' };

  constructor(path: string) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    this.fd = openSync(path, 'a', 0o600);
    chmodSync(path, 0o600);
  }

  header(text: string): void {
    writeSync(this.fd, maskSecrets(text) + '\n');
  }

  write(stream: 'out' | 'err', chunk: string): void {
    let buf = this.pending[stream] + chunk;
    const prefix = stream === 'err' ? '[stderr] ' : '';
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      writeSync(this.fd, prefix + maskSecrets(buf.slice(0, nl)) + '\n');
      buf = buf.slice(nl + 1);
    }
    // A single endless line: flush it so memory stays bounded.
    if (buf.length > MAX_LINE) {
      writeSync(this.fd, prefix + maskSecrets(buf) + '\n');
      buf = '';
    }
    this.pending[stream] = buf;
  }

  close(): void {
    for (const stream of ['out', 'err'] as const) {
      if (this.pending[stream]) this.write(stream, '\n');
    }
    closeSync(this.fd);
  }
}

export function logPathFor(runId: string): string {
  return join(runsDir(), `${runId}.log`);
}

/** Builds the argv for a headless run: `-p <prompt> <rest of headlessArgs> <permission flags> <extra args>`. */
export function buildAgentArgs(
  agent: AgentId,
  cfg: AgentConfig,
  prompt: string,
  rules: PermissionRules & { args: string[] },
  timeoutMs: number,
): string[] {
  const [flag, ...rest] = cfg.headlessArgs;
  const args = [flag!, prompt, ...rest];
  if (agent === 'claude') {
    if (rules.allow.length) args.push('--allowedTools', rules.allow.join(','));
    if (rules.deny.length) args.push('--disallowedTools', rules.deny.join(','));
  } else {
    // agy stops by itself when the print timeout is reached; ours is a hard backstop.
    args.push('--print-timeout', `${Math.max(1, Math.floor(timeoutMs / 1000))}s`);
  }
  return [...args, ...rules.args];
}

export type ProcessResult = {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  spawnError?: string;
};

export async function runAgentProcess(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  logPath: string;
  /** Human-readable description written at the top of the log (prompt shortened). */
  logHeader: string;
}): Promise<ProcessResult> {
  const log = new MaskedLog(opts.logPath);
  log.header(opts.logHeader);
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // detached = own process group, so a timeout also kills the agent's child shells.
    const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const killGroup = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      log.header(`[switchboard] timeout after ${Math.round(opts.timeoutMs / 1000)}s, stopping the agent`);
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 3000).unref();
    }, opts.timeoutMs);

    const finish = (r: Omit<ProcessResult, 'durationMs' | 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.close();
      resolve({ ...r, stdout, stderr, durationMs: Date.now() - started });
    };

    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      log.write('out', s);
      if (stdout.length < MAX_CAPTURE) stdout += s;
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      log.write('err', s);
      if (stderr.length < MAX_CAPTURE) stderr += s;
    });
    child.on('error', (e) => finish({ code: null, timedOut, spawnError: e.message }));
    child.on('close', (code) => finish({ code, timedOut }));
  });
}
