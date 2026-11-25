import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));

export function mobileBundle(outdir) {
  return {
    absWorkingDir: source, entryPoints: { mobile: './app.tsx', index: './index.html' },
    outdir, bundle: true, loader: { '.html': 'copy' }, minify: true,
    format: 'esm', platform: 'browser', target: ['safari15', 'chrome100'], jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await build(mobileBundle(resolve(source, '../dist/mobile')));
}
