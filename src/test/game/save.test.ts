import { describe, expect, test } from 'vitest';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import { CLASSIC_RULES, GRAVITY_RULES, PARADOX_RULES } from '../../game/modes/index.js';
import { GameEngine } from '../../game/engine.js';
import type { GameRulesConfig } from '../../game/modes/mode.js';
import {
  deserializeBoard,
  deserializeDisc,
  parseSaveGame,
  parseSaveGameJson,
  SAVE_GAME_RULES_VERSION,
  SAVE_GAME_VERSION,
  serializeBoard,
  serializeDisc,
  stringifySaveGame,
  type SaveGameV1,
} from '../../game/save.js';

function emptySavedBoard(mode: GameRulesConfig = CLASSIC_RULES) {
  return Array.from(
    { length: mode.board.rows },
    () => Array.from({ length: mode.board.cols }, () => null),
  );
}

function validSave(mode: GameRulesConfig = CLASSIC_RULES): SaveGameV1 {
  const gravity = mode.placement.kind === 'stage-and-tilt@1'
    ? { gravity: { angle: mode.placement.initialAngleDeg } }
    : {};
  return {
    version: SAVE_GAME_VERSION,
    rulesVersion: SAVE_GAME_RULES_VERSION,
    savedAt: 1_725_000_000_000,
    appBuild: 'test-build',
    modeId: mode.id,
    state: {
      phase: 'waiting',
      board: emptySavedBoard(mode),
      cursorCol: 2,
      score: 12_345,
      dropCount: 9,
      level: 1,
      turnsPerLevel: mode.progression.initialTurnsPerLevel,
      turnsRemaining: mode.progression.initialTurnsPerLevel - 9,
      ...gravity,
    },
    generation: {
      source: 'seeded',
      seed: 0xffff_ffff,
      queue: [
        { value: mode.generation.discValueMin, kind: DiscKind.Numbered },
        { value: mode.generation.discValueMax, kind: DiscKind.DoubleCracked },
        { value: mode.generation.discValueMin, kind: DiscKind.Numbered },
      ],
      playableGenerator: {
        recentValues: [
          mode.generation.discValueMin,
          mode.generation.discValueMax,
          mode.generation.discValueMin,
        ],
        recentKinds: [DiscKind.Numbered, DiscKind.DoubleCracked, DiscKind.Numbered],
      },
      random: { playableState: 0, pushState: 123 },
    },
    session: { longestStreak: 4 },
    meta: { source: 'autosave' },
  };
}

