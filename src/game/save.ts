import { makeDisc } from './disc.js';
import { entryEdgeForAngle, snapAngleToEightDirections } from './gravity/settling.js';
import type { Board, Disc } from './model.js';
import { DiscKind } from './model.js';
import type { GameRulesConfig } from './modes/mode.js';
import { rewindModifier, turnsForLevel } from './modes/mode.js';

export const SAVE_GAME_VERSION = 1 as const;
export const SAVE_GAME_RULES_VERSION = 1 as const;

export interface SavedDisc {
  value: number;
  kind: DiscKind;
  temporalFracture?: {
    createdAtInstability: number;
    /** Optional so saves created before fracture debt remain loadable. */
    instabilityDebt?: number;
  };
}

export type SavedCell = SavedDisc | null;
export type SavedBoard = SavedCell[][];

export interface SavedGameState {
  phase: 'waiting' | 'game-over';
  board: SavedBoard;
  cursorCol: number;
  score: number;
  dropCount: number;
  level: number;
  turnsPerLevel: number;
  turnsRemaining: number;
  gravity?: {
    angle: number;
  };
}

export interface SavedRewindCheckpoint {
  state: SavedGameState & { phase: 'waiting' };
  generation: SavedGenerationState;
  anchor: { row: number; col: number };
  instability: number;
  session: {
    longestStreak: number;
  };
}

export interface SavedParadoxState {
  instability: number;
  /** Current multi-turn format, ordered oldest to newest. */
  rewinds?: SavedRewindCheckpoint[];
  /** Legacy one-turn format retained for backward-compatible loading. */
  rewind?: SavedRewindCheckpoint;
}

export interface SavedGenerationState {
  source: 'seeded';
  seed: number;
  queue: SavedDisc[];
  playableGenerator: {
    recentValues: number[];
    recentKinds: DiscKind[];
  };
  random: {
    playableState: number;
    pushState: number;
    /** Added with Temporal Echo; absent saves start from the seed-derived stream. */
    echoState?: number;
  };
}

export interface SaveGameV1 {
  version: typeof SAVE_GAME_VERSION;
  rulesVersion: number;
  savedAt: number;
  appBuild?: string;
  modeId: string;
  state: SavedGameState;
  generation: SavedGenerationState;
  session: {
    longestStreak: number;
  };
  paradox?: SavedParadoxState;
  meta: {
    source: 'autosave';
  };
}

