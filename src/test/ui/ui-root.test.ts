// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { UiRoot } from '../../ui/ui-root.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('UiRoot', () => {
  it('creates explicit stage, controls, overlay, and utility mounts', () => {
    const container = document.createElement('div');
    document.body.append(container);

    const ui = new UiRoot(container);

    expect(container.firstElementChild).toBe(ui.root);
    expect(ui.mounts.stage.classList).toContain('game-stage');
    expect(ui.mounts.stage.contains(ui.canvas)).toBe(true);
    expect(ui.mounts.controls.classList).toContain('shell-region--bottom');
    expect(ui.mounts.overlays.dataset.uiLayer).toBe('overlays');
    expect(ui.mounts.utilities.dataset.uiLayer).toBe('utilities');
    expect(ui.mounts.modalBackground).toHaveLength(2);
  });
});
