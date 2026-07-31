/// <reference types="vite/client" />

// Every converted UI class clones its static markup out of a
// <template id="tpl-..."> that the real build stitches into
// public/index.html from src/ui/**/*.template.html (see
// scripts/build-templates.mjs).
// The Happy DOM unit tests construct UI classes directly and never load
// index.html, so this setup module installs the same real template sources
// into document.head before any test runs — tests exercise the actual
// markup, not a hand-copied fixture that could drift from it.

const templateModules = import.meta.glob('../ui/**/*.template.html', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function installTemplates(): void {
  if (typeof document === 'undefined') return; // node-environment test files never touch the DOM

  const paths = Object.keys(templateModules).sort();
  if (paths.length === 0) {
    throw new Error(
      'setup-ui-templates: found no .template.html files under src/ui — ' +
      'every cloneTemplate() call in a test would fail',
    );
  }

  const seenIds = new Set<string>();
  for (const path of paths) {
    const markup = templateModules[path]!;
    const container = document.createElement('div');
    container.innerHTML = markup;
    const templates = container.querySelectorAll('template');
    if (templates.length === 0) {
      throw new Error(`setup-ui-templates: ${path} contains no <template> elements`);
    }
    for (const template of templates) {
      if (!template.id) {
        throw new Error(`setup-ui-templates: a <template> in ${path} has no id`);
      }
      if (seenIds.has(template.id)) {
        throw new Error(`setup-ui-templates: duplicate template id "${template.id}" (source: ${path})`);
      }
      seenIds.add(template.id);
      template.dataset.testInstalled = 'true';
      // Tests clear document.body between cases, so templates live in <head>.
      document.head.append(template);
    }
  }
}

installTemplates();
