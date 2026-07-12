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
      phase: GamePhase.WaitingForDrop, score: 12345,
      currentDisc: disc(3, DiscKind.Numbered), nextDisc: disc(4, DiscKind.DoubleCracked),
      level: 2, initialTurnsPerLevel: 30, turnsPerLevel: 20, turnsRemaining: 17, hasGravity: false,
    });

    expect(hud.root.parentElement).toBe(document.body);
    expect(hud.root.querySelector('.game-hud__top')).toBeTruthy();
    expect(hud.root.querySelector('.game-hud__bottom')).toBeTruthy();
    expect(hud.root.textContent).toContain('12,345');
    expect(hud.root.textContent).toContain('Level 2');
    expect(hud.root.textContent).toContain('Turn 17 / 20');
    expect(hud.root.querySelectorAll('.game-hud__pip--remaining')).toHaveLength(17);
    expect(hud.root.querySelectorAll('.game-hud__pip')).toHaveLength(30);
    expect(hud.root.querySelectorAll('.game-hud__pip--placeholder')).toHaveLength(10);
    expect(hud.root.querySelector('[data-value="3"]')).toBeTruthy();
    expect(hud.root.querySelector('[data-kind="double-cracked"]')).toBeTruthy();
    expect(hud.root.querySelector('[data-kind="double-cracked"]')!.textContent).toBe('');
    expect(hud.root.querySelector('[data-kind="double-cracked"]')!.querySelectorAll('.game-hud__disc-crack')).toHaveLength(2);
    expect(hud.root.textContent).toContain('Choose a column and drop');
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

  test('updates Gravity aiming status and hides in Menu', () => {
    const hud = new GameHud();
    hud.render({
      phase: GamePhase.Aiming, score: 0, currentDisc: disc(1), nextDisc: disc(2),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30, hasGravity: true, gravityAngle: 90,
    });
    expect(hud.root.hidden).toBe(false);
    expect(hud.root.textContent).toContain('Gravity right');
    expect(hud.root.textContent).toContain('Adjust gravity');
    hud.render({
      phase: GamePhase.Menu, score: 0, currentDisc: disc(1), nextDisc: disc(2),
      level: 1, initialTurnsPerLevel: 30, turnsPerLevel: 30, turnsRemaining: 30, hasGravity: false,
    });
    expect(hud.root.hidden).toBe(true);
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
});
