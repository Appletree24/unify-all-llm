import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';

/**
 * Apps launched from the Dock or a desktop launcher on macOS/Linux get a minimal PATH,
 * so model CLIs installed via npm, Homebrew or nvm would look "not installed".
 * Borrow the PATH of the user's login shell once at startup. Windows GUI apps already
 * inherit the user's PATH.
 */
export function adoptLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const marker = '__UNIFY_PATH__';
  return new Promise((done) => {
    execFile(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], { timeout: 4000, env: process.env }, (err, stdout) => {
      const found = !err && stdout.split(marker)[1];
      if (found) {
        const merged = [...new Set([...found.split(delimiter), ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean))];
        process.env.PATH = merged.join(delimiter);
      }
      done();
    });
  });
}
