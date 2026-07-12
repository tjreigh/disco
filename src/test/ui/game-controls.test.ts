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

  test('gravity aiming exposes tilt controls and keeps row-aware labels', () => {
    render({ phase: GamePhase.Aiming, hasGravity: true, axis: 'row' });

    expect(document.querySelector<HTMLButtonElement>('[data-control="previous"]')!.getAttribute('aria-label')).toBe('Move to previous row');
    document.querySelector<HTMLButtonElement>('[data-control="tilt-counter-clockwise"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-control="tilt-clockwise"]')!.click();

    expect(intents).toEqual([
      { kind: 'tilt', delta: -45 },
      { kind: 'tilt', delta: 45 },
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

  test('needsTilt pulses the tilt buttons with the attention class; a committable tilt clears it', () => {
    render({ phase: GamePhase.Aiming, hasGravity: true, needsTilt: true, canConfirmTilt: false });
    const ccw = document.querySelector<HTMLButtonElement>('[data-control="tilt-counter-clockwise"]')!;
    const cw = document.querySelector<HTMLButtonElement>('[data-control="tilt-clockwise"]')!;
    expect(ccw.classList.contains('game-control--attention')).toBe(true);
    expect(cw.classList.contains('game-control--attention')).toBe(true);

    render({ phase: GamePhase.Aiming, hasGravity: true, needsTilt: false, canConfirmTilt: true });
    expect(ccw.classList.contains('game-control--attention')).toBe(false);
    expect(cw.classList.contains('game-control--attention')).toBe(false);
    expect(document.querySelector('[data-control="confirm"]')!.classList.contains('game-control--ready')).toBe(true);
  });

  test('confirm-ready attention appears only for a committable gravity aim', () => {
    const confirm = document.querySelector<HTMLButtonElement>('[data-control="confirm"]')!;

    render({ phase: GamePhase.Aiming, hasGravity: true, needsTilt: true, canConfirmTilt: false });
    expect(confirm.classList.contains('game-control--ready')).toBe(false);

    render({ phase: GamePhase.Aiming, hasGravity: true, needsTilt: false, canConfirmTilt: true, disabled: true });
    expect(confirm.classList.contains('game-control--ready')).toBe(false);

    render({ phase: GamePhase.Aiming, hasGravity: false, canConfirmTilt: true });
    expect(confirm.classList.contains('game-control--ready')).toBe(false);

    render({ phase: GamePhase.WaitingForDrop, hasGravity: true, canConfirmTilt: true });
    expect(confirm.classList.contains('game-control--ready')).toBe(false);
  });

  test('attention is suppressed while disabled', () => {
    render({ phase: GamePhase.Aiming, hasGravity: true, needsTilt: true, disabled: true });
    expect(document.querySelector('[data-control="tilt-clockwise"]')!.classList.contains('game-control--attention')).toBe(false);
  });

  test('defensive guard: needsTilt outside a gravity Aiming phase decorates nothing', () => {
    render({ needsTilt: true }); // classic WaitingForDrop
    expect(document.querySelector('[data-control="tilt-clockwise"]')!.classList.contains('game-control--attention')).toBe(false);

    render({ phase: GamePhase.Aiming, hasGravity: false, needsTilt: true });
    expect(document.querySelector('[data-control="tilt-clockwise"]')!.classList.contains('game-control--attention')).toBe(false);
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
