// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameControls } from '../../ui/game-controls.js';
import { GamePhase } from '../../game/state.js';
import type { InputIntent } from '../../platform/input-handler.js';

describe('GameControls', () => {
  let controls: GameControls;
  let intents: InputIntent[];

  beforeEach(() => {
    document.body.replaceChildren();
    intents = [];
    controls = new GameControls(intent => intents.push(intent));
  });

  afterEach(() => document.body.replaceChildren());

  const render = (overrides: Partial<Parameters<GameControls['render']>[0]> = {}) => {
    controls.render({
      phase: GamePhase.WaitingForDrop,
      hasGravity: false,
      cursorLane: 2,
      laneCount: 7,
      axis: 'col',
      ...overrides,
    });
  };

  test('classic waiting renders lane and drop controls with current cursor intents', () => {
    render();

    document.querySelector<HTMLButtonElement>('[data-control="previous"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-control="drop"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-control="next"]')!.click();

    expect(intents).toEqual([
      { kind: 'move', col: 1 },
      { kind: 'drop', col: 2 },
      { kind: 'move', col: 3 },
    ]);
    expect(controls.root.hidden).toBe(false);
    expect(document.querySelector('[data-control="tilt-counter-clockwise"]')).toHaveProperty('hidden', true);
  });

  test('gravity waiting exposes tilt controls and uses row-aware labels', () => {
    render({ hasGravity: true, axis: 'row' });

    expect(document.querySelector<HTMLButtonElement>('[data-control="previous"]')!.getAttribute('aria-label')).toBe('Move to previous row');
    document.querySelector<HTMLButtonElement>('[data-control="tilt-counter-clockwise"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-control="tilt-clockwise"]')!.click();

    expect(intents).toEqual([
      { kind: 'tilt', delta: -5 },
      { kind: 'tilt', delta: 5 },
    ]);
  });

  test('gravity aiming shows tilt, cancel, and confirm only', () => {
    render({ phase: GamePhase.Aiming, hasGravity: true });

    expect(controls.root.hidden).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-control="previous"]')!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-control="cancel"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-control="confirm"]')!.click();

    expect(intents).toEqual([
      { kind: 'cancel' },
      { kind: 'drop', col: 2 },
    ]);
  });

  test('menu, animation, and game-over phases hide controls', () => {
    for (const phase of [GamePhase.Menu, GamePhase.Animating, GamePhase.GameOver]) {
      render({ phase, hasGravity: true });
      expect(controls.root.hidden).toBe(true);
    }
  });

  test('disabled state prevents control clicks while visible', () => {
    render({ hasGravity: true, disabled: true });

    document.querySelector<HTMLButtonElement>('[data-control="drop"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-control="tilt-clockwise"]')!.click();

    expect(intents).toEqual([]);
    expect(document.querySelector<HTMLButtonElement>('[data-control="drop"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-control="tilt-clockwise"]')!.disabled).toBe(true);
  });

  test('destroy removes the controls root', () => {
    expect(document.body.contains(controls.root)).toBe(true);

    controls.destroy();

    expect(document.body.contains(controls.root)).toBe(false);
  });
});
