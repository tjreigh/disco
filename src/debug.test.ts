import { describe, expect, it } from 'vitest';
import { buildDebugReport } from './debug.js';
import { TurnResult } from './engine.js';
import { DiscKind, GamePhase, GameState } from './types.js';

describe('buildDebugReport', () => {
  it('exports a stable snapshot with notes and labeled flags', () => {
    const state: GameState = {
      phase: GamePhase.WaitingForDrop,
      board: [[{ id: 1, value: 2, kind: DiscKind.Numbered }]],
      currentDisc: { id: 2, value: 3, kind: DiscKind.Numbered },
      nextDisc: { id: 3, value: 4, kind: DiscKind.Numbered },
      cursorCol: 0,
      score: 10,
      dropCount: 2,
      level: 1,
    };

    const firstTurn: TurnResult = {
      accepted: false,
      reason: 'invalid-column',
      boardBefore: [[null]],
      steps: [],
      scoreAwarded: 0,
      gameOver: false,
      trace: { scans: [], frames: [] },
    };
    const secondTurn: TurnResult = {
      accepted: false,
      reason: 'full-column',
      boardBefore: [[{ id: 1, value: 2, kind: DiscKind.Numbered }]],
      steps: [],
      scoreAwarded: 0,
      gameOver: true,
      trace: { scans: [], frames: [] },
    };
    const history = [firstTurn, secondTurn];

    const report = buildDebugReport(
      state,
      history,
      '  This tile should clear.  ',
      new Map([['committed-board.cell.0.0', 'committed-board r1c1 #1']]),
      '2026-07-02T12:00:00.000Z',
    );

    state.board[0]![0]!.value = 6;
    secondTurn.boardBefore[0]![0]!.value = 5;
    history.length = 0;
    expect(report).toMatchObject({
      schemaVersion: 2,
      exportedAt: '2026-07-02T12:00:00.000Z',
      note: 'This tile should clear.',
      flags: [{ target: 'committed-board.cell.0.0', label: 'committed-board r1c1 #1' }],
      turnHistory: [
        { reason: 'invalid-column' },
        { reason: 'full-column' },
      ],
      lastTurn: { reason: 'full-column' },
    });
    expect(report.gameState.board[0]![0]!.value).toBe(2);
    expect(report.turnHistory[1]!.boardBefore[0]![0]!.value).toBe(2);
  });
});
