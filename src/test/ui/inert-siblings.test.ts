// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest';
import { applyInert } from '../../ui/inert-siblings.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('applyInert', () => {
  test('marks siblings of root inert, but not root itself', () => {
    const root = document.createElement('section');
    const sibling = document.createElement('main');
    document.body.append(sibling, root);

    applyInert(root);

    expect(sibling.inert).toBe(true);
    expect(root.inert).toBe(false);
  });

  test('also marks explicit extraTargets inert, even outside the parent', () => {
    const container = document.createElement('div');
    const root = document.createElement('section');
    container.append(root);
    const outsideTarget = document.createElement('aside');
    document.body.append(container, outsideTarget);

    applyInert(root, [outsideTarget]);

    expect(outsideTarget.inert).toBe(true);
  });

  test('skip excludes a matching sibling from being marked inert', () => {
    const root = document.createElement('section');
    const excluded = document.createElement('footer');
    excluded.dataset.uiAboveHome = 'true';
    const included = document.createElement('main');
    document.body.append(excluded, included, root);

    applyInert(root, [], element => element.dataset.uiAboveHome === 'true');

    expect(excluded.inert).toBe(false);
    expect(included.inert).toBe(true);
  });

  test('release restores each element to its prior inert value, not unconditionally false', () => {
    const root = document.createElement('section');
    const alreadyInert = document.createElement('main');
    alreadyInert.inert = true;
    const notInert = document.createElement('aside');
    document.body.append(alreadyInert, notInert, root);

    const guard = applyInert(root);
    expect(alreadyInert.inert).toBe(true);
    expect(notInert.inert).toBe(true);

    guard();
    expect(alreadyInert.inert).toBe(true);
    expect(notInert.inert).toBe(false);
  });

  test('a target listed in both extraTargets and siblings is only tracked once', () => {
    const root = document.createElement('section');
    const shared = document.createElement('main');
    document.body.append(shared, root);

    const guard = applyInert(root, [shared]);
    expect(shared.inert).toBe(true);
    guard();
    expect(shared.inert).toBe(false);
  });
});
