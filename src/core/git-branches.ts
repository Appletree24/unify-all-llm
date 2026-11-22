import { execFile } from 'node:child_process';

export interface GitBranches {
  current: string | null;
  local: string[];
}

function git(cwd: string, args: string[], { allowMissing = false, timeout = 3000 } = {}): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) resolve(stdout.replace(/\r?\n$/, ''));
      else if (allowMissing && err.code === 1) resolve(null);
      else reject(new Error(stderr.trim() || err.message));
    });
  });
}

const heads = 'refs/heads/';

/** null means detached HEAD. Missing Git or an invalid worktree is an error. */
export async function currentGitBranch(cwd: string): Promise<string | null> {
  const ref = await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'], { allowMissing: true });
  return ref === null ? null : ref.slice(heads.length);
}

export async function listGitBranches(cwd: string): Promise<GitBranches> {
  const [current, refs] = await Promise.all([
    currentGitBranch(cwd),
    git(cwd, ['for-each-ref', '--format=%(refname)', '--sort=refname', heads]),
  ]);
  const local = refs ? refs.split(/\r?\n/).map((ref) => ref.slice(heads.length)) : [];
  return { current, local };
}

export async function switchGitBranch(cwd: string, branch: string): Promise<void> {
  if (typeof branch !== 'string' || !branch) throw new Error('请选择本地 Git 分支');
  const found = await git(cwd, ['show-ref', '--verify', '--quiet', heads + branch], { allowMissing: true });
  if (found === null) throw new Error(`找不到本地分支「${branch}」`);
  await git(cwd, ['switch', '--no-guess', '--', branch], { timeout: 0 });
}
