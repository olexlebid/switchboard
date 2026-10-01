// "Merge into main": the one place where Switchboard moves work from an `sb/*` branch into the base branch.
// Agents never do this themselves. It runs only after the owner confirms (dashboard dialog or `sb merge --yes`),
// is a fast-forward only (no merge commits, no conflicts to resolve), and never pushes or deploys.
import { SbError } from './errors';
import { blockingDirtyFiles, branchExists, commitsAhead, currentBranch, filesAhead, isAncestor, mergeFastForward, summarizeDirty, type BranchCommit } from './git';

export type MergePreview = {
  project: string;
  branch: string;
  base: string;
  commits: BranchCommit[];
  files: string[];
  canMerge: boolean;
  /** Why the merge cannot be done right now (shown instead of the confirm button). */
  reason?: string;
};

export async function previewMerge(project: string, branch: string, base: string): Promise<MergePreview> {
  const out: MergePreview = { project, branch, base, commits: [], files: [], canMerge: false };
  const no = (reason: string): MergePreview => ({ ...out, reason });

  if (!branch.startsWith('sb/') || base.startsWith('sb/')) return no('Зливати можна лише гілки sb/* у звичайну базову гілку.');
  if (!(await branchExists(project, branch))) return no(`Гілки ${branch} уже немає.`);
  if (!(await branchExists(project, base))) return no(`Базової гілки ${base} немає.`);

  out.commits = await commitsAhead(project, base, branch);
  if (out.commits.length === 0) return no(`У ${branch} немає нових комітів відносно ${base}: уже влито або нічого не змінено.`);
  out.files = await filesAhead(project, base, branch);

  if (!(await isAncestor(project, base, branch))) {
    return no(`${base} пішла вперед від початку роботи, тож швидке злиття (fast-forward) неможливе. Злий гілку вручну (git merge або rebase) і розв'яжи конфлікти.`);
  }
  const now = await currentBranch(project).catch(() => undefined);
  if (now !== base) return no(`Проєкт зараз на гілці ${now ?? '(detached HEAD)'}, а не на ${base}. Переключись: git switch ${base}.`);
  const dirty = await blockingDirtyFiles(project);
  if (dirty.length > 0) return no(`Робоче дерево проєкту не чисте (${dirty.length} змін: ${summarizeDirty(dirty)}). Закоміть або відклади зміни.`);
  return { ...out, canMerge: true };
}

/** Re-checks everything, then fast-forwards the base branch. Throws SbError when the merge is not possible. */
export async function mergeBranch(project: string, branch: string, base: string): Promise<{ preview: MergePreview; sha: string }> {
  const preview = await previewMerge(project, branch, base);
  if (!preview.canMerge) throw new SbError(preview.reason ?? 'Злиття неможливе.', 3);
  const sha = await mergeFastForward(project, branch);
  return { preview, sha };
}
