import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Make locally installed model CLIs discoverable before probing providers. */
export function prepareProviderPath(): Promise<void> {
  if (process.platform === 'win32') {
    const { LOCALAPPDATA, PATH } = process.env;
    if (LOCALAPPDATA) {
      // A launcher started before agy was installed can inherit an older PATH.
      const agyBin = join(LOCALAPPDATA, 'agy', 'bin');
      const paths = PATH ? PATH.split(delimiter) : [];
      if (existsSync(join(agyBin, 'agy.exe')) && !paths.some((entry) => entry.toLowerCase() === agyBin.toLowerCase())) {
        process.env.PATH = [...paths, agyBin].join(delimiter);
      }
    }
    return Promise.resolve();
  }

  // Desktop launchers on macOS and Linux can start with a shorter PATH than the login shell.
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
