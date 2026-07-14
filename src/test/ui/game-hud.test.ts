// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import { GameHud } from '../../ui/game-hud.js';
import { GamePhase } from '../../game/state.js';
import { DiscKind } from '../../game/model.js';

const disc = (value: number, kind = DiscKind.Numbered) => ({ id: value, value, kind });

describe('GameHud', () => {
  beforeEach(() => document.body.replaceChildren());

  test('falls back to body and renders score, turns, level, queue, and hint', () => {
    const hud = new GameHud();
    expect(hud.root.hidden).toBe(true);

    hud.render({
      phase: GamePhase.WaitingForDrop, score: 12345, highScore: 15000, bestRecord: 4,
      currentDisc: disc(3, DiscKind.Numbered), nextDisc: disc(4, DiscKind.DoubleCracked),
      level: 2, initialTurnsPerLevel: 30, turnsPerLevel: 20, turnsRemaining: 17, hasGravity: false,
    });

    expect(hud.root.parentElement).toBe(document.body);
    expect(hud.root.querySelector('.game-hud__top')).toBeTruthy();
    expect(hud.root.querySelector('.game-hud__bottom')).toBeTruthy();
    expect(hud.root.textContent).toContain('12,345');
    expect(hud.root.querySelector('.game-hud__records')?.textContent)
      .toBe('High 15,000 · Best chain 4 waves');
    expect(hud.root.textContent).toContain('Level 2');
    expect(hud.root.textContent).toContain('Turn 17 / 20');
    expect(hud.root.querySelectorAll('.game-hud__pip--remaining')).toHaveLength(17);
    expect(hud.root.querySelectorAll('.game-hud__pip')).toHaveLength(30);
    expect(hud.root.querySelectorAll('.game-hud__pip--placeholder')).toHaveLength(10);
    expect(hud.root.querySelector('[data-value="3"]')).toBeTruthy();
    expect(hud.root.querySelector('[data-kind="double-cracked"]')).toBeTruthy();
    expect(hud.root.querySelector('[data-kind="double-cracked"]')!.textContent).toBe('');
    expect(hud.root.querySelector('[data-kind="double-cracked"]')!.querySelectorAll('.game-hud__disc-crack')).toHaveLength(2);
    const controls = Array.from(hud.root.querySelectorAll('.game-hud__hint-action'));
    expect(controls.map((control) => control.getAttribute('aria-label'))).toEqual([
      '← →: Move', '↓ / Click: Drop', 'R: New game',
    ]);
  });

  test('renders cracked queue discs with board-style crack marks', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.WaitingForDrop, score: 0,
      currentDisc: disc(3, DiscKind.SingleCracked), nextDisc: disc(4, DiscKind.DoubleCracked),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30, hasGravity: false,
    });

    const singleCracked = hud.root.querySelector('[data-kind="single-cracked"]')!;
    const doubleCracked = hud.root.querySelector('[data-kind="double-cracked"]')!;
    expect(singleCracked.textContent).toBe('');
    expect(singleCracked.querySelectorAll('.game-hud__disc-crack')).toHaveLength(1);
    expect(doubleCracked.textContent).toBe('');
    expect(doubleCracked.querySelectorAll('.game-hud__disc-crack')).toHaveLength(2);
  });

  test('shows Paradox records and instability, and marks its critical tier', () => {
    const hud = new GameHud();
    const base = {
      phase: GamePhase.WaitingForDrop, score: 0, highScore: 900, bestRecord: 1,
      currentDisc: disc(3), nextDisc: disc(4),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30,
      hasGravity: false, hasRewind: true, criticalInstability: 5,
    };
    hud.render({ ...base, instability: 4 });
    const indicator = hud.root.querySelector<HTMLElement>('.game-hud__instability')!;
    expect(hud.root.dataset.rewindMode).toBe('true');
    expect(hud.root.querySelector('.game-hud__records')?.textContent)
      .toBe('High 900 · Best chain 1 wave');
    expect(indicator.textContent).toBe('INSTABILITY 4');
    expect(indicator.classList).not.toContain('game-hud__instability--critical');
    expect(hud.root.querySelector('.game-hud__hint')?.classList).toContain('game-hud__hint--controls');
    expect(Array.from(hud.root.querySelectorAll('.game-hud__hint-action'))
      .map((control) => control.getAttribute('aria-label'))).toContain('Z: Rewind');

    hud.render({ ...base, instability: 5 });
    expect(indicator.classList).toContain('game-hud__instability--critical');
  });

  test('marks rewind inspection so the ordinary bottom HUD can be replaced by the tray', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.WaitingForDrop, score: 0,
      currentDisc: disc(3), nextDisc: disc(4),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 29,
      hasGravity: false, hasRewind: true, isRewindPreview: true,
    });
    expect(hud.root.dataset.rewindPreview).toBe('true');
  });

  test('keeps unchanged turn and queue DOM stable across animation frames', () => {
    const hud = new GameHud();
    const state = {
      phase: GamePhase.WaitingForDrop, score: 10,
      currentDisc: disc(2), nextDisc: disc(5),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 28,
      hasGravity: false,
    };
    hud.render(state);
    const pips = hud.root.querySelector('.game-hud__pips')!;
    const firstPip = pips.firstElementChild;
    const currentDisc = hud.root.querySelector('.game-hud__disc-slot .game-hud__disc');

    hud.render({ ...state, score: 11 });

    expect(hud.root.querySelector('.game-hud__pips')).toBe(pips);
    expect(pips.firstElementChild).toBe(firstPip);
    expect(hud.root.querySelector('.game-hud__disc-slot .game-hud__disc')).toBe(currentDisc);
  });

  test('shows Gravity records alongside aiming status and hides in Menu', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.Aiming, score: 0, highScore: 4500, bestRecord: 3,
      currentDisc: disc(1), nextDisc: disc(2),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30, hasGravity: true,
      gravityAngle: 90, gravityTurnStartAngle: 90, gravityMaxTiltDelta: 45,
    });
    expect(hud.root.hidden).toBe(false);
    expect(hud.root.querySelector('.game-hud__gravity')).toHaveProperty('hidden', false);
    expect(hud.root.querySelector('.game-hud__records')?.textContent)
      .toBe('High 4,500 · Best chain 3 waves');
    expect(hud.root.textContent).toContain('Gravity right');
    expect(hud.root.querySelector('.game-hud__gravity-dial')).toBeTruthy();
    // Arrow tip should point right (gx≈1, gy≈0) at a 90deg angle.
    const arrow = hud.root.querySelector('.game-hud__gravity-dial line')!;
    expect(Number(arrow.getAttribute('x2'))).toBeGreaterThan(Number(arrow.getAttribute('x1')));
    // Tilt-range arc is drawn while Aiming.
    expect(hud.root.querySelector('.game-hud__gravity-dial path')).toHaveProperty('style.display', '');
    expect(Array.from(hud.root.querySelectorAll('.game-hud__hint-action'))
      .map((control) => control.getAttribute('aria-label'))).toEqual([
      'Q / E: Tilt', '↓ / Enter: Confirm', 'Esc: Cancel',
    ]);
    hud.render({
      phase: GamePhase.Menu, score: 0, currentDisc: disc(1), nextDisc: disc(2),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30, hasGravity: false,
    });
    expect(hud.root.hidden).toBe(true);
  });

  test('hides the tilt-range arc outside Aiming', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.WaitingForDrop, score: 0, currentDisc: disc(1), nextDisc: disc(2),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30,
      hasGravity: true, gravityAngle: 0,
    });
    expect(hud.root.querySelector('.game-hud__gravity-dial path')).toHaveProperty('style.display', 'none');
  });

  test('touch users are told about the real on-screen tilt buttons, not a keyboard', () => {
    const originalMaxTouchPoints = navigator.maxTouchPoints;
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    try {
      const hud = new GameHud();
      hud.render({
        phase: GamePhase.Aiming, score: 0, currentDisc: disc(1), nextDisc: disc(2),
        level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30,
        hasGravity: true, gravityAngle: 0, gravityTurnStartAngle: 0, gravityMaxTiltDelta: 45,
      });
      expect(hud.root.textContent).toContain('Tap ↺/↻ to tilt, CONFIRM to drop');
      expect(hud.root.textContent).not.toContain('keyboard needed');
    } finally {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: originalMaxTouchPoints, configurable: true });
    }
  });

  test('needsTilt during gravity Aiming: hint attention + "Tilt required" copy, compass ring attention', () => {
    const hud = new GameHud();
    const base = {
      phase: GamePhase.Aiming, score: 0, currentDisc: disc(1), nextDisc: disc(2),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30,
      hasGravity: true, gravityAngle: 0, gravityTurnStartAngle: 0, gravityMaxTiltDelta: 90,
    };
    hud.render({ ...base, needsTilt: true });

    // The attention ring exists on its own class (never selected by circle order).
    expect(hud.root.querySelector('.game-hud__gravity-attention-ring')).toBeTruthy();
    expect(hud.root.querySelector('.game-hud__gravity')!.classList.contains('game-hud__gravity--attention')).toBe(true);
    const hint = hud.root.querySelector('.game-hud__hint')!;
    expect(hint.classList.contains('game-hud__hint--attention')).toBe(true);
    expect(hint.textContent).toBe('Tilt required — Q/E to tilt, then ↓/Enter');

    // A committable tilt moves the cue to confirmation readiness.
    hud.render({ ...base, gravityAngle: 45, needsTilt: false, canConfirmTilt: true });
    expect(hud.root.querySelector('.game-hud__gravity')!.classList.contains('game-hud__gravity--attention')).toBe(false);
    expect(hint.classList.contains('game-hud__hint--attention')).toBe(false);
    expect(hint.classList.contains('game-hud__hint--ready')).toBe(true);
    expect(hint.textContent).toBe('Rotation set — ↓ / Enter to confirm');

    // Returning to the starting angle restores the owed-tilt state.
    hud.render({ ...base, gravityAngle: 0, needsTilt: true, canConfirmTilt: false });
    expect(hint.classList.contains('game-hud__hint--attention')).toBe(true);
    expect(hint.classList.contains('game-hud__hint--ready')).toBe(false);
    expect(hint.textContent).toBe('Tilt required — Q/E to tilt, then ↓/Enter');
  });

  test('touch keeps its tap copy even while a tilt is owed — the buttons pulse there instead', () => {
    const originalMaxTouchPoints = navigator.maxTouchPoints;
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    try {
      const hud = new GameHud();
      hud.render({
        phase: GamePhase.Aiming, score: 0, currentDisc: disc(1), nextDisc: disc(2),
        level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30,
        hasGravity: true, gravityAngle: 0, gravityTurnStartAngle: 0, gravityMaxTiltDelta: 90,
        needsTilt: true,
      });
      expect(hud.root.textContent).toContain('Tap ↺/↻ to tilt, CONFIRM to drop');
      // The class-based cues still apply on touch.
      expect(hud.root.querySelector('.game-hud__hint')!.classList.contains('game-hud__hint--attention')).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: originalMaxTouchPoints, configurable: true });
    }
  });

  test('touch uses explicit confirmation-ready copy after a committable tilt', () => {
    const originalMaxTouchPoints = navigator.maxTouchPoints;
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    try {
      const hud = new GameHud();
      hud.render({
        phase: GamePhase.Aiming, score: 0, currentDisc: disc(1), nextDisc: disc(2),
        level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30,
        hasGravity: true, gravityAngle: 45, gravityTurnStartAngle: 0, gravityMaxTiltDelta: 90,
        needsTilt: false, canConfirmTilt: true,
      });
      const hint = hud.root.querySelector('.game-hud__hint')!;
      expect(hint.textContent).toBe('Rotation set — tap CONFIRM');
      expect(hint.classList.contains('game-hud__hint--ready')).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: originalMaxTouchPoints, configurable: true });
    }
  });

  test('defensive guard: needsTilt outside a gravity Aiming phase applies no attention', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.WaitingForDrop, score: 0, currentDisc: disc(1), nextDisc: disc(2),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30,
      hasGravity: false, needsTilt: true,
    });
    expect(hud.root.querySelector('.game-hud__gravity')!.classList.contains('game-hud__gravity--attention')).toBe(false);
    expect(hud.root.querySelector('.game-hud__hint')!.classList.contains('game-hud__hint--attention')).toBe(false);
  });

  test('shows Stack records and explains the last turn total', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.Animating, score: 810, highScore: 1200, bestRecord: 12,
      currentDisc: disc(3), nextDisc: disc(4),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 29,
      hasGravity: false, isStackMode: true, currentStack: 9,
      lastStackScore: { initial: 3, chains: [{ level: 2, cleared: 2 }], stack: 5, points: 250 },
    });

    expect(hud.root.dataset.stackMode).toBe('true');
    expect(hud.root.querySelector('.game-hud__records')?.textContent)
      .toBe('High 1,200 · Best turn 12 cleared');
    expect(hud.root.querySelector('.game-hud__stack-receipt-total')?.textContent)
      .toBe('Last turn: 5 total cleared · +250');
    expect(hud.root.querySelector('.game-hud__stack-receipt-breakdown')?.textContent)
      .toBe('2 clear waves · 3 + 2');

    hud.render({
      phase: GamePhase.WaitingForDrop, score: 810, highScore: 1200, bestRecord: 4,
      currentDisc: disc(3), nextDisc: disc(4),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 29,
      hasGravity: false,
    });
    expect(hud.root.dataset.stackMode).toBe('false');
    expect(hud.root.querySelector('.game-hud__records')?.textContent)
      .toBe('High 1,200 · Best chain 4 waves');
    expect(hud.root.querySelector<HTMLElement>('.game-hud__stack-receipt')?.hidden).toBe(true);
  });

  test('shows the live combined clear total while a Stack cascade is resolving', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.Animating, score: 90, highScore: 810, bestRecord: 9,
      currentDisc: disc(3), nextDisc: disc(4),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 29,
      hasGravity: false, isStackMode: true, currentStack: 5, stackCascadeActive: true,
      lastStackScore: { initial: 3, chains: [], stack: 3, points: 90 },
    });

    expect(hud.root.querySelector('.game-hud__stack-receipt-total')?.textContent)
      .toBe('This turn: 5 cleared so far');
    expect(hud.root.querySelector('.game-hud__stack-receipt-breakdown')?.textContent)
      .toBe('Clear waves combine into one total');
  });

  test('uses the initial turn budget as the pip spacing scale on later levels', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.WaitingForDrop, score: 0,
      currentDisc: disc(5), nextDisc: disc(6), level: 1,
      initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30, hasGravity: false,
    });
    const levelOnePips = hud.root.querySelectorAll('.game-hud__pip');
    expect(levelOnePips).toHaveLength(30);
    expect(hud.root.querySelectorAll('.game-hud__pip--placeholder')).toHaveLength(0);

    hud.render({
      phase: GamePhase.WaitingForDrop, score: 0,
      currentDisc: disc(5), nextDisc: disc(6), level: 3,
      initialTurnsPerLevel: 30, turnsPerLevel: 12, turnsRemaining: 7, hasGravity: false,
    });
    expect(hud.root.querySelectorAll('.game-hud__pip')).toHaveLength(30);
    expect(hud.root.querySelectorAll('.game-hud__pip--remaining')).toHaveLength(7);
    expect(hud.root.querySelectorAll('.game-hud__pip--placeholder')).toHaveLength(18);
    expect(hud.root.querySelector('.game-hud__pips')!.lastElementChild?.classList.contains('game-hud__pip--placeholder')).toBe(true);
  });

  test('places a shorter mode budget in the leftmost slots of the shared pip capacity', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.WaitingForDrop, score: 0,
      currentDisc: disc(5), nextDisc: disc(6), level: 1,
      initialTurnsPerLevel: 22, turnsPerLevel: 22, turnsRemaining: 13,
      turnPipCapacity: 30, hasGravity: false, isStackMode: true,
    });

    const pips = hud.root.querySelector<HTMLElement>('.game-hud__pips')!;
    expect(pips.style.gridTemplateColumns).toBe('repeat(30, minmax(0, 1fr))');
    expect(pips.children).toHaveLength(22);
    expect(hud.root.querySelectorAll('.game-hud__pip--remaining')).toHaveLength(13);
    expect(hud.root.querySelectorAll('.game-hud__pip--placeholder')).toHaveLength(0);
  });
});
