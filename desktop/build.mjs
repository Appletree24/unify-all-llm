// Bundles the Electron main process (with the shared Unify core from ../src),
// the sandboxed preload, and the React renderer into dist/.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mobileBundle } from '../mobile/build.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'renderer'), { recursive: true });
cpSync(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html'));
cpSync(join(root, 'native/office-text.py'), join(out, 'office-text.py'));
if (process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0) {
  const compiler = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', join(tmpdir(), 'unify-swift-modules'),
    join(root, 'native/material-text.swift'), '-o', join(out, 'material-text')], { stdio: 'inherit' });
  if (compiler.status !== 0) throw new Error('macOS 材料读取工具编译失败');
}

const common = { bundle: true, sourcemap: production ? false : 'linked', minify: production, logLevel: 'info', legalComments: 'none' };
const configs = [
  { ...common, ...mobileBundle(join(out, 'mobile')) },
  {
    ...common, entryPoints: [join(root, 'src/main/index.ts')], outfile: join(out, 'main.mjs'),
    platform: 'node', format: 'esm', target: 'node22', external: ['electron'],
    // Bundled CommonJS dependencies may still call require() for Node built-ins.
    banner: { js: "import { createRequire as __unifyRequire } from 'node:module'; const require = __unifyRequire(import.meta.url);" },
  },
  {
    ...common, entryPoints: [join(root, 'src/preload.ts')], outfile: join(out, 'preload.cjs'),
    platform: 'node', format: 'cjs', target: 'node22', external: ['electron'],
  },
  {
    ...common, entryPoints: [join(root, 'src/renderer/main.tsx')], outfile: join(out, 'renderer/app.js'),
    platform: 'browser', format: 'esm', target: 'chrome130', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  },
];

if (watch) {
  for (const config of configs) await (await context(config)).watch();
  console.log('watching for changes…');
} else {
  await Promise.all(configs.map((config) => build(config)));
}
