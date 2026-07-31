// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cloneTemplate, mustQuery } from '../../ui/dom-utils.js';

describe('prefersReducedMotion', () => {
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalMatchMedia) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    } else {
      Reflect.deleteProperty(window, 'matchMedia');
    }
    vi.restoreAllMocks();
  });

  test('returns false when matchMedia is unavailable', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { prefersReducedMotion } = await import('../../ui/dom-utils.js');

    expect(prefersReducedMotion()).toBe(false);
  });

  test('returns true when the reduced-motion media query matches', async () => {
    const matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: matchMedia,
    });
    const { prefersReducedMotion } = await import('../../ui/dom-utils.js');

    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });
});

describe('cloneTemplate', () => {
  afterEach(() => document.head.querySelectorAll('template').forEach(node => node.remove()));

  test('clones the content of a <template> found by id', () => {
    const template = document.createElement('template');
    template.id = 'tpl-example';
    template.innerHTML = '<div class="example"><span>hi</span></div>';
    document.head.append(template);

    const fragment = cloneTemplate('tpl-example');

    expect(fragment.querySelector('.example')?.textContent).toBe('hi');
  });

  test('returns an independent fragment on each call', () => {
    const template = document.createElement('template');
    template.id = 'tpl-independent';
    template.innerHTML = '<p></p>';
    document.head.append(template);

    const first = cloneTemplate('tpl-independent');
    const second = cloneTemplate('tpl-independent');
    first.querySelector('p')!.textContent = 'first';

    expect(second.querySelector('p')!.textContent).toBe('');
  });

  test('throws when no element with the id exists', () => {
    expect(() => cloneTemplate('tpl-missing')).toThrow(/no <template id="tpl-missing">/);
  });

  test('throws when the id belongs to a non-template element', () => {
    const div = document.createElement('div');
    div.id = 'tpl-not-a-template';
    document.body.append(div);

    expect(() => cloneTemplate('tpl-not-a-template')).toThrow(/no <template id="tpl-not-a-template">/);

    div.remove();
  });
});

describe('mustQuery', () => {
  test('returns the matched element', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span class="target"></span>';

    expect(mustQuery(root, '.target')).toBeInstanceOf(HTMLSpanElement);
  });

  test('throws with the selector when nothing matches', () => {
    const root = document.createElement('div');

    expect(() => mustQuery(root, '.missing')).toThrow(/no element matching ".missing"/);
  });
});
