// Supervises the watch-mode processes for `npm run watch`/`npm run dev` so
// they don't rely on untracked shell background jobs (`&`), which silently
// orphan children and don't propagate a real failure exit code.

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode !== 'watch' && mode !== 'dev') {
  console.error('Usage: node scripts/dev.mjs <watch|dev>');
  process.exit(1);
}

const rootDir = fileURLToPath(new URL('..', import.meta.url));

// A clean checkout has no public/ directory at all — guarantee
// public/index.html, public/dist/, and public/styles/ all exist before any
// watcher or the static server starts.
const initialBuild = spawnSync('npm', ['run', 'build'], {
  cwd: rootDir,
  stdio: 'inherit',
});
if (initialBuild.error) {
  console.error(`dev: failed to start the initial build: ${initialBuild.error.message}`);
  process.exit(1);
}
if (initialBuild.status !== 0) {
  process.exit(initialBuild.status ?? 1);
}

// Watch mode does not rebuild the service worker; editing sw/ during
// `npm run dev` needs a manual `npm run build`.
const commands = [
  {
    label: 'TypeScript watcher',
    command: process.execPath,
    args: [join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'), '--watch'],
  },
  {
    label: 'template watcher',
    command: process.execPath,
    args: [join(rootDir, 'scripts', 'build-templates.mjs'), '--watch'],
  },
];
if (mode === 'dev') {
  commands.push({
    label: 'static server',
    command: 'npx',
    args: ['--yes', 'serve', 'public', '-l', '3000'],
  });
}

const children = commands.map(({ label, command, args }) => ({
  label,
  process: spawn(command, args, { cwd: rootDir, stdio: 'inherit' }),
}));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.process.kill(signal);
}

function fail(message, exitCode = 1) {
  if (shuttingDown) return;
  console.error(message);
  process.exitCode = exitCode;
  shutdown('SIGTERM');
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const child of children) {
  child.process.once('error', error => {
    fail(`dev: failed to start ${child.label}: ${error.message} — stopping the other processes`);
  });
  child.process.once('exit', (code, signal) => {
    fail(
      `dev: ${child.label} exited unexpectedly (code=${code}, signal=${signal}) — stopping the other processes`,
      code && code > 0 ? code : 1,
    );
  });
}
