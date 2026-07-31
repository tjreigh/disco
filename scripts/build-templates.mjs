// Stitches every <template id="..."> found in src/ui/**/*.template.html into
// index.html's <!-- templates --> marker, producing public/index.html.
// This is the only way the built app's UI classes (via cloneTemplate() in
// src/ui/dom-utils.ts) get their markup — a checkout with a broken template
// file must fail the build loudly rather than ship constructors that throw.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_ID_PATTERN = /<template\b[^>]*\bid="([^"]+)"[^>]*>/g;
const CLONE_TEMPLATE_PATTERN = /\bcloneTemplate\(\s*(['"])([^'"]+)\1\s*\)/g;
const TEMPLATE_FILE_SUFFIX = '.template.html';
const MARKER = '<!-- templates -->';

function walkFiles(dir, matches) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, matches));
    } else if (entry.isFile() && matches(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractTemplateIds(markup, filePath, describe) {
  const ids = [...markup.matchAll(TEMPLATE_ID_PATTERN)].map(match => match[1]);
  if (ids.length === 0) {
    throw new Error(`build-templates: ${describe(filePath)} contains no <template id="..."> blocks`);
  }
  return ids;
}

function extractCloneTemplateIds(source) {
  return [...source.matchAll(CLONE_TEMPLATE_PATTERN)].map(match => match[2]);
}

// Hash only the files that can affect the stitched output. Watch mode polls
// this small input set instead of relying on fs.watch, whose duplicate events
// and platform-specific handle failures made the previous watcher unstable.
export function getTemplateInputSignature({ uiDir, indexHtmlPath }) {
  const hash = createHash('sha256');
  const files = existsSync(uiDir)
    ? walkFiles(uiDir, name => name.endsWith(TEMPLATE_FILE_SUFFIX)).sort()
    : [];

  hash.update(`ui:${existsSync(uiDir)}\0`);
  for (const file of files) {
    hash.update(relative(uiDir, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }

  hash.update(`index:${existsSync(indexHtmlPath)}\0`);
  if (existsSync(indexHtmlPath)) hash.update(readFileSync(indexHtmlPath));
  return hash.digest('hex');
}

// uiDir/indexHtmlPath/outputPath are injected (rather than derived from
// import.meta.url) so the test suite can point this at throwaway fixture
// directories instead of the real repo.
export function buildTemplates({
  uiDir,
  indexHtmlPath,
  outputPath,
  allowEmpty = false,
  validateConsumers = true,
}) {
  const describe = filePath => relative(dirname(uiDir), filePath);

  if (!existsSync(uiDir)) {
    throw new Error(`build-templates: missing directory ${describe(uiDir)}`);
  }

  const files = walkFiles(uiDir, name => name.endsWith(TEMPLATE_FILE_SUFFIX)).sort();

  if (files.length === 0 && !allowEmpty) {
    throw new Error(
      `build-templates: no ${TEMPLATE_FILE_SUFFIX} files found under src/ui — refusing to produce a build ` +
      'where every cloneTemplate() call would throw at runtime. Pass --allow-empty to override.',
    );
  }

  const seenIds = new Map(); // template id -> defining file, for duplicate detection
  const chunks = [];
  for (const file of files) {
    const markup = readFileSync(file, 'utf8');
    const ids = extractTemplateIds(markup, file, describe);
    const componentName = basename(file, TEMPLATE_FILE_SUFFIX);
    const expectedId = `tpl-${componentName}`;
    for (const id of ids) {
      if (id !== expectedId && !id.startsWith(`${expectedId}-`)) {
        throw new Error(
          `build-templates: template id "${id}" in ${describe(file)} must be ` +
          `"${expectedId}" or start with "${expectedId}-"`,
        );
      }
      const existing = seenIds.get(id);
      if (existing) {
        throw new Error(
          `build-templates: duplicate template id "${id}" in ${describe(file)} ` +
          `(already defined in ${describe(existing)})`,
        );
      }
      seenIds.set(id, file);
    }
    chunks.push(markup.trim());
  }

  if (validateConsumers && files.length > 0) {
    const consumerFiles = walkFiles(uiDir, name => name.endsWith('.ts')).sort();
    const consumerIds = new Map();
    for (const file of consumerFiles) {
      const source = readFileSync(file, 'utf8');
      for (const id of extractCloneTemplateIds(source)) {
        const consumers = consumerIds.get(id) ?? [];
        consumers.push(file);
        consumerIds.set(id, consumers);
      }
    }

    const missingIds = [...consumerIds.keys()].filter(id => !seenIds.has(id)).sort();
    if (missingIds.length > 0) {
      throw new Error(
        `build-templates: cloneTemplate() references missing template id(s): ${missingIds.join(', ')}`,
      );
    }

    const unusedIds = [...seenIds.keys()].filter(id => !consumerIds.has(id)).sort();
    if (unusedIds.length > 0) {
      throw new Error(
        `build-templates: template id(s) have no cloneTemplate() consumer: ${unusedIds.join(', ')}`,
      );
    }

    for (const [id, templateFile] of seenIds) {
      const componentName = basename(templateFile, TEMPLATE_FILE_SUFFIX);
      const expectedConsumer = join(dirname(templateFile), `${componentName}.ts`);
      if (!consumerIds.get(id)?.includes(expectedConsumer)) {
        throw new Error(
          `build-templates: template id "${id}" in ${describe(templateFile)} must be consumed by ` +
          `${describe(expectedConsumer)}`,
        );
      }
    }
  }

  if (!existsSync(indexHtmlPath)) {
    throw new Error(`build-templates: missing ${describe(indexHtmlPath)}`);
  }
  const indexHtml = readFileSync(indexHtmlPath, 'utf8');
  const markerCount = indexHtml.split(MARKER).length - 1;
  if (markerCount !== 1) {
    throw new Error(
      `build-templates: expected exactly one "${MARKER}" marker in ${describe(indexHtmlPath)}, found ${markerCount}`,
    );
  }

  const stitched = indexHtml.replace(MARKER, chunks.join('\n'));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, stitched);

  return { files, ids: [...seenIds.keys()] };
}

async function main() {
  const args = process.argv.slice(2);
  const allowEmpty = args.includes('--allow-empty');
  const watchMode = args.includes('--watch');

  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const uiDir = join(rootDir, 'src', 'ui');
  const indexHtmlPath = join(rootDir, 'index.html');
  const outputPath = join(rootDir, 'public', 'index.html');

  const runOnce = () => {
    try {
      const { files, ids } = buildTemplates({ uiDir, indexHtmlPath, outputPath, allowEmpty });
      console.log(`build-templates: stitched ${ids.length} template(s) from ${files.length} file(s) into public/index.html`);
      return true;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      return false;
    }
  };

  let lastInputSignature;
  const rebuildChangedInputs = force => {
    let signature;
    try {
      signature = getTemplateInputSignature({ uiDir, indexHtmlPath });
    } catch (error) {
      console.error(
        `build-templates: could not inspect template inputs: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return false;
    }
    if (!force && signature === lastInputSignature) return true;
    lastInputSignature = signature;
    return runOnce();
  };

  const ok = rebuildChangedInputs(true);
  if (!watchMode && !ok) {
    process.exitCode = 1;
    return;
  }

  if (watchMode) {
    setInterval(() => rebuildChangedInputs(false), 250);
    console.log(`build-templates: watching src/ui/**/*${TEMPLATE_FILE_SUFFIX} and index.html for changes...`);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