function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe('save disc and board serialization', () => {
  test('disc IDs are omitted and deserialization allocates fresh runtime IDs', () => {
    const original = makeDisc(4, DiscKind.SingleCracked);
    const saved = serializeDisc(original);
    const first = deserializeDisc(saved);
    const second = deserializeDisc(saved);

    expect(saved).toEqual({ value: 4, kind: DiscKind.SingleCracked });
    expect(saved).not.toHaveProperty('id');
    expect(first).toMatchObject(saved);
    expect(first.id).not.toBe(original.id);
    expect(second.id).not.toBe(first.id);
  });

  test('temporal fracture metadata round-trips independently', () => {
    const original = makeDisc(5, DiscKind.DoubleCracked);
    original.temporalFracture = { createdAtInstability: 4, instabilityDebt: 2 };
    const saved = serializeDisc(original);
    const restored = deserializeDisc(saved);

    expect(saved.temporalFracture).toEqual({ createdAtInstability: 4, instabilityDebt: 2 });
    expect(restored.temporalFracture).toEqual({ createdAtInstability: 4, instabilityDebt: 2 });
    restored.temporalFracture!.createdAtInstability = 9;
    expect(saved.temporalFracture).toEqual({ createdAtInstability: 4, instabilityDebt: 2 });

    const restoredLegacy = deserializeDisc({
      value: 5,
      kind: DiscKind.SingleCracked,
      temporalFracture: { createdAtInstability: 3 },
    });
    expect(restoredLegacy.temporalFracture).toEqual({
      createdAtInstability: 3,
      instabilityDebt: 1,
    });
  });

  test('completed-run analytics round-trip while older v1 saves default them at the controller', () => {
    const save = validSave();
    save.session.playTimeMs = 123_456;
    save.session.discsBroken = 42;

    expect(parseSaveGame(jsonClone(save), CLASSIC_RULES)?.session).toEqual({
      longestStreak: 4,
      playTimeMs: 123_456,
      discsBroken: 42,
    });

    const legacy = validSave();
    expect(parseSaveGame(jsonClone(legacy), CLASSIC_RULES)?.session).toEqual({ longestStreak: 4 });
  });

  test('boards round-trip independently with fresh disc IDs', () => {
    const original = [
      [makeDisc(1, DiscKind.Numbered), null],
      [null, makeDisc(2, DiscKind.DoubleCracked)],
    ];
    const saved = serializeBoard(original);
    const restored = deserializeBoard(saved);

    expect(saved).toEqual([
      [{ value: 1, kind: DiscKind.Numbered }, null],
      [null, { value: 2, kind: DiscKind.DoubleCracked }],
    ]);
    expect(restored[0]![0]!.id).not.toBe(original[0]![0]!.id);
    expect(restored[1]![1]!.id).not.toBe(original[1]![1]!.id);
    restored[0]![0]!.value = 7;
    expect(saved[0]![0]!.value).toBe(1);
  });
});

