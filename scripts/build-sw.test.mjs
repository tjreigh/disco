import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  buildPrecacheManifest,
  buildServiceWorker,
  injectServiceWorker,
  isPrecachable,
} from './build-sw.mjs';

let workDir;
let publicDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'build-sw-test-'));
  publicDir = join(workDir, 'public');
  mkdirSync(publicDir, { recursive: true });
});

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// A stand-in for the compiled public/service-worker.js: it only has to
// reference both tokens somewhere.
const SW_SOURCE = [
  'const PRECACHE = __DISCO_PRECACHE_MANIFEST__;',
  "const CACHE_NAME = 'disco-precache-' + __DISCO_SW_VERSION__;",
  'globalThis.__sw = { PRECACHE, CACHE_NAME };',
].join('\n');

function writeSw(content = SW_SOURCE) {
  const swPath = join(publicDir, 'service-worker.js');
  writeFileSync(swPath, content);
  return swPath;
}

function writeAsset(relPath, content) {
  const full = join(publicDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe('isPrecachable', () => {
  test('excludes the worker itself, source maps, and _headers', () => {
    assert.equal(isPrecachable('service-worker.js'), false);
    assert.equal(isPrecachable('dist/main.js.map'), false);
    assert.equal(isPrecachable('service-worker.js.map'), false);
    assert.equal(isPrecachable('_headers'), false);
    assert.equal(isPrecachable('index.html'), true);
    assert.equal(isPrecachable('dist/main.js'), true);
    assert.equal(isPrecachable('styles/base.css'), true);
  });
});

describe('buildPrecacheManifest', () => {
  test('lists every precachable file as a root-relative url with a 16-hex revision, sorted', () => {
    writeSw();
    writeAsset('index.html', '<!doctype html>');
    writeAsset('manifest.webmanifest', '{}');
    writeAsset('dist/main.js', 'console.log(1);');
    writeAsset('styles/base.css', 'body{}');

    const { manifest } = buildPrecacheManifest({ publicDir });

    assert.deepEqual(
      manifest.map(entry => entry.url),
      ['/dist/main.js', '/index.html', '/manifest.webmanifest', '/styles/base.css'],
    );
    for (const entry of manifest) {
      assert.match(entry.revision, /^[0-9a-f]{16}$/);
    }
  });

  test('excludes service-worker.js, *.map, and _headers from the manifest', () => {
    writeSw();
    writeAsset('index.html', 'a');
    writeAsset('dist/main.js', 'b');
    writeAsset('dist/main.js.map', '{"version":3}');
    writeAsset('_headers', '/service-worker.js\n  Cache-Control: no-cache');

    const urls = buildPrecacheManifest({ publicDir }).manifest.map(entry => entry.url);

    assert.deepEqual(urls, ['/dist/main.js', '/index.html']);
  });

  test('a revision changes only when that file changes; version changes when any revision changes', () => {
    writeSw();
    writeAsset('index.html', 'a');
    writeAsset('dist/main.js', 'b');

    const first = buildPrecacheManifest({ publicDir });
    const unchanged = buildPrecacheManifest({ publicDir });
    assert.deepEqual(unchanged, first);

    writeFileSync(join(publicDir, 'dist/main.js'), 'b-changed');
    const changed = buildPrecacheManifest({ publicDir });

    const revOf = (result, url) => result.manifest.find(entry => entry.url === url).revision;
    assert.notEqual(revOf(changed, '/dist/main.js'), revOf(first, '/dist/main.js'));
    assert.equal(revOf(changed, '/index.html'), revOf(first, '/index.html'));
    assert.notEqual(changed.version, first.version);
  });

  test('throws when the build output directory is missing or empty', () => {
    assert.throws(
      () => buildPrecacheManifest({ publicDir: join(workDir, 'nope') }),
      /missing build output directory/,
    );
    // Only the worker present -> nothing precachable.
    writeSw();
    assert.throws(() => buildPrecacheManifest({ publicDir }), /no precachable files found/);
  });
});

describe('injectServiceWorker', () => {
  test('replaces both tokens and leaves no placeholder behind', () => {
    const swPath = writeSw();
    writeAsset('index.html', 'a');
    writeAsset('dist/main.js', 'b');

    const { manifest, version } = buildPrecacheManifest({ publicDir });
    const result = injectServiceWorker({ swPath, manifest, version });

    assert.equal(result.entries, manifest.length);
    assert.equal(result.version, version);

    const out = readFileSync(swPath, 'utf8');
    assert.ok(!out.includes('__DISCO_PRECACHE_MANIFEST__'));
    assert.ok(!out.includes('__DISCO_SW_VERSION__'));

    const match = out.match(/const PRECACHE = (\[.*\]);/);
    assert.ok(match, 'manifest literal should be inlined');
    assert.deepEqual(JSON.parse(match[1]), manifest);
    assert.ok(out.includes(`'disco-precache-' + ${JSON.stringify(version)}`));
  });

  test('throws when the compiled worker file is missing', () => {
    assert.throws(
      () => injectServiceWorker({ swPath: join(publicDir, 'service-worker.js'), manifest: [], version: 'x' }),
      /compiled service worker not found/,
    );
  });

  test('throws when a token is absent from the worker source', () => {
    const swPath = writeSw('const x = 1; // no tokens here');
    assert.throws(
      () => injectServiceWorker({ swPath, manifest: [], version: 'x' }),
      /__DISCO_PRECACHE_MANIFEST__ not present/,
    );
  });
});

describe('buildServiceWorker', () => {
  test('walks public/ and injects in one call', () => {
    const swPath = writeSw();
    writeAsset('index.html', 'a');
    writeAsset('dist/main.js', 'b');
    writeAsset('dist/chunk-a.js', 'c');

    const result = buildServiceWorker({ publicDir, swPath });

    assert.equal(result.entries, 3);
    const out = readFileSync(swPath, 'utf8');
    assert.ok(!out.includes('__DISCO_'));
  });
});
