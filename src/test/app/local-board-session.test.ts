// @vitest-environment happy-dom

import { describe, expect, test, vi } from 'vitest';
import { LocalBoardSession } from '../../app/local-board-session.js';
import { CLASSIC_RULES, GRAVITY_RULES } from '../../game/modes/index.js';
import { GamePhase } from '../../game/state.js';

function drain(session: LocalBoardSession, maxFrames = 30): void {
  let now = 0;
  for (let i = 0; i < maxFrames; i++) {
    now += 1_000;
    session.tick(now);
  }
}

describe('LocalBoardSession', () => {
  test('holds the stable engine state while visual playback catches up', () => {
    const onTurn = vi.fn();
    const onStepComplete = vi.fn();
    const onPlaybackComplete = vi.fn();
    const session = new LocalBoardSession({
      rules: CLASSIC_RULES,
      seed: 1,
      events: { onTurn, onStepComplete, onPlaybackComplete },
    });

    const result = session.drop(3);

    expect(result.accepted).toBe(true);
    expect(session.state.phase).toBe(GamePhase.Animating);
    expect(session.state.dropCount).toBe(1);
    expect(session.view.visualBoard.flat().every(cell => cell === null)).toBe(true);
    expect(onTurn).toHaveBeenCalledWith(result);
    expect(onPlaybackComplete).not.toHaveBeenCalled();

    drain(session);

    expect(session.state.phase).toBe(GamePhase.WaitingForDrop);
    expect(session.view.visualBoard).toEqual(session.state.board);
    expect(session.view.displayedScore).toBe(session.state.score);
    expect(onStepComplete).toHaveBeenCalled();
    expect(onPlaybackComplete).toHaveBeenCalledOnce();
  });

  test('reconfigures in place and derives input capabilities from board state', () => {
    const session = new LocalBoardSession({ rules: CLASSIC_RULES, seed: 1 });
    const stableStateReference = session.state;

    session.configure(GRAVITY_RULES, 1);

    expect(session.state).toBe(stableStateReference);
    expect(session.view.rules).toBe(GRAVITY_RULES);
    expect(session.view.axis).toBe('col');
    expect(session.view.laneCount).toBe(7);
    expect(session.stageDrop(3)).toBeUndefined();
    expect(session.state.phase).toBe(GamePhase.Aiming);
    expect(session.view.needsTilt).toBe(true);

    session.tilt(45);

    expect(session.view.needsTilt).toBe(false);
    expect(session.view.canConfirmTilt).toBe(true);
  });

  test('round-trips run metadata through the session save boundary', () => {
    const source = new LocalBoardSession({ rules: CLASSIC_RULES, seed: 1 });
    source.drop(3);
    drain(source);
    source.setLongestStreak(4);
    const save = source.exportSave();

    const restored = new LocalBoardSession({ rules: GRAVITY_RULES, seed: 2 });
    restored.loadSave(save, CLASSIC_RULES);

    expect(restored.view.rules).toBe(CLASSIC_RULES);
    expect(restored.state.dropCount).toBe(1);
    expect(restored.view.longestStreak).toBe(4);
    expect(restored.view.visualBoard).toEqual(restored.state.board);
  });
});
