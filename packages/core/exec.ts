// Runs a CLI without a shell, with a timeout and a capped output buffer.
import { spawn } from 'node:child_process';

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not even be started (e.g. ENOENT). */
  spawnError?: string;
};

const MAX_BYTES = 1_000_000;

export function runCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv } = { timeoutMs: 30_000 },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, opts.timeoutMs);

    child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_BYTES) stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_BYTES) stderr += d.toString(); });
    child.on('error', (e) => done({ code: null, stdout, stderr, timedOut, spawnError: e.message }));
    child.on('close', (code) => done({ code, stdout, stderr, timedOut }));
  });
}