const UINT32_MAX = 0xffff_ffff;
const DISC_KINDS = new Set<string>(Object.values(DiscKind));
const PLAYABLE_DISC_KINDS = new Set<DiscKind>([DiscKind.Numbered, DiscKind.DoubleCracked]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isUint32(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= UINT32_MAX;
}

function isDiscKind(value: unknown): value is DiscKind {
  return typeof value === 'string' && DISC_KINDS.has(value);
}

function parseDisc(value: unknown, rules: GameRulesConfig, playableOnly = false): SavedDisc | null {
  if (!isObject(value) || !hasOnlyKeys(value, ['value', 'kind'], ['temporalFracture'])) return null;
  if (!isPositiveInteger(value.value)
    || value.value < rules.generation.discValueMin
    || value.value > rules.generation.discValueMax
    || !isDiscKind(value.kind)
    || (playableOnly && !PLAYABLE_DISC_KINDS.has(value.kind))) return null;
  if (value.temporalFracture !== undefined) {
    if (!rewindModifier(rules) || playableOnly
      || (value.kind !== DiscKind.SingleCracked && value.kind !== DiscKind.DoubleCracked)
      || !isObject(value.temporalFracture)
      || !hasOnlyKeys(value.temporalFracture, ['createdAtInstability'], ['instabilityDebt'])
      || !isPositiveInteger(value.temporalFracture.createdAtInstability)
      || (value.temporalFracture.instabilityDebt !== undefined
        && !isPositiveInteger(value.temporalFracture.instabilityDebt))) return null;
    return {
      value: value.value,
      kind: value.kind,
      temporalFracture: {
        createdAtInstability: value.temporalFracture.createdAtInstability,
        ...(value.temporalFracture.instabilityDebt !== undefined
          ? { instabilityDebt: value.temporalFracture.instabilityDebt }
          : {}),
      },
    };
  }
  return { value: value.value, kind: value.kind };
}

function parseBoard(value: unknown, rules: GameRulesConfig): SavedBoard | null {
  if (!Array.isArray(value) || value.length !== rules.board.rows) return null;
  const board: SavedBoard = [];
  for (const sourceRow of value) {
    if (!Array.isArray(sourceRow) || sourceRow.length !== rules.board.cols) return null;
    const row: SavedCell[] = [];
    for (const cell of sourceRow) {
      if (cell === null) {
        row.push(null);
        continue;
      }
      const disc = parseDisc(cell, rules);
      if (!disc) return null;
      row.push(disc);
    }
    board.push(row);
  }
  return board;
}

export function serializeDisc(disc: Disc): SavedDisc {
  return {
    value: disc.value,
    kind: disc.kind,
    ...(disc.temporalFracture
      ? { temporalFracture: { ...disc.temporalFracture } }
      : {}),
  };
}

/** Creates a runtime disc with a fresh animation ID. */
export function deserializeDisc(disc: SavedDisc): Disc {
  const restored = makeDisc(disc.value, disc.kind);
  if (disc.temporalFracture) {
    restored.temporalFracture = {
      createdAtInstability: disc.temporalFracture.createdAtInstability,
      instabilityDebt: disc.temporalFracture.instabilityDebt ?? 1,
    };
  }
  return restored;
}

export function serializeBoard(board: Board): SavedBoard {
  return board.map(row => row.map(cell => cell === null ? null : serializeDisc(cell)));
}

/** Creates an independent runtime board whose discs all have fresh animation IDs. */
export function deserializeBoard(board: SavedBoard): Board {
  return board.map(row => row.map(cell => cell === null ? null : deserializeDisc(cell)));
}

function parseState(value: unknown, rules: GameRulesConfig, allowGameOver = false): SavedGameState | null {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'phase', 'board', 'cursorCol', 'score', 'dropCount', 'level',
    'turnsPerLevel', 'turnsRemaining',
  ], ['gravity'])) return null;
  if ((value.phase !== 'waiting' && (!allowGameOver || value.phase !== 'game-over'))
    || !isNonNegativeInteger(value.cursorCol)
    || !isNonNegativeInteger(value.score)
    || !isNonNegativeInteger(value.dropCount)
    || !isPositiveInteger(value.level)
    || !isPositiveInteger(value.turnsPerLevel)
    || !isNonNegativeInteger(value.turnsRemaining)
    || (value.phase === 'waiting' && value.turnsRemaining === 0)) return null;

  const expectedTurns = turnsForLevel(rules.progression, value.level);
  if (value.turnsPerLevel !== expectedTurns || value.turnsRemaining > value.turnsPerLevel) return null;
  const board = parseBoard(value.board, rules);
  if (!board) return null;

  if (rules.placement.kind === 'stage-and-tilt@1') {
    if (!isObject(value.gravity) || !hasOnlyKeys(value.gravity, ['angle'])) return null;
    const angle = value.gravity.angle;
    if (typeof angle !== 'number' || !Number.isFinite(angle)
      || snapAngleToEightDirections(angle) !== angle) return null;
    const edge = entryEdgeForAngle(angle);
    const laneCount = edge === 'top' || edge === 'bottom' ? rules.board.cols : rules.board.rows;
    if (value.cursorCol >= laneCount) return null;
    return {
      phase: value.phase, board, cursorCol: value.cursorCol, score: value.score,
      dropCount: value.dropCount, level: value.level, turnsPerLevel: value.turnsPerLevel,
      turnsRemaining: value.turnsRemaining, gravity: { angle },
    };
  }

  if (value.gravity !== undefined || value.cursorCol >= rules.board.cols) return null;
  return {
    phase: value.phase, board, cursorCol: value.cursorCol, score: value.score,
    dropCount: value.dropCount, level: value.level, turnsPerLevel: value.turnsPerLevel,
    turnsRemaining: value.turnsRemaining,
  };
}

function parseAnchor(value: unknown, rules: GameRulesConfig): { row: number; col: number } | null {
  if (!isObject(value) || !hasOnlyKeys(value, ['row', 'col'])
    || !isNonNegativeInteger(value.row) || value.row >= rules.board.rows
    || !isNonNegativeInteger(value.col) || value.col >= rules.board.cols) return null;
  return { row: value.row, col: value.col };
}

function parseRewindCheckpoint(value: unknown, rules: GameRulesConfig): SavedRewindCheckpoint | null {
  if (!isObject(value) || !hasOnlyKeys(value, ['state', 'generation', 'anchor', 'instability', 'session'])) return null;
  const state = parseState(value.state, rules);
  const generation = parseGeneration(value.generation, rules);
  const anchor = parseAnchor(value.anchor, rules);
  if (!state || state.phase !== 'waiting' || !generation || !anchor
    || !isNonNegativeInteger(value.instability)
    || !isObject(value.session) || !hasOnlyKeys(value.session, ['longestStreak'])
    || !isNonNegativeInteger(value.session.longestStreak)) return null;
  return {
    state: { ...state, phase: 'waiting' },
    generation,
    anchor,
    instability: value.instability,
    session: { longestStreak: value.session.longestStreak },
  };
}

function parseParadoxState(value: unknown, rules: GameRulesConfig): SavedParadoxState | null {
  if (!isObject(value) || !hasOnlyKeys(value, ['instability'], ['rewind', 'rewinds'])
    || !isNonNegativeInteger(value.instability)) return null;
  if (value.rewind !== undefined && value.rewinds !== undefined) return null;
  if (value.rewinds !== undefined) {
    const rewindRules = rewindModifier(rules);
    if (!Array.isArray(value.rewinds)
      || value.rewinds.length < 1
      || !rewindRules
      || value.rewinds.length > rewindRules.historyDepth) return null;
    const rewinds: SavedRewindCheckpoint[] = [];
    for (const item of value.rewinds) {
      const rewind = parseRewindCheckpoint(item, rules);
      if (!rewind) return null;
      rewinds.push(rewind);
    }
    for (let index = 1; index < rewinds.length; index++) {
      if (rewinds[index]!.state.dropCount <= rewinds[index - 1]!.state.dropCount) return null;
    }
    return { instability: value.instability, rewinds };
  }
  if (value.rewind === undefined) return { instability: value.instability };
  const rewind = parseRewindCheckpoint(value.rewind, rules);
  return rewind ? { instability: value.instability, rewind } : null;
}

