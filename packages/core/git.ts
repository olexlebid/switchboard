// Thin git helpers for the runner. Only safe commands: no push --force, reset --hard, merge or rebase.
import { runCommand } from './exec';

export class GitError extends Error {}

type GitResult = { code: number | null; stdout: string; stderr: string };

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  const r = await runCommand('git', args, { cwd, timeoutMs });
  if (r.spawnError) throw new GitError(`cannot run git: ${r.spawnError}`);
  return r;
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new GitError(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** Name of the checked out branch; throws on a detached HEAD (we need a branch to return to). */
export async function currentBranch(cwd: string): Promise<string> {
  const name = await gitOk(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (name === 'HEAD') throw new GitError('HEAD is detached; check out a branch first');
  return name;
}

export async function headSha(cwd: string): Promise<string> {
  return gitOk(cwd, ['rev-parse', 'HEAD']);
}

/** Lines of `git status --porcelain`; empty when the working tree is clean. */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  const out = await gitOk(cwd, ['status', '--porcelain']);
  return out ? out.split('\n') : [];
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const r = await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.code === 0;
}

/** Switches to `branch`, creating it from the current HEAD when it does not exist yet. */
export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  if (await branchExists(cwd, branch)) await gitOk(cwd, ['checkout', branch]);
  else await gitOk(cwd, ['checkout', '-b', branch]);
}

export async function switchBack(cwd: string, branch: string): Promise<void> {
  await gitOk(cwd, ['checkout', branch]);
}

/** Commits everything. Returns the new sha, or undefined when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<string | undefined> {
  if ((await dirtyFiles(cwd)).length === 0) return undefined;
  await gitOk(cwd, ['add', '-A']);
  // Fall back to a neutral identity only when the repo has none configured.
  const hasIdentity = (await git(cwd, ['config', 'user.email'])).stdout.trim() !== '';
  const identity = hasIdentity ? [] : ['-c', 'user.name=Switchboard', '-c', 'user.email=switchboard@localhost'];
  await gitOk(cwd, [...identity, 'commit', '-m', message]);
  return headSha(cwd);
}

/** `git diff --stat <base>..HEAD`, e.g. for the handoff note. */
export async function diffStat(cwd: string, base: string): Promise<string> {
  return gitOk(cwd, ['diff', '--stat', `${base}..HEAD`]);
}

export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const out = await gitOk(cwd, ['diff', '--name-only', `${base}..HEAD`]);
  return out ? out.split('\n') : [];
}

/** Pushes the task branch (never forced, never the base branch). */
export async function pushBranch(cwd: string, branch: string): Promise<void> {
  if (!branch.startsWith('sb/')) throw new GitError(`refusing to push non-task branch "${branch}"`);
  await gitOk(cwd, ['push', '-u', 'origin', branch]);
}

/** Stages everything (including new files). */
export async function stageAll(cwd: string): Promise<void> {
  await gitOk(cwd, ['add', '-A']);
}

/** `git diff --cached --stat <base>`: everything staged plus earlier commits, compared with the task start. */
export async function stagedStat(cwd: string, base: string): Promise<string> {
  return gitOk(cwd, ['diff', '--cached', '--stat', base]);
}
