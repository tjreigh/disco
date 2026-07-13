import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../game/engine.js';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import { GamePhase } from '../../game/state.js';
import { StepKind } from '../../game/events.js';
import type { GameModeConfig } from '../../game/modes/mode.js';
import { CLASSIC_MODE, GRAVITY_MODE, STACK_MODE } from '../../game/modes/index.js';
import { doubleCrackedFactory } from '../helpers.js';

function numberedFactory(...values: number[]): () => ReturnType<typeof makeDisc> {
  let index = 0;
  return () => makeDisc(values[index++ % values.length]!, DiscKind.Numbered);
}

describe('GameEngine', () => {
  test('an explicit seed reproduces the built-in playable sequence', () => {
    const startingBoard = makeEmptyBoard();
    placeDisc(startingBoard, 6, 6, makeDisc(7, DiscKind.DoubleCracked));
    const first = new GameEngine({ seed: 0x12345678, board: startingBoard });
    const second = new GameEngine({ seed: 0x12345678, board: startingBoard });
    const signature = (engine: GameEngine) => ({
      current: { value: engine.state.currentDisc.value, kind: engine.state.currentDisc.kind },
      next: { value: engine.state.nextDisc.value, kind: engine.state.nextDisc.kind },
    });

    expect(first.state.generationSeed).toBe(0x12345678);
    expect(signature(first)).toEqual(signature(second));
    for (let turn = 0; turn < 20; turn++) {
      expect(signature(first)).toEqual(signature(second));
      expect(first.drop(turn % 7).steps.map(step => step.kind)).toEqual(
        second.drop(turn % 7).steps.map(step => step.kind),
      );
    }
  });

  test('uses an injected starting board when prefilling the built-in queue', () => {
    const highBoard = makeEmptyBoard();
    for (let row = 1; row < highBoard.length; row++) {
      placeDisc(highBoard, row, 6, makeDisc(7, DiscKind.DoubleCracked));
    }

    const empty = new GameEngine({ seed: 1 });
    const high = new GameEngine({ seed: 1, board: highBoard });
    const values = (engine: GameEngine) => [engine.state.currentDisc.value, engine.state.nextDisc.value];

    expect(values(empty)).toEqual([6, 7]);
    expect(values(high)).toEqual([5, 6]);
  });

  test('rejected drops do not advance built-in generation', () => {
    const startingBoard = makeEmptyBoard();
    for (let row = 0; row < startingBoard.length; row++) {
      placeDisc(startingBoard, row, 0, makeDisc(7, DiscKind.DoubleCracked));
    }
    const uninterrupted = new GameEngine({ seed: 0xabcdef01, board: startingBoard });
    const withRejections = new GameEngine({ seed: 0xabcdef01, board: startingBoard });
    const signature = (engine: GameEngine) => [
      engine.state.currentDisc.value,
      engine.state.currentDisc.kind,
      engine.state.nextDisc.value,
      engine.state.nextDisc.kind,
    ];

    expect(withRejections.drop(-1)).toMatchObject({ accepted: false, reason: 'invalid-column' });
    expect(withRejections.drop(0)).toMatchObject({ accepted: false, reason: 'full-column' });
    expect(signature(withRejections)).toEqual(signature(uninterrupted));

    for (const col of [1, 2, 3, 4]) {
      expect(withRejections.drop(col).accepted).toBe(true);
      expect(uninterrupted.drop(col).accepted).toBe(true);
      expect(signature(withRejections)).toEqual(signature(uninterrupted));
    }
  });

  test('plays a complete turn without browser dependencies', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(7, 6, 5, 4) });

    const result = engine.drop(3);

    expect(result.accepted).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: StepKind.Drop, landPos: { row: 6, col: 3 } });
    expect(result.boardBefore[6]![3]).toBeNull();
    expect(engine.state.board[6]![3]).toMatchObject({ value: 7, kind: DiscKind.Numbered });
    expect(engine.state.currentDisc.value).toBe(6);
    expect(engine.state.nextDisc.value).toBe(5);
    expect(engine.state.dropCount).toBe(1);
    expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
  });

  test('integrates clears and scoring into the turn result', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 6, 0, makeDisc(5, DiscKind.Numbered));
    placeDisc(board, 6, 1, makeDisc(4, DiscKind.Numbered));
    const engine = new GameEngine({ board, discFactory: numberedFactory(3, 7, 7, 7) });

    const result = engine.drop(2);

    expect(result.scoreAwarded).toBe(7);
    expect(engine.state.score).toBe(7);
    expect(result.steps).toContainEqual(expect.objectContaining({
      kind: StepKind.Clear,
      pointsAwarded: 7,
    }));
    expect(result.trace.scans[0]?.checks).toContainEqual(expect.objectContaining({
      value: 3,
      rowCount: 3,
      clearsByRow: true,
    }));
    expect(result.trace.frames.map(frame => frame.label)).toEqual([
      expect.stringMatching(/^Drop /),
      expect.stringMatching(/^Clear /),
    ]);
  });

  test('awards 70,000 points when a clear empties the board', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(1, 7, 7, 7) });

    const result = engine.drop(3);

    expect(result.scoreAwarded).toBe(70_007);
    expect(engine.state.score).toBe(70_007);
    expect(result.steps).toContainEqual({
      kind: StepKind.Bonus,
      bonusKind: 'board-clear',
      pointsAwarded: 70_000,
    });
  });

  test('a push occurs when the level\'s turn budget is exhausted', () => {
    const oneTurnMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'one-turn-test-mode',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    const engine = new GameEngine({
      mode: oneTurnMode,
      discFactory: numberedFactory(7, 6, 5, 4),
      crackedDiscFactory: () => makeDisc(2, DiscKind.DoubleCracked),
    });
    const previewedNext = engine.state.nextDisc;

    const result = engine.drop(0);
    const push = result.steps.find(step => step.kind === StepKind.Push);

    expect(push?.kind).toBe(StepKind.Push);
    if (push?.kind === StepKind.Push) {
      expect(push.edge).toBe('bottom');
      expect(push.newDiscs).toHaveLength(7);
      expect(push.newDiscs.every(d => d.value === 2 && d.kind === DiscKind.DoubleCracked)).toBe(true);
    }
    expect(engine.state.board[6]!.every(Boolean)).toBe(true);
    expect(engine.state.level).toBe(2);
    expect(engine.state.currentDisc).toBe(previewedNext);
    expect(result.scoreAwarded).toBe(7_000);
    expect(result.steps).toContainEqual({
      kind: StepKind.Bonus,
      bonusKind: 'level',
      pointsAwarded: 7_000,
    });
  });

  test('resolves a match created by a push during the same turn', () => {
    const board = makeEmptyBoard();
    // This 2 sits at the bottom row (contiguous column count 1) before the
    // turn. The push shifts it up to row 5 and inserts a fully-filled cracked
    // row at row 6 directly below it, raising its column count to 2 and
    // making it eligible.
    placeDisc(board, 6, 2, makeDisc(2, DiscKind.Numbered));
    const oneTurnMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'one-turn-test-mode-2',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    const engine = new GameEngine({
      board,
      mode: oneTurnMode,
      discFactory: numberedFactory(7, 6, 5, 4),
      crackedDiscFactory: () => makeDisc(7, DiscKind.DoubleCracked),
    });

    const result = engine.drop(0);
    const pushIndex = result.steps.findIndex(step => step.kind === StepKind.Push);
    const clearIndex = result.steps.findIndex((step, index) =>
      index > pushIndex && step.kind === StepKind.Clear
    );

    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(pushIndex);
    expect(result.steps[clearIndex]).toMatchObject({
      kind: StepKind.Clear,
      cleared: [{ row: 5, col: 2 }],
    });
    expect(result.scoreAwarded).toBe(7_007);
    expect(engine.state.score).toBe(7_007);
    expect(engine.state.board[5]![2]).toBeNull();
  });

  test('rejects invalid columns without changing turn state', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(7, 6, 5) });

    const result = engine.drop(7);

    expect(result).toMatchObject({ accepted: false, reason: 'invalid-column', gameOver: false });
    expect(engine.state.dropCount).toBe(0);
    expect(engine.state.board).toEqual(makeEmptyBoard());
  });

  test('a drop into a full column is rejected without ending the game or consuming the disc', () => {
    const board = makeEmptyBoard();
    for (let row = 0; row < 7; row++) {
      placeDisc(board, row, 1, makeDisc(7, DiscKind.DoubleCracked));
    }
    const engine = new GameEngine({ board, discFactory: numberedFactory(4, 5, 6) });
    const currentId = engine.state.currentDisc.id;

    const result = engine.drop(1);

    expect(result).toMatchObject({ accepted: false, reason: 'full-column', gameOver: false });
    expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
    expect(engine.state.currentDisc.id).toBe(currentId);
    expect(engine.state.dropCount).toBe(0);
  });

  test('a disc resting in the top row through normal stacking does not end the game', () => {
    const board = makeEmptyBoard();
    // Fill rows 1-6 of column 2 with non-matching cracked discs so nothing clears
    // once the drop lands at row 0 (cracked discs never clear directly).
    for (let row = 1; row < 7; row++) {
      placeDisc(board, row, 2, makeDisc(9, DiscKind.DoubleCracked));
    }
    // value 3 matches neither the row-0 run (1) nor the column run (7) after landing.
    const engine = new GameEngine({ board, discFactory: numberedFactory(3, 4, 5) });

    const result = engine.drop(2);

    expect(result.accepted).toBe(true);
    expect(result.gameOver).toBe(false);
    expect(engine.state.phase).not.toBe(GamePhase.GameOver);
    expect(engine.state.board[0]![2]).not.toBeNull();
  });

  test('restart resets all gameplay state and refills the queue', () => {
    const engine = new GameEngine({ discFactory: numberedFactory(7, 6, 5, 4, 3, 2, 1) });
    engine.drop(0);

    engine.restart();

    expect(engine.state).toMatchObject({
      phase: GamePhase.WaitingForDrop,
      score: 0,
      dropCount: 0,
      level: 1,
      turnsPerLevel: 30,
      turnsRemaining: 30,
      cursorCol: 3,
    });
    expect(engine.state.board).toEqual(makeEmptyBoard());
    expect(engine.state.currentDisc.value).toBe(3);
    expect(engine.state.nextDisc.value).toBe(2);
  });

  test('a non-default mode drives board size, cursor start, and push cadence', () => {
    const smallMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'small-test-mode',
      board: { cols: 3, rows: 3 },
      initialTurnsPerLevel: 2,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    const engine = new GameEngine({ mode: smallMode, discFactory: numberedFactory(1, 1, 1, 1) });

    expect(engine.state.board.length).toBe(3);
    expect(engine.state.board[0]!.length).toBe(3);
    expect(engine.state.cursorCol).toBe(1); // floor(3 / 2)

    engine.drop(0);
    const result = engine.drop(1);
    const push = result.steps.find(step => step.kind === StepKind.Push);
    expect(push?.kind).toBe(StepKind.Push);
    if (push?.kind === StepKind.Push) expect(push.newDiscs).toHaveLength(3);
  });

  test('turn budget exhaustion advances the level and resets the budget without wiping board/score', () => {
    const smallBudgetMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'small-budget-test-mode',
      initialTurnsPerLevel: 2,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    // value 7 never matches a run length of 1, so these drops don't clear.
    const engine = new GameEngine({ mode: smallBudgetMode, discFactory: numberedFactory(7, 7, 7, 7) });

    expect(engine.state.level).toBe(1);
    expect(engine.state.turnsPerLevel).toBe(2);
    expect(engine.state.turnsRemaining).toBe(2);

    engine.drop(0);
    expect(engine.state.level).toBe(1);
    expect(engine.state.turnsRemaining).toBe(1);

    engine.drop(1);

    expect(engine.state.level).toBe(2);
    expect(engine.state.turnsPerLevel).toBe(1); // turnsForLevel(mode, 2) = max(1, 2 - 1)
    expect(engine.state.turnsRemaining).toBe(1);
    expect(engine.state.score).toBe(7_000);
    expect(engine.state.board[6]![0]).not.toBeNull();
    expect(engine.state.board[6]![1]).not.toBeNull();
  });

  test('a clear caused by the level-end push continues the turn chain', () => {
    const oneTurnMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'level-boundary-chain-mode',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 0,
      minTurnsPerLevel: 1,
    };
    const board = makeEmptyBoard();
    // The dropped 1 clears immediately. The isolated 2 survives that scan,
    // then the pushed cracked row makes its column two discs tall.
    placeDisc(board, 6, 6, makeDisc(2, DiscKind.Numbered));
    const engine = new GameEngine({ mode: oneTurnMode });
    engine.loadScriptedState({
      mode: oneTurnMode,
      board,
      currentDisc: makeDisc(1, DiscKind.Numbered),
      nextDisc: makeDisc(7, DiscKind.Numbered),
      turnsRemaining: 1,
      crackedDiscFactory: doubleCrackedFactory(),
    });

    const result = engine.drop(1);
    const clears = result.steps.filter(step => step.kind === StepKind.Clear);

    expect(clears.map(clear => clear.chainLevel)).toEqual([0, 1]);
    expect(clears.map(clear => clear.pointsAwarded)).toEqual([7, 39]);
    expect(result.scoreAwarded).toBe(7_046); // both clears + level bonus
  });

  test('Stack includes a chain continued by the level-end push in its total', () => {
    const oneTurnStackMode: GameModeConfig = {
      ...STACK_MODE,
      id: 'stack-level-boundary-chain-mode',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 0,
      minTurnsPerLevel: 1,
    };
    const board = makeEmptyBoard();
    placeDisc(board, 6, 6, makeDisc(2, DiscKind.Numbered));
    const engine = new GameEngine({ mode: oneTurnStackMode });
    engine.loadScriptedState({
      mode: oneTurnStackMode,
      board,
      currentDisc: makeDisc(1, DiscKind.Numbered),
      nextDisc: makeDisc(7, DiscKind.Numbered),
      turnsRemaining: 1,
      crackedDiscFactory: doubleCrackedFactory(),
    });

    const result = engine.drop(1);
    const clears = result.steps.filter(step => step.kind === StepKind.Clear);
    const stackBonus = result.steps.find(
      step => step.kind === StepKind.Bonus && step.bonusKind === 'stack',
    );

    expect(clears.map(clear => clear.chainLevel)).toEqual([0, 1]);
    expect(result.stackSize).toBe(2);
    expect(stackBonus).toMatchObject({ pointsAwarded: 40 });
    expect(result.scoreAwarded).toBe(7_040); // stack award + level bonus
  });

  test('Stack scores a level-end push that initiates the turn\'s first clear', () => {
    const oneTurnStackMode: GameModeConfig = {
      ...STACK_MODE,
      id: 'stack-push-initiated-clear-mode',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 0,
      minTurnsPerLevel: 1,
    };
    const board = makeEmptyBoard();
    placeDisc(board, 6, 6, makeDisc(2, DiscKind.Numbered));
    const engine = new GameEngine({ mode: oneTurnStackMode });
    engine.loadScriptedState({
      mode: oneTurnStackMode,
      board,
      // This 7 does not clear. The level push makes the isolated 2's column
      // two discs tall, producing the first and only clear of the turn.
      currentDisc: makeDisc(7, DiscKind.Numbered),
      nextDisc: makeDisc(7, DiscKind.Numbered),
      turnsRemaining: 1,
      crackedDiscFactory: doubleCrackedFactory(),
    });

    const result = engine.drop(1);
    const clears = result.steps.filter(step => step.kind === StepKind.Clear);
    const stackBonus = result.steps.find(
      step => step.kind === StepKind.Bonus && step.bonusKind === 'stack',
    );

    expect(clears.map(clear => clear.chainLevel)).toEqual([0]);
    expect(result.stackSize).toBe(1);
    expect(stackBonus).toMatchObject({ pointsAwarded: 10 });
    expect(result.scoreAwarded).toBe(7_010);
  });

  test('a rejected full-column drop leaves the level and turn budget unchanged', () => {
    const board = makeEmptyBoard();
    for (let row = 0; row < 7; row++) {
      placeDisc(board, row, 1, makeDisc(7, DiscKind.DoubleCracked));
    }
    const smallBudgetMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'small-budget-game-over-test-mode',
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 1,
      minTurnsPerLevel: 1,
    };
    const engine = new GameEngine({ mode: smallBudgetMode, board, discFactory: numberedFactory(4, 5, 6) });

    const result = engine.drop(1);

    expect(result).toMatchObject({ accepted: false, reason: 'full-column', gameOver: false });
    expect(engine.state.level).toBe(1);
    expect(engine.state.turnsRemaining).toBe(1);
  });

  test.each([
    ['Classic', CLASSIC_MODE],
    ['Stack', STACK_MODE],
  ])('%s does not resolve or score clears caused after a terminal push overflow', (_name, baseMode) => {
    const oneTurnMode: GameModeConfig = {
      ...baseMode,
      id: `${baseMode.id}-terminal-push-score-mode`,
      initialTurnsPerLevel: 1,
      turnsPerLevelStep: 0,
      minTurnsPerLevel: 1,
    };
    const board = makeEmptyBoard();
    // The top-edge disc makes the upcoming push fatal. If resolution wrongly
    // continues afterward, the isolated 2 becomes two cells tall against the
    // pushed cracked row and awards points despite game over.
    placeDisc(board, 0, 0, makeDisc(7, DiscKind.DoubleCracked));
    placeDisc(board, 6, 6, makeDisc(2, DiscKind.Numbered));
    const engine = new GameEngine({ mode: oneTurnMode });
    engine.loadScriptedState({
      mode: oneTurnMode,
      board,
      currentDisc: makeDisc(7, DiscKind.Numbered),
      nextDisc: makeDisc(7, DiscKind.Numbered),
      score: 123,
      turnsRemaining: 1,
      crackedDiscFactory: doubleCrackedFactory(),
    });

    const result = engine.drop(1);

    expect(result.gameOver).toBe(true);
    expect(result.steps.some(step => step.kind === StepKind.Push)).toBe(true);
    expect(result.steps.some(step => step.kind === StepKind.Clear)).toBe(false);
    expect(result.steps.some(step => step.kind === StepKind.Bonus)).toBe(false);
    expect(result.scoreAwarded).toBe(0);
    expect(engine.state.score).toBe(123);
  });

  test('reconfigure() switches modes without replacing the state object', () => {
    const engine = new GameEngine({ mode: CLASSIC_MODE });
    const stateRef = engine.state;

    const smallMode: GameModeConfig = { ...CLASSIC_MODE, id: 'small-test-mode', board: { cols: 3, rows: 3 } };
    engine.reconfigure(smallMode);

    expect(engine.state).toBe(stateRef); // same object reference, mutated in place
    expect(engine.state.board.length).toBe(3);
    expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
  });

  // ─── Full-board soft-lock (bug #2) ───────────────────────────────────────
  // A fully-occupied board can never change again on its own: every column
  // rejects a drop, so no turn is ever consumed and no push ever fires. That
  // makes it terminal even when no push has overflowed row 0.

  describe('full-board terminal state', () => {
    // A huge turn budget keeps a push from ever interfering — the test wants
    // to prove the full-board check alone ends the game, not a push overflow.
    // DoubleCracked discs never clear on their own, so filling the board
    // column by column never triggers a clear/reveal either.
    const noPushMode: GameModeConfig = {
      ...CLASSIC_MODE,
      id: 'full-board-test-mode',
      initialTurnsPerLevel: 999,
      turnsPerLevelStep: 0,
      minTurnsPerLevel: 999,
    };

    test('filling all 49 cells ends the game on the filling drop, without a push', () => {
      const engine = new GameEngine({ mode: noPushMode, discFactory: doubleCrackedFactory() });

      let lastResult: ReturnType<GameEngine['drop']> | undefined;
      for (let col = 0; col < 7; col++) {
        for (let row = 0; row < 7; row++) {
          lastResult = engine.drop(col);
        }
      }

      expect(lastResult).toMatchObject({ accepted: true, gameOver: true });
      expect(lastResult!.steps.some(step => step.kind === StepKind.Push)).toBe(false);
      expect(engine.state.phase).toBe(GamePhase.GameOver);

      const further = engine.drop(0);
      expect(further).toMatchObject({ accepted: false, reason: 'game-over' });
    });

    test('6 full columns plus a partially-filled 7th is not terminal', () => {
      const engine = new GameEngine({ mode: noPushMode, discFactory: doubleCrackedFactory() });

      for (let col = 0; col < 6; col++) {
        for (let row = 0; row < 7; row++) engine.drop(col);
      }
      let lastResult;
      for (let row = 0; row < 6; row++) lastResult = engine.drop(6);

      expect(lastResult!.gameOver).toBe(false);
      expect(engine.state.phase).not.toBe(GamePhase.GameOver);
    });

    test('constructing an engine with an already-full injected board is immediately game over', () => {
      const board = makeEmptyBoard();
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 7; col++) placeDisc(board, row, col, makeDisc(9, DiscKind.DoubleCracked));
      }

      const engine = new GameEngine({ board });

      expect(engine.state.phase).toBe(GamePhase.GameOver);
    });
  });

  // ─── Steps↔frames parity (bug #4's invariant) ────────────────────────────

  describe('steps↔frames parity', () => {
    test('level-bonus turn: every non-Bonus step has exactly one frame', () => {
      const oneTurnMode: GameModeConfig = {
        ...CLASSIC_MODE,
        id: 'parity-level-bonus-mode',
        initialTurnsPerLevel: 1,
        turnsPerLevelStep: 1,
        minTurnsPerLevel: 1,
      };
      const engine = new GameEngine({
        mode: oneTurnMode,
        discFactory: numberedFactory(7, 6, 5, 4),
        crackedDiscFactory: () => makeDisc(2, DiscKind.DoubleCracked),
      });

      const result = engine.drop(0);
      const nonBonusSteps = result.steps.filter(step => step.kind !== StepKind.Bonus);

      expect(result.steps.some(step => step.kind === StepKind.Bonus)).toBe(true);
      expect(nonBonusSteps.length).toBe(result.trace.frames.length);
    });

    // Also exercises the physics-level board-clear bonus (a second Bonus
    // variant distinct from the engine's level bonus above).
    test('board-clearing chain turn (board-clear bonus): every non-Bonus step has exactly one frame', () => {
      const engine = new GameEngine({ discFactory: numberedFactory(1, 7, 7, 7) });

      const result = engine.drop(3);
      const nonBonusSteps = result.steps.filter(step => step.kind !== StepKind.Bonus);

      expect(result.steps.some(step => step.kind === StepKind.Bonus)).toBe(true);
      expect(nonBonusSteps.length).toBe(result.trace.frames.length);
    });

    test('a normal multi-step clear turn without any bonus still has parity', () => {
      const board = makeEmptyBoard();
      placeDisc(board, 6, 0, makeDisc(5, DiscKind.Numbered));
      placeDisc(board, 6, 1, makeDisc(4, DiscKind.Numbered));
      const engine = new GameEngine({ board, discFactory: numberedFactory(3, 7, 7, 7) });

      const result = engine.drop(2);
      const nonBonusSteps = result.steps.filter(step => step.kind !== StepKind.Bonus);

      expect(result.steps.some(step => step.kind === StepKind.Bonus)).toBe(false);
      expect(nonBonusSteps.length).toBe(result.trace.frames.length);
    });
  });

  // ─── generationSource (#9) ────────────────────────────────────────────────

  describe('generationSource', () => {
    test('defaults to seeded when no custom factory is injected', () => {
      const engine = new GameEngine({});
      expect(engine.state.generationSource).toBe('seeded');
    });

    test('is injected when a custom discFactory is provided', () => {
      const engine = new GameEngine({ discFactory: numberedFactory(1) });
      expect(engine.state.generationSource).toBe('injected');
    });

    test('is injected when only a custom crackedDiscFactory is provided', () => {
      const engine = new GameEngine({ crackedDiscFactory: () => makeDisc(1, DiscKind.DoubleCracked) });
      expect(engine.state.generationSource).toBe('injected');
    });

    test('remains injected after restart(), which deliberately keeps custom factories', () => {
      const engine = new GameEngine({ discFactory: numberedFactory(1) });
      engine.restart();
      expect(engine.state.generationSource).toBe('injected');
    });

    test('becomes seeded after reconfigure(), which discards any injected factory', () => {
      const engine = new GameEngine({ discFactory: numberedFactory(1) });
      engine.reconfigure(CLASSIC_MODE);
      expect(engine.state.generationSource).toBe('seeded');
    });
  });

  // ─── moveCursor phase guard (#12) ─────────────────────────────────────────

  test('moveCursor is a no-op once the game is over', () => {
    const board = makeEmptyBoard();
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) placeDisc(board, row, col, makeDisc(9, DiscKind.DoubleCracked));
    }
    const engine = new GameEngine({ board });
    expect(engine.state.phase).toBe(GamePhase.GameOver);
    const before = engine.state.cursorCol;

    engine.moveCursor(before === 6 ? 0 : before + 1);

    expect(engine.state.cursorCol).toBe(before);
  });

  test('loadScriptedState preserves the state object and installs scripted board and queue', () => {
    const engine = new GameEngine({ seed: 1 });
    const stateRef = engine.state;
    const board = makeEmptyBoard();
    const boardDisc = makeDisc(4, DiscKind.Numbered);
    const current = makeDisc(3, DiscKind.Numbered);
    const next = makeDisc(5, DiscKind.Numbered);
    const tail = makeDisc(6, DiscKind.Numbered);
    placeDisc(board, 6, 0, boardDisc);

    engine.loadScriptedState({
      mode: CLASSIC_MODE,
      board,
      currentDisc: current,
      nextDisc: next,
      queuedDiscs: [tail],
      score: 12,
      dropCount: 2,
    });

    expect(engine.state).toBe(stateRef);
    expect(engine.state.generationSource).toBe('injected');
    expect(engine.state.score).toBe(12);
    expect(engine.state.dropCount).toBe(2);
    expect(engine.state.board).not.toBe(board);
    expect(engine.state.board[6]![0]).toEqual(boardDisc);
    expect(engine.state.currentDisc).toEqual(current);
    expect(engine.state.nextDisc).toEqual(next);

    engine.drop(1);

    expect(engine.state.currentDisc).toEqual(next);
    expect(engine.state.nextDisc).toEqual(tail);
  });

  test('resumeSeededGeneration replaces a scripted queue without resetting the board', () => {
    const engine = new GameEngine({ seed: 1 });
    const stateRef = engine.state;
    const board = makeEmptyBoard();
    const boardDisc = makeDisc(4, DiscKind.Numbered);
    const current = makeDisc(3, DiscKind.Numbered);
    const next = makeDisc(3, DiscKind.Numbered);
    placeDisc(board, 6, 0, boardDisc);

    engine.loadScriptedState({
      mode: CLASSIC_MODE,
      board,
      currentDisc: current,
      nextDisc: next,
    });
    const scriptedBoard = engine.state.board;

    engine.resumeSeededGeneration(123);

    expect(engine.state).toBe(stateRef);
    expect(engine.state.board).toBe(scriptedBoard);
    expect(engine.state.board[6]![0]).toEqual(boardDisc);
    expect(engine.state.generationSeed).toBe(123);
    expect(engine.state.generationSource).toBe('seeded');
    expect(engine.state.currentDisc.id).not.toBe(current.id);
    expect(engine.state.nextDisc.id).not.toBe(next.id);
  });

  // ─── Staged-tilt turn loop (Gravity mode) ─────────────────────────────────

  describe.skip('drop-or-tilt turn loop (Gravity mode)', () => {
    test('CLASSIC_MODE engines have no gravity state; tiltGravity/commitTilt are no-ops', () => {
      const engine = new GameEngine({ mode: CLASSIC_MODE });
      expect(engine.state.gravity).toBeUndefined();

      engine.tiltGravity(10);
      expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);

      const result = engine.commitTilt();
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('wrong-phase');
    });

    test('a gravity-config engine starts with gravity state at the initial angle', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE, seed: 1 });
      expect(engine.state.gravity).toEqual({ angle: 0, turnStartAngle: 0, maxTiltDelta: 45 });
    });

    test('drop resolves instantly, entering opposite the current (untouched) angle', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE, discFactory: numberedFactory(7) });

      const result = engine.drop(3);

      expect(result.accepted).toBe(true);
      expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
      expect(engine.state.dropCount).toBe(1);
      // angle stayed at 0 (no tilt happened) -> straight down, like Classic.
      expect(engine.state.board[6]![3]).toMatchObject({ value: 7 });
      expect(result.steps.some(s => s.kind === StepKind.Drop)).toBe(true);
    });

    test('drop rejects while a tilt is in progress (Aiming)', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      engine.tiltGravity(10);
      expect(engine.state.phase).toBe(GamePhase.Aiming);

      const result = engine.drop(3);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('wrong-phase');
    });

    test('drop rejects an out-of-range lane', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      expect(engine.drop(-1).reason).toBe('invalid-column');
      expect(engine.drop(7).reason).toBe('invalid-column');
    });

    test('drop rejects a full lane', () => {
      const board = makeEmptyBoard();
      for (let r = 0; r < 7; r++) placeDisc(board, r, 2, makeDisc(1, DiscKind.Numbered));
      const engine = new GameEngine({ mode: GRAVITY_MODE, board });
      const result = engine.drop(2);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('full-column');
      expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
    });

    test('tiltGravity begins Aiming on its first call and clamps within the allowed range', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);

      engine.tiltGravity(10);
      expect(engine.state.phase).toBe(GamePhase.Aiming);
      expect(engine.state.gravity!.angle).toBe(10);
      expect(engine.state.gravity!.turnStartAngle).toBe(0);

      engine.tiltGravity(1000); // clamps to turnStartAngle(0) + maxTiltDelta(45)
      expect(engine.state.gravity!.angle).toBe(45);

      engine.tiltGravity(-1000); // clamps to turnStartAngle(0) - maxTiltDelta(45)
      expect(engine.state.gravity!.angle).toBe(-45);
    });

    test('previewSettledBoard shows the would-be result without mutating state.board', () => {
      const board = makeEmptyBoard();
      placeDisc(board, 3, 0, makeDisc(2, DiscKind.Numbered));
      const engine = new GameEngine({ mode: GRAVITY_MODE, board });

      engine.tiltGravity(45); // begins Aiming; 45deg = down-right diagonal
      const preview = engine.previewSettledBoard();

      // Ray-march for a single disc at (3,0) at 45deg: (3,0)->(4,1)->(5,2)->(6,3).
      expect(preview[6]![3]).toMatchObject({ value: 2 });
      expect(preview[3]![0]).toBeNull();
      // Nothing is committed until commitTilt — state.board is untouched.
      expect(engine.state.board[3]![0]).toMatchObject({ value: 2 });
      expect(engine.state.board[6]![3]).toBeNull();
    });

    test('previewDropLanding shows the true landing cell without mutating anything', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE, discFactory: numberedFactory(2) });

      engine.tiltGravity(45); // begins Aiming; still previewable — it only reads state.gravity.angle
      const landing = engine.previewDropLanding(0);

      // Entry edge at exactly 45deg is 'left', so lane 0 -> entry (row 0, col
      // 0). Ray-march on an empty board rides the full diagonal to the
      // opposite corner: (0,0)->(1,1)->(2,2)->(3,3)->(4,4)->(5,5)->(6,6).
      expect(landing).toEqual({ row: 6, col: 6 });
      expect(engine.state.board[0]![0]).toBeNull(); // nothing was actually placed
      expect(engine.state.board[6]![6]).toBeNull();
    });

    test('previewDropLanding returns null for a full lane or a non-gravity mode', () => {
      const board = makeEmptyBoard();
      for (let r = 0; r < 7; r++) placeDisc(board, r, 2, makeDisc(1, DiscKind.Numbered));
      const engine = new GameEngine({ mode: GRAVITY_MODE, board });
      expect(engine.previewDropLanding(2)).toBeNull();

      const classicEngine = new GameEngine({ mode: CLASSIC_MODE });
      expect(classicEngine.previewDropLanding(3)).toBeNull();
    });

    test('cancelTilt reverts to the turn-start angle and phase for free (no turn spent)', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      engine.tiltGravity(45);
      expect(engine.state.phase).toBe(GamePhase.Aiming);

      engine.cancelTilt();
      expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
      expect(engine.state.gravity!.angle).toBe(0);
      expect(engine.state.dropCount).toBe(0);
    });

    test('commitTilt rejects outside Aiming', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      const result = engine.commitTilt();
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('wrong-phase');
    });

    test('commitTilt settles the whole board under the tilted angle and costs a turn', () => {
      const board = makeEmptyBoard();
      placeDisc(board, 3, 0, makeDisc(2, DiscKind.Numbered));
      const engine = new GameEngine({ mode: GRAVITY_MODE, board });

      engine.tiltGravity(90); // clamps to turnStartAngle(0) + maxTiltDelta(45) => 45deg
      const result = engine.commitTilt();

      expect(engine.state.gravity!.angle).toBe(45);
      expect(result.accepted).toBe(true);
      expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
      expect(engine.state.dropCount).toBe(1); // costs a turn, same as a drop
      expect(engine.state.board[6]![3]).toMatchObject({ value: 2 });
      expect(result.steps.some(step => step.kind === StepKind.Fall)).toBe(true);
      expect(result.steps.some(step => step.kind === StepKind.Drop)).toBe(false); // no new disc
    });

    // Settling only produces a shape the clear-checker fully recognizes as a
    // line at exactly 8 angles (0/45/90/.../315) — anywhere else the pile
    // comes out kinked even though it visually reads as "a line" to a
    // player. commitTilt snaps the angle itself (not just the clear check)
    // to whichever of those 8 is nearest, and PERSISTS the snapped value —
    // not the raw dragged angle — so every subsequent read of
    // state.gravity.angle (drops, previews, the next tilt's turnStartAngle)
    // stays on that same 8-shape lattice.
    test('commitTilt snaps the raw dragged angle to the nearest of 8 directions and persists the snapped value', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      engine.tiltGravity(20); // raw angle 20deg — nearest of 8 is 0
      expect(engine.state.gravity!.angle).toBe(20); // still raw while Aiming

      const result = engine.commitTilt();
      expect(result.accepted).toBe(true);
      expect(engine.state.gravity!.angle).toBe(0); // snapped and persisted, not 20
    });

    test.each([
      [10, 0], [20, 0], [30, 45], [40, 45], [45, 45],
    ])('commitTilt at raw angle %ideg (clamped to +/-45 from start) persists snapped angle %ideg', (raw, expectedSnapped) => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      engine.tiltGravity(raw);
      engine.commitTilt();
      expect(engine.state.gravity!.angle).toBe(expectedSnapped);
    });

    test('previewSettledBoard shows the SNAPPED result during Aiming, not the raw dragged angle', () => {
      const board = makeEmptyBoard();
      placeDisc(board, 3, 0, makeDisc(2, DiscKind.Numbered));
      const engine = new GameEngine({ mode: GRAVITY_MODE, board });

      engine.tiltGravity(40); // raw 40deg, snaps to 45deg
      const preview = engine.previewSettledBoard();
      const committed = (() => {
        const clone = new GameEngine({ mode: GRAVITY_MODE, board: makeEmptyBoard() });
        placeDisc(clone.state.board, 3, 0, makeDisc(2, DiscKind.Numbered));
        clone.tiltGravity(40);
        clone.commitTilt();
        return clone.state.board;
      })();

      // Same disc must land in the same cell in the preview as it actually
      // does on commit — if the preview used the raw 40deg instead of the
      // snapped 45deg, these would disagree.
      expect(preview[6]![3]).toMatchObject({ value: 2 });
      expect(committed[6]![3]).toMatchObject({ value: 2 });
    });

    // The one rule that must never break, regardless of how the angle gets
    // snapped: every disc still ends up on exactly one cell. Runs many
    // tilt+commit turns at arbitrary raw angles and checks after every
    // single one that no disc id is missing or duplicated.
    test('a long sequence of tilts at arbitrary raw angles never loses or duplicates a disc', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE, discFactory: numberedFactory(1, 2, 3, 4, 5, 6, 7) });
      const rawAngles = [7, 130, 244, 18, 89, 356, 91, 179, 271, 12, 200, 315.4, 44.9, 45.1];
      let dropsSoFar = 0;

      for (const raw of rawAngles) {
        if (engine.state.phase === GamePhase.GameOver) break;
        // Alternate drop and tilt so the board actually has discs on it to move around.
        if (dropsSoFar % 2 === 0) {
          engine.drop(engine.state.cursorCol);
        } else {
          engine.tiltGravity(raw);
          engine.commitTilt();
          expect(engine.state.gravity!.angle % 45).toBe(0); // always snapped after commit
        }
        dropsSoFar++;

        const seen = new Set<number>();
        for (const row of engine.state.board) {
          for (const cell of row) {
            if (!cell) continue;
            expect(seen.has(cell.id)).toBe(false); // no cell shares a disc with another
            seen.add(cell.id);
          }
        }
      }
    });

    // The bug this session started from: "the next level push always comes
    // up from the bottom regardless of gravity setting." A push now enters
    // from the edge the CURRENT tilt's gravity pulls toward, same as a drop
    // does, instead of always the bottom (see computePushStep).
    test('a push during Gravity mode enters from the floor edge matching the current tilt, not always the bottom', () => {
      const twoTurnMode: GameModeConfig = {
        ...GRAVITY_MODE,
        id: 'two-turn-gravity-test-mode',
        initialTurnsPerLevel: 2,
        turnsPerLevelStep: 1,
        minTurnsPerLevel: 1,
      };
      const engine = new GameEngine({
        mode: twoTurnMode,
        discFactory: numberedFactory(7, 6, 5, 4),
        crackedDiscFactory: () => makeDisc(2, DiscKind.DoubleCracked),
      });

      engine.tiltGravity(90); // clamps to +45deg from the 0deg start
      engine.commitTilt(); // turn 1 of 2 — persists the snapped 45deg angle (entry edge 'left')

      const result = engine.drop(0); // turn 2 of 2 — exhausts the budget, triggers a push
      const push = result.steps.find(step => step.kind === StepKind.Push);

      expect(push?.kind).toBe(StepKind.Push);
      if (push?.kind === StepKind.Push) {
        expect(push.edge).toBe('right'); // opposite of entry edge 'left' — NOT 'bottom'
      }
    });

    test('reconfigure to a gravity mode installs gravity state; reconfigure away clears it', () => {
      const engine = new GameEngine({ mode: CLASSIC_MODE });
      expect(engine.state.gravity).toBeUndefined();

      engine.reconfigure(GRAVITY_MODE);
      expect(engine.state.gravity).toEqual({ angle: 0, turnStartAngle: 0, maxTiltDelta: 45 });

      engine.reconfigure(CLASSIC_MODE);
      expect(engine.state.gravity).toBeUndefined();
    });
  });

  describe('staged forced-tilt turn loop (Gravity mode)', () => {
    function stageAndTilt(engine: GameEngine, lane: number, delta: number) {
      expect(engine.stageGravityDrop(lane)).toBeUndefined();
      engine.tiltGravity(delta);
      return engine.commitTilt();
    }

    test('staging is free and requires a tilt before commit', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      expect(engine.stageGravityDrop(3)).toBeUndefined();
      expect(engine.state.phase).toBe(GamePhase.Aiming);
      expect(engine.state.gravity?.pendingLane).toBe(3);
      expect(engine.state.dropCount).toBe(0);

      const result = engine.commitTilt();
      expect(result.reason).toBe('tilt-required');
      expect(engine.state.phase).toBe(GamePhase.Aiming);
    });

    test('a staged lane can tilt up to 90 degrees in either direction', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      engine.stageGravityDrop(3);
      engine.tiltGravity(90);
      expect(engine.state.gravity?.angle).toBe(90);
      engine.tiltGravity(-180);
      expect(engine.state.gravity?.angle).toBe(-90);
    });

    test('the staged disc enters from the pre-tilt edge and resolves after the tilt', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE, discFactory: numberedFactory(7) });
      const result = stageAndTilt(engine, 2, 90);
      const drop = result.steps.find(step => step.kind === StepKind.Drop);

      expect(result.accepted).toBe(true);
      expect(engine.state.gravity?.angle).toBe(90);
      expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
      expect(engine.state.dropCount).toBe(1);
      expect(drop).toMatchObject({ kind: StepKind.Drop, entryPos: { row: -1, col: 2 } });
    });

    test('preview includes the staged disc without mutating the live board', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE, discFactory: numberedFactory(7) });
      engine.stageGravityDrop(0);
      engine.tiltGravity(45);
      const preview = engine.previewSettledBoard();

      expect(preview.some(row => row.some(cell => cell?.value === 7))).toBe(true);
      expect(engine.state.board.every(row => row.every(cell => cell == null))).toBe(true);
    });

    test('cancelling restores the starting angle and discards the staged lane', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      engine.stageGravityDrop(3);
      engine.tiltGravity(-45);
      engine.cancelTilt();

      expect(engine.state.phase).toBe(GamePhase.WaitingForDrop);
      expect(engine.state.gravity).toEqual({ angle: 0, turnStartAngle: 0, maxTiltDelta: 90 });
      expect(engine.state.dropCount).toBe(0);
    });

    test('a level push uses the direction committed with the drop', () => {
      const mode: GameModeConfig = {
        ...GRAVITY_MODE,
        id: 'two-turn-gravity-test-mode',
        initialTurnsPerLevel: 2,
        turnsPerLevelStep: 1,
        minTurnsPerLevel: 1,
      };
      const engine = new GameEngine({ mode, discFactory: numberedFactory(7, 6, 5, 4) });

      stageAndTilt(engine, 0, 45);
      const result = stageAndTilt(engine, 0, 45);

      expect(result.steps.find(step => step.kind === StepKind.Push)).toMatchObject({
        kind: StepKind.Push,
        edge: 'right',
      });
    });

    test('an axis-flipping tilt recenters the lane cursor to the middle of the new axis', () => {
      const engine = new GameEngine({ mode: GRAVITY_MODE });
      // cursorCol initially 3 (center of 7 columns); move it away from center
      engine.moveCursor(5);
      expect(engine.state.cursorCol).toBe(5);

      // Tilt 0° → 90°: entry edge flips from 'top' (col axis) to 'left' (row axis).
      // The same numeric index 5 on the row axis would silently land on row 5
      // — already out of range on a different axis. The engine must recenter.
      const result = stageAndTilt(engine, 5, 90);

      expect(result.accepted).toBe(true);
      expect(engine.state.cursorCol).toBe(3); // floor(7 / 2)
    });

    test('a same-axis tilt leaves the cursor where the player staged it', () => {
      // maxTiltDeltaDeg: 180 lets a tilt travel the full 180° without leaving
      // the same entry axis — with the default ±90° every accepted tilt from
      // a cardinal angle already flips to a different axis, so there is no
      // same-axis path to test with the normal mode config.
      const mode180: GameModeConfig = {
        ...GRAVITY_MODE,
        gravity: { initialAngleDeg: 0, maxTiltDeltaDeg: 180 },
      };
      const engine = new GameEngine({ mode: mode180 });
      engine.moveCursor(5);
      expect(engine.state.cursorCol).toBe(5);

      // 0° → 180°: both top/bottom entry (col axis) — no axis flip.
      const result = stageAndTilt(engine, 5, 180);

      expect(result.accepted).toBe(true);
      expect(engine.state.cursorCol).toBe(5);
    });
  });

  describe('save-game integration', () => {
    test('exports metadata explicitly and restores state in place with fresh queue IDs', () => {
      const startingBoard = makeEmptyBoard();
      const sourceBoardDisc = makeDisc(7, DiscKind.DoubleCracked);
      placeDisc(startingBoard, 6, 6, sourceBoardDisc);
      const source = new GameEngine({ seed: 0x12345678, board: startingBoard });
      source.drop(2);
      const save = source.exportSave({
        longestStreak: 4,
        savedAt: 1234,
        appBuild: 'test-build',
      });
      const restored = new GameEngine({ seed: 9 });
      const stateRef = restored.state;
      const sourceCurrentId = source.state.currentDisc.id;

      const validated = restored.loadSave(save, CLASSIC_MODE);

      expect(validated.session.longestStreak).toBe(4);
      expect(save).toMatchObject({ savedAt: 1234, appBuild: 'test-build' });
      expect(restored.state).toBe(stateRef);
      expect(restored.state.phase).toBe(GamePhase.WaitingForDrop);
      expect(restored.state.currentDisc.id).not.toBe(sourceCurrentId);
      expect(restored.state.board[6]![6]?.id).not.toBe(sourceBoardDisc.id);
      expect(restored.state.currentDisc).toBe((restored as unknown as { queue: { peek(): unknown } }).queue.peek());
      expect(restored.state.nextDisc).toBe((restored as unknown as { queue: { peekNext(): unknown } }).queue.peekNext());
      expect(restored.exportSave({ longestStreak: 4, savedAt: 1234, appBuild: 'test-build' })).toEqual(save);
    });

    test('continues deterministically across a level push, restoring both random streams', () => {
      const twoTurnMode: GameModeConfig = {
        ...CLASSIC_MODE,
        id: 'save-push-continuation-test',
        initialTurnsPerLevel: 2,
        turnsPerLevelStep: 0,
        minTurnsPerLevel: 2,
      };
      const uninterrupted = new GameEngine({ mode: twoTurnMode, seed: 0xdeadbeef });
      expect(uninterrupted.drop(0).accepted).toBe(true);
      const checkpoint = uninterrupted.exportSave({ savedAt: 100 });
      const restored = new GameEngine({ mode: twoTurnMode, seed: 1 });
      restored.loadSave(checkpoint, twoTurnMode);

      const originalTurn = uninterrupted.drop(6);
      const restoredTurn = restored.drop(6);

      expect(originalTurn.steps.some(step => step.kind === StepKind.Push)).toBe(true);
      expect(restoredTurn.steps.map(step => step.kind)).toEqual(originalTurn.steps.map(step => step.kind));
      expect(restored.exportSave({ savedAt: 200 })).toEqual(
        uninterrupted.exportSave({ savedAt: 200 }),
      );
    });

    test('rejects invalid, mode-mismatched, scripted, and unstable saves', () => {
      const source = new GameEngine({ seed: 3 });
      const save = source.exportSave({ savedAt: 1 });
      const target = new GameEngine({ seed: 4 });
      const before = target.exportSave({ savedAt: 2 });

      expect(() => target.loadSave({ ...save, rulesVersion: 99 }, CLASSIC_MODE)).toThrow(/invalid|incompatible/i);
      expect(() => target.loadSave(save, STACK_MODE)).toThrow(/invalid|incompatible/i);
      expect(target.exportSave({ savedAt: 2 })).toEqual(before);

      const scripted = new GameEngine({ discFactory: numberedFactory(3) });
      expect(() => scripted.exportSave()).toThrow(/injected/i);

      const gravity = new GameEngine({ mode: GRAVITY_MODE, seed: 5 });
      expect(gravity.stageGravityDrop(3)).toBeUndefined();
      expect(() => gravity.exportSave()).toThrow(/stable/i);
    });

    test('round-trips Stack and a committed Gravity angle', () => {
      const stack = new GameEngine({ mode: STACK_MODE, seed: 12 });
      stack.drop(1);
      const stackSave = stack.exportSave({ savedAt: 12 });
      const restoredStack = new GameEngine({ seed: 1 });
      restoredStack.loadSave(stackSave, STACK_MODE);
      expect(restoredStack.exportSave({ savedAt: 12 })).toEqual(stackSave);

      const gravity = new GameEngine({ mode: GRAVITY_MODE, seed: 13 });
      expect(gravity.stageGravityDrop(3)).toBeUndefined();
      gravity.tiltGravity(45);
      expect(gravity.commitTilt().accepted).toBe(true);
      const gravitySave = gravity.exportSave({ savedAt: 13 });
      const restoredGravity = new GameEngine({ seed: 1 });
      restoredGravity.loadSave(gravitySave, GRAVITY_MODE);

      expect(restoredGravity.state.gravity).toEqual({
        angle: 45,
        turnStartAngle: 45,
        maxTiltDelta: GRAVITY_MODE.gravity!.maxTiltDeltaDeg,
      });
      expect(restoredGravity.exportSave({ savedAt: 13 })).toEqual(gravitySave);
    });
  });
});
