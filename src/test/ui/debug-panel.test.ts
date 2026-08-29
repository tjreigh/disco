// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import { GamePhase, type GameState } from '../../game/state.js';
import { DebugPanel } from '../../ui/debug/debug-panel.js';

function gameState(phase = GamePhase.Menu): GameState {
  return {
    generationSeed: 1,
    generationSource: 'seeded',
    phase,
    board: [[null]],
    currentDisc: makeDisc(1, DiscKind.Numbered),
    nextDisc: makeDisc(1, DiscKind.Numbered),
    cursorCol: 0,
    score: 0,
    dropCount: 0,
    level: 1,
    turnsPerLevel: 10,
    turnsRemaining: 10,
    breaksThisLevel: 0,
    entropy: 0,
    balancedLevels: 0,
  };
}

describe('DebugPanel game controls', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  test('shows force game over only in the gated full debugger and closes before invoking it', () => {
    const state = gameState();
    const panel = new DebugPanel(state, 'full');
    const onForceGameOver = vi.fn();
    panel.onForceGameOver = onForceGameOver;
    panel.canForceGameOver = () => state.phase === GamePhase.WaitingForDrop;

    panel.open();
    let force = document.querySelector<HTMLButtonElement>('.debug-action--danger')!;
    expect(force.textContent).toBe('FORCE GAME OVER');
    expect(force.disabled).toBe(true);

    state.phase = GamePhase.WaitingForDrop;
    panel.open();
    force = document.querySelector<HTMLButtonElement>('.debug-action--danger')!;
    expect(force.disabled).toBe(false);
    force.click();

    expect(onForceGameOver).toHaveBeenCalledOnce();
    expect(panel.root.classList).not.toContain('debug-panel--open');
  });

  test('does not expose game controls in report-only access', () => {
    const panel = new DebugPanel(gameState(), 'report');
    panel.open();

    expect(document.querySelector('.debug-actions')).toBeNull();
    expect(document.body.textContent).toContain('Issue report');
  });
});
