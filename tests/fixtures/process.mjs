import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'tree') {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'child'], { stdio: ['ignore', 'inherit', 'inherit'] });
  setInterval(() => {}, 1000);
} else if (process.argv[2] === 'child') {
  process.on('SIGTERM', () => {});
  process.stdout.write(`${process.pid}\n`);
  setInterval(() => {}, 1000);
} else if (process.argv[2] === 'failure') {
  process.stdout.write('{"type":"done","text":"partial"}\n');
  process.exitCode = 2;
} else if (process.argv[2] === 'bad-json') {
  process.stdout.write('{not-json}\n');
} else {
  process.stdout.write(process.argv.slice(2).join('|'));
}
