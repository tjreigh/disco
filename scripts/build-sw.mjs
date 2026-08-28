// Fills in the compiled service worker's two build-time placeholders:
//
//   __DISCO_PRECACHE_MANIFEST__  ->  [{ url, revision }, ...] for every asset
//                                    under public/
//   __DISCO_SW_VERSION__         ->  a hash of all those revisions, so the
//                                    worker's bytes change when any asset does
//
// Runs last in the build, once public/ is fully populated. Exits non-zero on a
// missing file or an un-replaced token.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRECACHE_TOKEN = '__DISCO_PRECACHE_MANIFEST__';
const VERSION_TOKEN = '__DISCO_SW_VERSION__';
const SERVICE_WORKER_FILENAME = 'service-worker.js';

function walkFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .DS_Store and friends
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export function isPrecachable(relPathPosix) {
  if (relPathPosix === SERVICE_WORKER_FILENAME) return false; // the worker itself
  if (relPathPosix.endsWith('.map')) return false; // source maps
  if (relPathPosix === '_headers') return false; // Cloudflare Pages control file
  return true;
}

export function buildPrecacheManifest({ publicDir }) {
  if (!existsSync(publicDir)) {
    throw new Error(`build-sw: missing build output directory ${publicDir}`);
  }

  const files = walkFiles(publicDir)
    .map(abs => ({ abs, rel: relative(publicDir, abs).split(sep).join('/') }))
    .filter(file => isPrecachable(file.rel))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  if (files.length === 0) {
    throw new Error(
      `build-sw: no precachable files found under ${publicDir} — the build output looks empty`,
    );
  }

  const manifest = files.map(file => ({
    url: `/${file.rel}`,
    revision: createHash('sha256').update(readFileSync(file.abs)).digest('hex').slice(0, 16),
  }));

  const version = createHash('sha256')
    .update(manifest.map(entry => `${entry.url}@${entry.revision}`).join('\n'))
    .digest('hex')
    .slice(0, 16);

  return { manifest, version };
}

export function injectServiceWorker({ swPath, manifest, version }) {
  if (!existsSync(swPath)) {
    throw new Error(
      `build-sw: compiled service worker not found at ${swPath} — did "tsc -p tsconfig.sw.json" run?`,
    );
  }

  const source = readFileSync(swPath, 'utf8');
  for (const token of [PRECACHE_TOKEN, VERSION_TOKEN]) {
    if (!source.includes(token)) {
      throw new Error(`build-sw: ${token} not present in ${swPath}`);
    }
  }

  const injected = source
    .replaceAll(PRECACHE_TOKEN, JSON.stringify(manifest))
    .replaceAll(VERSION_TOKEN, JSON.stringify(version));

  writeFileSync(swPath, injected);
  return { entries: manifest.length, version };
}

export function buildServiceWorker({ publicDir, swPath }) {
  const { manifest, version } = buildPrecacheManifest({ publicDir });
  return injectServiceWorker({ swPath, manifest, version });
}

async function main() {
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const publicDir = join(rootDir, 'public');
  const swPath = join(publicDir, SERVICE_WORKER_FILENAME);

  try {
    const { entries, version } = buildServiceWorker({ publicDir, swPath });
    console.log(`build-sw: precaching ${entries} file(s), version ${version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
