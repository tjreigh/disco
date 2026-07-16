import { describe, expect, test } from 'vitest';
import { makeDisc } from '../../game/disc.js';
import { GameEngine } from '../../game/engine.js';
import { StepKind } from '../../game/events.js';
import { DiscKind } from '../../game/model.js';
import { PARADOX_MODE } from '../../game/modes/index.js';
import type { GameModeConfig } from '../../game/modes/mode.js';

const ECHO_EVERY_TURN: GameModeConfig = {
  ...PARADOX_MODE,
  id: 'paradox-temporal-echo-test',
  rewind: {
    ...PARADOX_MODE.rewind!,
    temporalEcho: { tiers: [{ minimumInstability: 0, probability: 1 }] },
  },
};

const ECHO_FROM_FIVE: GameModeConfig = {
  ...ECHO_EVERY_TURN,
  id: 'paradox-temporal-echo-threshold-test',
  rewind: {
    ...ECHO_EVERY_TURN.rewind!,
    temporalEcho: { tiers: [{ minimumInstability: 5, probability: 1 }] },
  },
};

describe('Paradox Temporal Echo', () => {
  test('repeats the played disc into another legal column without spending another turn', () => {
    const engine = new GameEngine({
      mode: ECHO_EVERY_TURN,
      seed: 0x1357_2468,
      discFactory: () => makeDisc(1, DiscKind.Numbered),
    });
    engine.state.paradox!.instability = 5;
    const turnsBefore = engine.state.turnsRemaining;

    const result = engine.drop(3);
    const drops = result.steps.filter(step => step.kind === StepKind.Drop);
    const clears = result.steps.filter(step => step.kind === StepKind.Clear);

    expect(result.accepted).toBe(true);
    expect(drops).toHaveLength(2);
    expect(drops[0]).not.toHaveProperty('temporalEcho');
    expect(drops[1]).toMatchObject({
      temporalEcho: true,
      disc: { value: 1, kind: DiscKind.Numbered },
    });
    expect(drops[1]!.disc.id).not.toBe(drops[0]!.disc.id);
    expect(drops[1]!.landPos.col).not.toBe(3);
    expect(clears.map(clear => clear.chainLevel)).toEqual([0, 1]);
    expect(engine.state.dropCount).toBe(1);
    expect(engine.state.turnsRemaining).toBe(turnsBefore - 2);
  });

  test('does not echo below the first configured instability tier', () => {
    const engine = new GameEngine({ mode: ECHO_FROM_FIVE, seed: 0x2468_1357 });
    engine.state.paradox!.instability = 4;

    const result = engine.drop(3);

    expect(result.steps.filter(step => step.kind === StepKind.Drop)).toHaveLength(1);
  });

  test('persists the independent echo random stream across a save', () => {
    const uninterrupted = new GameEngine({ mode: ECHO_EVERY_TURN, seed: 0x1020_3040 });
    uninterrupted.drop(2);
    const save = uninterrupted.exportSave({ savedAt: 0 });

    const expected = uninterrupted.drop(3);
    const resumed = new GameEngine({ mode: ECHO_EVERY_TURN, seed: 1 });
    resumed.loadSave(save, ECHO_EVERY_TURN);
    const actual = resumed.drop(3);

    const echoLane = (steps: typeof expected.steps) => {
      const echo = steps.find(
        step => step.kind === StepKind.Drop && step.temporalEcho,
      );
      return echo?.kind === StepKind.Drop ? echo.landPos.col : undefined;
    };
    expect(save.generation.random.echoState).toEqual(expect.any(Number));
    expect(echoLane(actual.steps)).toBe(echoLane(expected.steps));
    expect(resumed.exportSave({ savedAt: 0 })).toEqual(uninterrupted.exportSave({ savedAt: 0 }));
  });

  test('restores the echo random stream when a turn is rewound', () => {
    const rewound = new GameEngine({ mode: ECHO_EVERY_TURN, seed: 0x5566_7788 });
    rewound.drop(2);
    rewound.commitRewind();
    const replay = rewound.drop(3);

    const control = new GameEngine({ mode: ECHO_EVERY_TURN, seed: 0x5566_7788 });
    control.state.paradox!.instability = 1;
    const expected = control.drop(3);
    const echoCol = (result: typeof replay) => {
      const echo = result.steps.find(
        step => step.kind === StepKind.Drop && step.temporalEcho,
      );
      return echo?.kind === StepKind.Drop ? echo.landPos.col : undefined;
    };

    expect(echoCol(replay)).toBe(echoCol(expected));
    expect(rewound.exportSave({ savedAt: 0 }).generation.random.echoState)
      .toBe(control.exportSave({ savedAt: 0 }).generation.random.echoState);
  });
});