describe('SaveGameV1 parsing', () => {
  test('accepts a valid autosave and returns a clean independent copy', () => {
    const source = validSave();
    const parsed = parseSaveGame(source, CLASSIC_RULES);

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed!.state.board).not.toBe(source.state.board);
    expect(parsed!.generation.queue).not.toBe(source.generation.queue);
    source.generation.queue[0]!.value = 7;
    expect(parsed!.generation.queue[0]!.value).toBe(1);
  });

  test('stringifies and parses valid JSON, returning null for invalid JSON', () => {
    const save = validSave();
    expect(parseSaveGameJson(stringifySaveGame(save), CLASSIC_RULES)).toEqual(save);
    expect(parseSaveGameJson('{not json', CLASSIC_RULES)).toBeNull();
  });

  test.each([
    ['schema version', (save: Record<string, unknown>) => { save.version = 2; }],
    ['rules version', (save: Record<string, unknown>) => { save.rulesVersion = 2; }],
    ['mode ID', (save: Record<string, unknown>) => { save.modeId = 'stack'; }],
    ['savedAt', (save: Record<string, unknown>) => { save.savedAt = Number.NaN; }],
    ['metadata source', (save: Record<string, unknown>) => {
      (save.meta as Record<string, unknown>).source = 'manual';
    }],
    ['session streak', (save: Record<string, unknown>) => {
      (save.session as Record<string, unknown>).longestStreak = -1;
    }],
    ['stable phase', (save: Record<string, unknown>) => {
      (save.state as Record<string, unknown>).phase = 'aiming';
    }],
    ['unknown top-level property', (save: Record<string, unknown>) => { save.extra = true; }],
  ])('rejects an invalid %s', (_label, mutate) => {
    const candidate = jsonClone(validSave()) as Record<string, unknown>;
    mutate(candidate);
    expect(parseSaveGame(candidate, CLASSIC_RULES)).toBeNull();
  });

  test('rejects malformed board dimensions, cells, and values', () => {
    const wrongRows = validSave();
    wrongRows.state.board.pop();
    expect(parseSaveGame(wrongRows, CLASSIC_RULES)).toBeNull();

    const ragged = validSave();
    ragged.state.board[0]!.pop();
    expect(parseSaveGame(ragged, CLASSIC_RULES)).toBeNull();

    const invalidKind = jsonClone(validSave()) as SaveGameV1;
    invalidKind.state.board[0]![0] = { value: 1, kind: 'wild' as DiscKind };
    expect(parseSaveGame(invalidKind, CLASSIC_RULES)).toBeNull();

    const invalidValue = validSave();
    invalidValue.state.board[0]![0] = { value: 8, kind: DiscKind.Numbered };
    expect(parseSaveGame(invalidValue, CLASSIC_RULES)).toBeNull();
  });

  test('rejects invalid counters, cursor, and turn budgets', () => {
    const invalidScore = validSave();
    invalidScore.state.score = -1;
    expect(parseSaveGame(invalidScore, CLASSIC_RULES)).toBeNull();

    const invalidCursor = validSave();
    invalidCursor.state.cursorCol = CLASSIC_RULES.board.cols;
    expect(parseSaveGame(invalidCursor, CLASSIC_RULES)).toBeNull();

    const wrongTotal = validSave();
    wrongTotal.state.turnsPerLevel--;
    expect(parseSaveGame(wrongTotal, CLASSIC_RULES)).toBeNull();

    const noTurns = validSave();
    noTurns.state.turnsRemaining = 0;
    expect(parseSaveGame(noTurns, CLASSIC_RULES)).toBeNull();

    const tooManyTurns = validSave();
    tooManyTurns.state.turnsRemaining = tooManyTurns.state.turnsPerLevel + 1;
    expect(parseSaveGame(tooManyTurns, CLASSIC_RULES)).toBeNull();
  });

  test('requires exactly three valid playable queue discs', () => {
    const shortQueue = validSave();
    shortQueue.generation.queue.pop();
    expect(parseSaveGame(shortQueue, CLASSIC_RULES)).toBeNull();

    const invalidValue = validSave();
    invalidValue.generation.queue[0]!.value = 0;
    expect(parseSaveGame(invalidValue, CLASSIC_RULES)).toBeNull();

    const revealedDisc = validSave();
    revealedDisc.generation.queue[0]!.kind = DiscKind.SingleCracked;
    expect(parseSaveGame(revealedDisc, CLASSIC_RULES)).toBeNull();
  });

  test('validates generator histories and unsigned 32-bit random state', () => {
    const mismatchedHistory = validSave();
    mismatchedHistory.generation.playableGenerator.recentKinds.pop();
    expect(parseSaveGame(mismatchedHistory, CLASSIC_RULES)).toBeNull();

    const emptyHistory = validSave();
    emptyHistory.generation.playableGenerator.recentValues = [];
    emptyHistory.generation.playableGenerator.recentKinds = [];
    expect(parseSaveGame(emptyHistory, CLASSIC_RULES)).toBeNull();

    const badSeed = validSave();
    badSeed.generation.seed = 0x1_0000_0000;
    expect(parseSaveGame(badSeed, CLASSIC_RULES)).toBeNull();

    const badPlayableState = validSave();
    badPlayableState.generation.random.playableState = -1;
    expect(parseSaveGame(badPlayableState, CLASSIC_RULES)).toBeNull();

    const badPushState = validSave();
    badPushState.generation.random.pushState = 1.5;
    expect(parseSaveGame(badPushState, CLASSIC_RULES)).toBeNull();

    const badEchoState = validSave();
    badEchoState.generation.random.echoState = -1;
    expect(parseSaveGame(badEchoState, CLASSIC_RULES)).toBeNull();
  });

  test('requires gravity data only for Gravity mode and validates stable angles', () => {
    const gravityInClassic = validSave();
    gravityInClassic.state.gravity = { angle: 0 };
    expect(parseSaveGame(gravityInClassic, CLASSIC_RULES)).toBeNull();

    const missingGravity = validSave(GRAVITY_RULES);
    delete missingGravity.state.gravity;
    expect(parseSaveGame(missingGravity, GRAVITY_RULES)).toBeNull();

    const unsnappedGravity = validSave(GRAVITY_RULES);
    unsnappedGravity.state.gravity!.angle = 12;
    expect(parseSaveGame(unsnappedGravity, GRAVITY_RULES)).toBeNull();

    expect(parseSaveGame(validSave(GRAVITY_RULES), GRAVITY_RULES)).not.toBeNull();
  });

  test('uses the Gravity entry axis to validate the cursor', () => {
    const rectangularGravity: GameRulesConfig = {
      ...GRAVITY_RULES,
      id: 'rectangular-gravity',
      board: { ...GRAVITY_RULES.board, cols: 7, rows: 3 },
    };
    const save = validSave(rectangularGravity);
    save.state.gravity!.angle = 90;
    save.state.cursorCol = 3;

    expect(parseSaveGame(save, rectangularGravity)).toBeNull();
    save.state.cursorCol = 2;
    expect(parseSaveGame(save, rectangularGravity)).not.toBeNull();
  });

  test('validates Paradox instability, checkpoints, and temporal board metadata', () => {
    const source = new GameEngine({ rules: PARADOX_RULES, seed: 1 });
    source.state.board[6]![0] = makeDisc(7, DiscKind.Numbered);
    source.drop(6);
    source.commitRewind();
    const fractured = source.exportSave({ savedAt: 20 });
    expect(parseSaveGame(fractured, PARADOX_RULES)).toEqual(fractured);

    const checkpointSource = new GameEngine({ rules: PARADOX_RULES, seed: 2 });
    checkpointSource.drop(3);
    checkpointSource.drop(4);
    const checkpoint = checkpointSource.exportSave({ savedAt: 21, rewindLongestStreaks: [3, 4] });
    expect(parseSaveGame(checkpoint, PARADOX_RULES)).toEqual(checkpoint);
    expect(checkpoint.paradox!.rewinds).toHaveLength(2);

    const legacy = jsonClone(checkpoint) as SaveGameV1;
    legacy.paradox!.rewind = legacy.paradox!.rewinds!.at(-1)!;
    delete legacy.paradox!.rewinds;
    expect(parseSaveGame(legacy, PARADOX_RULES)).toEqual(legacy);

    const reversed = jsonClone(checkpoint) as SaveGameV1;
    reversed.paradox!.rewinds!.reverse();
    expect(parseSaveGame(reversed, PARADOX_RULES)).toBeNull();

    const missingParadox = jsonClone(checkpoint) as Record<string, unknown>;
    delete missingParadox.paradox;
    expect(parseSaveGame(missingParadox, PARADOX_RULES)).toBeNull();

    const missingFatalCheckpoint = jsonClone(checkpoint) as SaveGameV1;
    missingFatalCheckpoint.state.phase = 'game-over';
    delete missingFatalCheckpoint.paradox!.rewinds;
    expect(parseSaveGame(missingFatalCheckpoint, PARADOX_RULES)).toBeNull();
  });

  test('rejects temporal metadata in modes without rewind', () => {
    const save = validSave();
    save.state.board[6]![0] = {
      value: 7,
      kind: DiscKind.SingleCracked,
      temporalFracture: { createdAtInstability: 1, instabilityDebt: 1 },
    };
    expect(parseSaveGame(save, CLASSIC_RULES)).toBeNull();
  });

  test('accepts legacy fracture debt and rejects invalid explicit debt', () => {
    const legacy = validSave(PARADOX_RULES);
    legacy.paradox = { instability: 1 };
    legacy.state.board[6]![0] = {
      value: 7,
      kind: DiscKind.SingleCracked,
      temporalFracture: { createdAtInstability: 1 },
    };
    expect(parseSaveGame(legacy, PARADOX_RULES)).toEqual(legacy);

    const invalid = jsonClone(legacy) as SaveGameV1;
    invalid.state.board[6]![0]!.temporalFracture!.instabilityDebt = 0;
    expect(parseSaveGame(invalid, PARADOX_RULES)).toBeNull();
  });
});