function parseGeneration(value: unknown, rules: GameRulesConfig): SavedGenerationState | null {
  if (!isObject(value) || !hasOnlyKeys(value, ['source', 'seed', 'queue', 'playableGenerator', 'random'])
    || value.source !== 'seeded' || !isUint32(value.seed)
    || !Array.isArray(value.queue) || value.queue.length !== 3) return null;
  const queue: SavedDisc[] = [];
  for (const item of value.queue) {
    const disc = parseDisc(item, rules, true);
    if (!disc) return null;
    queue.push(disc);
  }

  if (!isObject(value.playableGenerator)
    || !hasOnlyKeys(value.playableGenerator, ['recentValues', 'recentKinds'])
    || !Array.isArray(value.playableGenerator.recentValues)
    || !Array.isArray(value.playableGenerator.recentKinds)) return null;
  const recentValues = value.playableGenerator.recentValues;
  const recentKinds = value.playableGenerator.recentKinds;
  const historyLimit = Math.max(
    rules.generation.valueBalanceWindow,
    rules.generation.kindBalanceWindow,
  );
  if (recentValues.length === 0 || recentValues.length !== recentKinds.length || recentValues.length > historyLimit
    || !recentValues.every(item => isPositiveInteger(item)
      && item >= rules.generation.discValueMin && item <= rules.generation.discValueMax)
    || !recentKinds.every(item => isDiscKind(item) && PLAYABLE_DISC_KINDS.has(item))) return null;

  if (!isObject(value.random) || !hasOnlyKeys(value.random, ['playableState', 'pushState'], ['echoState'])
    || !isUint32(value.random.playableState) || !isUint32(value.random.pushState)
    || (value.random.echoState !== undefined && !isUint32(value.random.echoState))) return null;

  return {
    source: 'seeded', seed: value.seed, queue,
    playableGenerator: {
      recentValues: [...recentValues] as number[],
      recentKinds: [...recentKinds] as DiscKind[],
    },
    random: {
      playableState: value.random.playableState,
      pushState: value.random.pushState,
      ...(value.random.echoState !== undefined ? { echoState: value.random.echoState } : {}),
    },
  };
}

/**
 * Validates an untrusted value against the save schema and supplied rules version.
 * The returned save is a clean, independent copy; invalid values return null.
 */
export function parseSaveGame(value: unknown, rules: GameRulesConfig): SaveGameV1 | null {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'version', 'rulesVersion', 'savedAt', 'modeId', 'state',
    'generation', 'session', 'meta',
  ], ['appBuild', 'paradox'])) return null;
  if (value.version !== SAVE_GAME_VERSION || value.rulesVersion !== rules.version
    || !isNonNegativeInteger(value.savedAt) || value.modeId !== rules.id
    || (value.appBuild !== undefined && typeof value.appBuild !== 'string')) return null;

  const rewind = rewindModifier(rules);
  const state = parseState(value.state, rules, rewind !== undefined);
  const generation = parseGeneration(value.generation, rules);
  if (!state || !generation) return null;
  if (!isObject(value.session) || !hasOnlyKeys(value.session, ['longestStreak'])
    || !isNonNegativeInteger(value.session.longestStreak)) return null;
  if (!isObject(value.meta) || !hasOnlyKeys(value.meta, ['source'])
    || value.meta.source !== 'autosave') return null;

  const paradox = rewind ? parseParadoxState(value.paradox, rules) : null;
  if (rewind) {
    if (!paradox || (state.phase === 'game-over' && !paradox.rewind && !paradox.rewinds?.length)) return null;
  } else if (value.paradox !== undefined || state.phase !== 'waiting') {
    return null;
  }

  const save: SaveGameV1 = {
    version: SAVE_GAME_VERSION,
    rulesVersion: rules.version,
    savedAt: value.savedAt,
    modeId: rules.id,
    state,
    generation,
    session: { longestStreak: value.session.longestStreak },
    ...(paradox ? { paradox } : {}),
    meta: { source: 'autosave' },
  };
  if (typeof value.appBuild === 'string') save.appBuild = value.appBuild;
  return save;
}

export function stringifySaveGame(save: SaveGameV1): string {
  return JSON.stringify(save);
}

/** Parses JSON and applies the same strict runtime validation as parseSaveGame. */
export function parseSaveGameJson(json: string, rules: GameRulesConfig): SaveGameV1 | null {
  try {
    return parseSaveGame(JSON.parse(json) as unknown, rules);
  } catch {
    return null;
  }
}
