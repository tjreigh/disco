// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest';

// setup-ui-templates.ts runs once per happy-dom test file (registered via
// vitest.config.ts's setupFiles) and installs every real
// src/ui/**/*.template.html
// source into document.head before this file's own tests run.
describe('setup-ui-templates', () => {
  test('installs at least one real template into document.head', () => {
    const templates = document.head.querySelectorAll('template');

    expect(templates.length).toBeGreaterThan(0);
  });

  test('every installed template has a unique, non-empty id', () => {
    const templates = [...document.head.querySelectorAll('template')];
    const ids = templates.map(template => template.id);

    expect(ids.every(id => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the ui-root template is present with the expected shape', () => {
    const template = document.getElementById('tpl-ui-root');

    expect(template).toBeInstanceOf(HTMLTemplateElement);
    expect((template as HTMLTemplateElement).content.querySelector('.app-root')).not.toBeNull();
  });

  test('installed templates are marked test-installed', () => {
    const templates = [...document.head.querySelectorAll('template')];

    expect(templates.every(template => template.dataset.testInstalled === 'true')).toBe(true);
  });
});
