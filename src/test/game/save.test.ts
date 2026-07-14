import { describe, expect, test } from 'vitest';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import { CLASSIC_MODE, GRAVITY_MODE, PARADOX_MODE } from '../../game/modes/index.js';
import { GameEngine } from '../../game/engine.js';
import type { GameModeConfig } from '../../game/modes/mode.js';
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

function emptySavedBoard(mode: GameModeConfig = CLASSIC_MODE) {
  return Array.from(
    { length: mode.board.rows },
    () => Array.from({ length: mode.board.cols }, () => null),
  );
}

function validSave(mode: GameModeConfig = CLASSIC_MODE): SaveGameV1 {
  const gravity = mode.gravity ? { gravity: { angle: mode.gravity.initialAngleDeg } } : {};
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
      turnsPerLevel: mode.initialTurnsPerLevel,
      turnsRemaining: mode.initialTurnsPerLevel - 9,
      ...gravity,
    },
    generation: {
      source: 'seeded',
      seed: 0xffff_ffff,
      queue: [
        { value: mode.discValueMin, kind: DiscKind.Numbered },
        { value: mode.discValueMax, kind: DiscKind.DoubleCracked },
        { value: mode.discValueMin, kind: DiscKind.Numbered },
      ],
      playableGenerator: {
        recentValues: [mode.discValueMin, mode.discValueMax, mode.discValueMin],
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
    original.temporalFracture = { createdAtInstability: 4 };
    const saved = serializeDisc(original);
    const restored = deserializeDisc(saved);

    expect(saved.temporalFracture).toEqual({ createdAtInstability: 4 });
    expect(restored.temporalFracture).toEqual({ createdAtInstability: 4 });
    restored.temporalFracture!.createdAtInstability = 9;
    expect(saved.temporalFracture).toEqual({ createdAtInstability: 4 });
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
    const parsed = parseSaveGame(source, CLASSIC_MODE);

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed!.state.board).not.toBe(source.state.board);
    expect(parsed!.generation.queue).not.toBe(source.generation.queue);
    source.generation.queue[0]!.value = 7;
    expect(parsed!.generation.queue[0]!.value).toBe(1);
  });

  test('stringifies and parses valid JSON, returning null for invalid JSON', () => {
    const save = validSave();
    expect(parseSaveGameJson(stringifySaveGame(save), CLASSIC_MODE)).toEqual(save);
    expect(parseSaveGameJson('{not json', CLASSIC_MODE)).toBeNull();
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
    expect(parseSaveGame(candidate, CLASSIC_MODE)).toBeNull();
  });

  test('rejects malformed board dimensions, cells, and values', () => {
    const wrongRows = validSave();
    wrongRows.state.board.pop();
    expect(parseSaveGame(wrongRows, CLASSIC_MODE)).toBeNull();

    const ragged = validSave();
    ragged.state.board[0]!.pop();
    expect(parseSaveGame(ragged, CLASSIC_MODE)).toBeNull();

    const invalidKind = jsonClone(validSave()) as SaveGameV1;
    invalidKind.state.board[0]![0] = { value: 1, kind: 'wild' as DiscKind };
    expect(parseSaveGame(invalidKind, CLASSIC_MODE)).toBeNull();

    const invalidValue = validSave();
    invalidValue.state.board[0]![0] = { value: 8, kind: DiscKind.Numbered };
    expect(parseSaveGame(invalidValue, CLASSIC_MODE)).toBeNull();
  });

  test('rejects invalid counters, cursor, and turn budgets', () => {
    const invalidScore = validSave();
    invalidScore.state.score = -1;
    expect(parseSaveGame(invalidScore, CLASSIC_MODE)).toBeNull();

    const invalidCursor = validSave();
    invalidCursor.state.cursorCol = CLASSIC_MODE.board.cols;
    expect(parseSaveGame(invalidCursor, CLASSIC_MODE)).toBeNull();

    const wrongTotal = validSave();
    wrongTotal.state.turnsPerLevel--;
    expect(parseSaveGame(wrongTotal, CLASSIC_MODE)).toBeNull();

    const noTurns = validSave();
    noTurns.state.turnsRemaining = 0;
    expect(parseSaveGame(noTurns, CLASSIC_MODE)).toBeNull();

    const tooManyTurns = validSave();
    tooManyTurns.state.turnsRemaining = tooManyTurns.state.turnsPerLevel + 1;
    expect(parseSaveGame(tooManyTurns, CLASSIC_MODE)).toBeNull();
  });

  test('requires exactly three valid playable queue discs', () => {
    const shortQueue = validSave();
    shortQueue.generation.queue.pop();
    expect(parseSaveGame(shortQueue, CLASSIC_MODE)).toBeNull();

    const invalidValue = validSave();
    invalidValue.generation.queue[0]!.value = 0;
    expect(parseSaveGame(invalidValue, CLASSIC_MODE)).toBeNull();

    const revealedDisc = validSave();
    revealedDisc.generation.queue[0]!.kind = DiscKind.SingleCracked;
    expect(parseSaveGame(revealedDisc, CLASSIC_MODE)).toBeNull();
  });

  test('validates generator histories and unsigned 32-bit random state', () => {
    const mismatchedHistory = validSave();
    mismatchedHistory.generation.playableGenerator.recentKinds.pop();
    expect(parseSaveGame(mismatchedHistory, CLASSIC_MODE)).toBeNull();

    const emptyHistory = validSave();
    emptyHistory.generation.playableGenerator.recentValues = [];
    emptyHistory.generation.playableGenerator.recentKinds = [];
    expect(parseSaveGame(emptyHistory, CLASSIC_MODE)).toBeNull();

    const badSeed = validSave();
    badSeed.generation.seed = 0x1_0000_0000;
    expect(parseSaveGame(badSeed, CLASSIC_MODE)).toBeNull();

    const badPlayableState = validSave();
    badPlayableState.generation.random.playableState = -1;
    expect(parseSaveGame(badPlayableState, CLASSIC_MODE)).toBeNull();

    const badPushState = validSave();
    badPushState.generation.random.pushState = 1.5;
    expect(parseSaveGame(badPushState, CLASSIC_MODE)).toBeNull();
  });

  test('requires gravity data only for Gravity mode and validates stable angles', () => {
    const gravityInClassic = validSave();
    gravityInClassic.state.gravity = { angle: 0 };
    expect(parseSaveGame(gravityInClassic, CLASSIC_MODE)).toBeNull();

    const missingGravity = validSave(GRAVITY_MODE);
    delete missingGravity.state.gravity;
    expect(parseSaveGame(missingGravity, GRAVITY_MODE)).toBeNull();

    const unsnappedGravity = validSave(GRAVITY_MODE);
    unsnappedGravity.state.gravity!.angle = 12;
    expect(parseSaveGame(unsnappedGravity, GRAVITY_MODE)).toBeNull();

    expect(parseSaveGame(validSave(GRAVITY_MODE), GRAVITY_MODE)).not.toBeNull();
  });

  test('uses the Gravity entry axis to validate the cursor', () => {
    const rectangularGravity: GameModeConfig = {
      ...GRAVITY_MODE,
      id: 'rectangular-gravity',
      board: { cols: 7, rows: 3 },
    };
    const save = validSave(rectangularGravity);
    save.state.gravity!.angle = 90;
    save.state.cursorCol = 3;

    expect(parseSaveGame(save, rectangularGravity)).toBeNull();
    save.state.cursorCol = 2;
    expect(parseSaveGame(save, rectangularGravity)).not.toBeNull();
  });

  test('validates Paradox instability, checkpoints, and temporal board metadata', () => {
    const source = new GameEngine({ mode: PARADOX_MODE, seed: 1 });
    source.state.board[6]![0] = makeDisc(7, DiscKind.Numbered);
    source.drop(6);
    source.commitRewind();
    const fractured = source.exportSave({ savedAt: 20 });
    expect(parseSaveGame(fractured, PARADOX_MODE)).toEqual(fractured);

    const checkpointSource = new GameEngine({ mode: PARADOX_MODE, seed: 2 });
    checkpointSource.drop(3);
    const checkpoint = checkpointSource.exportSave({ savedAt: 21, rewindLongestStreak: 3 });
    expect(parseSaveGame(checkpoint, PARADOX_MODE)).toEqual(checkpoint);

    const missingParadox = jsonClone(checkpoint) as Record<string, unknown>;
    delete missingParadox.paradox;
    expect(parseSaveGame(missingParadox, PARADOX_MODE)).toBeNull();

    const missingFatalCheckpoint = jsonClone(checkpoint) as SaveGameV1;
    missingFatalCheckpoint.state.phase = 'game-over';
    delete missingFatalCheckpoint.paradox!.rewind;
    expect(parseSaveGame(missingFatalCheckpoint, PARADOX_MODE)).toBeNull();
  });

  test('rejects temporal metadata in modes without rewind', () => {
    const save = validSave();
    save.state.board[6]![0] = {
      value: 7,
      kind: DiscKind.SingleCracked,
      temporalFracture: { createdAtInstability: 1 },
    };
    expect(parseSaveGame(save, CLASSIC_MODE)).toBeNull();
  });
});
