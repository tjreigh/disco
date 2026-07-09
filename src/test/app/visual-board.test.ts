import { describe, expect, test } from 'vitest';
import { applyStepToVisualBoard } from '../../app/visual-board.js';
import { CLASSIC_MODE } from '../../game/modes/index.js';
import { GameEngine } from '../../game/engine.js';
import type { TurnResult } from '../../game/engine.js';
import { GamePhase } from '../../game/state.js';
import { deepCloneBoard } from '../../game/board.js';
import { StepKind } from '../../game/events.js';

describe('visual board playback', () => {
  test('replays step logs back to the engine board across several seeded runs', () => {
    const seenKinds = new Set<StepKind>();
    const seeds = [1, 7, 13, 21, 34, 55];

    for (const seed of seeds) {
      const engine = new GameEngine({ mode: CLASSIC_MODE, seed });

      for (let turn = 0; turn < 60 && engine.state.phase !== GamePhase.GameOver; turn++) {
        const startCol = (seed + turn) % CLASSIC_MODE.board.cols;
        let result: TurnResult | null = null;

        for (let offset = 0; offset < CLASSIC_MODE.board.cols; offset++) {
          const col = (startCol + offset) % CLASSIC_MODE.board.cols;
          const attempt = engine.drop(col);
          if (attempt.accepted || attempt.gameOver) {
            result = attempt;
            break;
          }
        }

        if (!result) throw new Error('expected a drop result');
        if (!result.accepted) {
          expect(result.gameOver).toBe(true);
          break;
        }

        const replay = deepCloneBoard(result.boardBefore);
        for (const step of result.steps) {
          seenKinds.add(step.kind);
          applyStepToVisualBoard(replay, step);
        }

        expect(replay).toEqual(engine.state.board);

        if (result.gameOver) break;
      }
    }

    expect(Array.from(seenKinds).sort()).toEqual([
      StepKind.Bonus,
      StepKind.Clear,
      StepKind.Drop,
      StepKind.Fall,
      StepKind.Push,
      StepKind.Reveal,
    ].sort());
  });
});
