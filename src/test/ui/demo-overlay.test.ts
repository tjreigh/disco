// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import { DemoOverlay } from '../../ui/demo-overlay.js';

describe('DemoOverlay', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/?demo=1&campaign=embed#preview');
  });

  test('opens the full game without the demo flag and preserves unrelated URL state', () => {
    const overlay = new DemoOverlay();

    expect(overlay.element.target).toBe('_blank');
    expect(overlay.element.rel).toBe('noopener noreferrer');
    expect(new URL(overlay.element.href).searchParams.has('demo')).toBe(false);
    expect(new URL(overlay.element.href).searchParams.get('campaign')).toBe('embed');
    expect(new URL(overlay.element.href).hash).toBe('#preview');
    expect(overlay.element.textContent).toBe('play disco ↗');
  });
});
