import type { Board, Disc, GridPos } from './model.js';
import { DiscKind } from './model.js';
import type { GameRulesConfig, GenerationRules } from './modes/mode.js';
import { unnumberedProbabilityForLevel } from './modes/mode.js';
import type { RandomSource } from './random.js';
import { cloneBoard, isBoardEmpty, landingRow, placeDisc, removeDisc, applyGravity } from './board.js';

// Module-level counter keeps IDs unique across game restarts within a session,
// so a new disc never accidentally shares an ID with a disc from a previous game
// that the animation system might still be referencing.
let _nextId = 0;

export function makeDisc(value: number, kind: DiscKind): Disc {
  return { id: _nextId++, value, kind };
}

export interface DiscSpawnConfig {
  valueMin: number;
  valueMax: number;
  /** Chance of Numbered vs. DoubleCracked — inverse of the generation rules' unnumbered probability. */
  probNumbered: number;
}

// Fallback spawn config for makeRandomDisc/makeCrackedDisc when called without
// an explicit config (e.g. ad hoc/test disc creation). The real in-game queue
// goes through PlayableDiscGenerator + createDiscFactories using the active
// mode's own discValueMin/Max and unnumberedProbabilityForLevel instead.
const CLASSIC_SPAWN: DiscSpawnConfig = {
  valueMin: 1,
  valueMax: 7,
  probNumbered: 0.70,
};

function randomValue(spawn: DiscSpawnConfig, random: RandomSource = Math.random): number {
  return spawn.valueMin + Math.floor(random() * (spawn.valueMax - spawn.valueMin + 1));
}

export function makeRandomDisc(spawn: DiscSpawnConfig = CLASSIC_SPAWN, random: RandomSource = Math.random): Disc {
  const value = randomValue(spawn, random);
  const r = random();
  const kind = r < spawn.probNumbered ? DiscKind.Numbered : DiscKind.DoubleCracked;
  return makeDisc(value, kind);
}

/**
 * Creates a DoubleCracked disc.
 *
 * @remarks
 * Used for row pushes, where a Numbered disc could trigger an unearned chain
 * clear. SingleCracked is never spawned directly — only a DoubleCracked
 * degrading via an adjacent clear produces one.
 */
export function makeCrackedDisc(spawn: DiscSpawnConfig = CLASSIC_SPAWN): Disc {
  return makeCrackedDiscWithRandom(spawn, Math.random);
}

function makeCrackedDiscWithRandom(spawn: DiscSpawnConfig, random: RandomSource): Disc {
  const value = randomValue(spawn, random);
  return makeDisc(value, DiscKind.DoubleCracked);
}

export type DiscFactory = () => Disc;
export type LevelDiscFactory = (level: number, board: Board) => Disc;

export interface PlayableDiscGeneratorSnapshot {
  recentValues: number[];
  recentKinds: DiscKind[];
}

export interface QueuedDiscSnapshot {
  value: number;
  kind: DiscKind;
}

export type DiscQueueSnapshot = readonly [QueuedDiscSnapshot, QueuedDiscSnapshot, QueuedDiscSnapshot];

function trailingRun<T>(history: readonly T[], value: T): number {
  let length = 0;
  for (let index = history.length - 1; index >= 0 && history[index] === value; index--) length++;
  return length;
}

function weightedChoice<T>(candidates: readonly T[], weights: readonly number[], random: RandomSource): T {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (let index = 0; index < candidates.length; index++) {
    roll -= weights[index]!;
    if (roll < 0) return candidates[index]!;
  }
  return candidates.at(-1)!;
}

// Standalone chain-clear simulation used only to evaluate "would dealing this
// value let the board resolve to fully empty right now" during generation.
// Reimplements the small fixed-point loop shape resolveClearSteps
// (physics.ts) already has, rather than importing it — physics.ts imports
// from this module, so the reverse import would be circular.
function resolvesToEmptyBoard(rules: GameRulesConfig, board: Board): boolean {
  while (true) {
    const clears: GridPos[] = [];
    for (let row = 0; row < board.length; row++) {
      for (let col = 0; col < board[row]!.length; col++) {
        const disc = board[row]![col];
        if (disc && disc.kind === DiscKind.Numbered
          && rules.clearing.isClearable(board, row, col, disc, 0)) {
          clears.push({ row, col });
        }
      }
    }
    if (clears.length === 0) break;
    for (const pos of clears) removeDisc(board, pos);
    applyGravity(board);
  }
  return isBoardEmpty(board);
}

// True if dropping a fresh Numbered disc of this value into any legal column,
// right now, would resolve (through the normal clear/reveal/gravity chain)
// to a completely empty board.
function wouldEmptyBoardIfDropped(rules: GameRulesConfig, board: Board, value: number): boolean {
  const cols = board[0]?.length ?? 0;
  for (let col = 0; col < cols; col++) {
    const row = landingRow(board, col);
    if (row === null) continue;
    const scratch = cloneBoard(board);
    placeDisc(scratch, row, col, makeDisc(value, DiscKind.Numbered));
    if (resolvesToEmptyBoard(rules, scratch)) return true;
  }
  return false;
}

/** Stateful generation for the player's incoming queue. */
export class PlayableDiscGenerator {
  private readonly values: number[] = [];
  private readonly kinds: DiscKind[] = [];

  constructor(
    private readonly rules: GameRulesConfig,
    private readonly random: RandomSource = () => Math.random(),
  ) {}

  generate(level: number, board: Board = this.emptyBoard()): Disc {
    const value = this.chooseValue(level, board);
    const kind = this.chooseKind(level);
    const historyLimit = Math.max(
      this.rules.generation.valueBalanceWindow,
      this.rules.generation.kindBalanceWindow,
    );
    this.values.push(value);
    this.kinds.push(kind);
    if (this.values.length > historyLimit) this.values.shift();
    if (this.kinds.length > historyLimit) this.kinds.shift();
    return makeDisc(value, kind);
  }

  snapshot(): PlayableDiscGeneratorSnapshot {
    return {
      recentValues: [...this.values],
      recentKinds: [...this.kinds],
    };
  }

  restore(snapshot: PlayableDiscGeneratorSnapshot): void {
    this.values.splice(0, this.values.length, ...snapshot.recentValues);
    this.kinds.splice(0, this.kinds.length, ...snapshot.recentKinds);
  }

  private emptyBoard(): Board {
    return Array.from(
      { length: this.rules.board.rows },
      () => Array(this.rules.board.cols).fill(null),
    );
  }

  private chooseValue(level: number, board: Board): number {
    const config = this.rules.generation;
    const boardAdaptive = config.kind === 'adaptive-history@1';
    const valueCount = config.discValueMax - config.discValueMin + 1;
    const guardActive = boardAdaptive
      && level < config.minLevelForBoardClearBonus;
    let candidates = Array.from(
      { length: valueCount },
      (_, index) => config.discValueMin + index,
    ).filter(value => trailingRun(this.values, value) < config.maxSameValueRun);
    if (guardActive) {
      const safe = candidates.filter(value => !wouldEmptyBoardIfDropped(this.rules, board, value));
      if (safe.length > 0) candidates = safe; // never exhaust the pool entirely
    }
    const recent = this.values.slice(-config.valueBalanceWindow);
    const expected = recent.length / valueCount;
    const pressure = boardAdaptive ? this.boardPressure(board, config) : 0;
    const relevanceRates = boardAdaptive
      ? this.relevanceRates(board, candidates)
      : new Map(candidates.map(value => [value, 0]));
    const valueRange = config.discValueMax - config.discValueMin;
    const weights = candidates.map(value => {
      const count = recent.filter(item => item === value).length;
      const historyWeight = Math.max(0.1, 1 + config.valueBalanceStrength * (expected - count));
      const normalizedValue = valueRange === 0 ? 0 : (value - config.discValueMin) / valueRange;
      const pressureWeight = boardAdaptive
        ? Math.exp(-config.boardPressureStrength * pressure * normalizedValue)
        : 1;
      const relevanceWeight = boardAdaptive
        ? 1 + config.boardRelevanceStrength * pressure * relevanceRates.get(value)!
        : 1;
      return historyWeight * pressureWeight * relevanceWeight;
    });
    return weightedChoice(candidates, weights, this.random);
  }

  private boardPressure(
    board: Board,
    config: Extract<GenerationRules, { kind: 'adaptive-history@1' }>,
  ): number {
    const cols = board[0]?.length ?? 0;
    let maxColumnHeight = 0;
    for (let col = 0; col < cols; col++) {
      let height = 0;
      for (let row = 0; row < board.length; row++) {
        if (board[row]![col] != null) height++;
      }
      maxColumnHeight = Math.max(maxColumnHeight, height);
    }
    const denominator = this.rules.board.rows - config.boardPressureStartHeight;
    if (denominator <= 0) return maxColumnHeight > config.boardPressureStartHeight ? 1 : 0;
    return Math.max(0, Math.min(1,
      (maxColumnHeight - config.boardPressureStartHeight) / denominator,
    ));
  }

  private relevanceRates(board: Board, candidates: readonly number[]): Map<number, number> {
    const matches = new Map(candidates.map(value => [value, 0]));
    const cols = board[0]?.length ?? 0;
    let legalColumns = 0;

    for (let col = 0; col < cols; col++) {
      let landingRow: number | null = null;
      for (let row = board.length - 1; row >= 0; row--) {
        if (board[row]![col] == null) {
          landingRow = row;
          break;
        }
      }
      if (landingRow == null) continue;
      legalColumns++;

      const horizontal = this.projectedRun(board, landingRow, col, 0, 1);
      const vertical = this.projectedRun(board, landingRow, col, 1, 0);
      for (const value of candidates) {
        if (horizontal === value || vertical === value) matches.set(value, matches.get(value)! + 1);
      }
    }

    if (legalColumns === 0) return new Map(candidates.map(value => [value, 0]));
    return new Map(candidates.map(value => [value, matches.get(value)! / legalColumns]));
  }

  private projectedRun(board: Board, row: number, col: number, dr: number, dc: number): number {
    let length = 1;
    for (const direction of [-1, 1]) {
      let r = row + dr * direction;
      let c = col + dc * direction;
      while (r >= 0 && r < board.length && c >= 0 && c < (board[r]?.length ?? 0) && board[r]![c] != null) {
        length++;
        r += dr * direction;
        c += dc * direction;
      }
    }
    return length;
  }

  private chooseKind(level: number): DiscKind {
    const config = this.rules.generation;
    const target = 1 - unnumberedProbabilityForLevel(config, level);
    // A mode can explicitly opt out of player-dropped hazards. Respect that
    // even when the normal variety cap would otherwise force one.
    if (target >= 1) return DiscKind.Numbered;
    const numberedRun = trailingRun(this.kinds, DiscKind.Numbered);
    const crackedRun = trailingRun(this.kinds, DiscKind.DoubleCracked);
    if (numberedRun >= config.maxNumberedRun) return DiscKind.DoubleCracked;
    if (crackedRun >= config.maxCrackedRun) return DiscKind.Numbered;

    const recent = this.kinds.slice(-config.kindBalanceWindow);
    const observed = recent.length === 0
      ? target
      : recent.filter(kind => kind === DiscKind.Numbered).length / recent.length;
    const probability = Math.max(0, Math.min(1, target + config.kindBalanceStrength * (target - observed)));
    return this.random() < probability ? DiscKind.Numbered : DiscKind.DoubleCracked;
  }
}

/** Builds the DiscFactory closures a GameEngine needs from a mode's spawn config. */
export function createDiscFactories(
  rules: GameRulesConfig,
  playableRandom: RandomSource = () => Math.random(),
  pushRandom: RandomSource = () => Math.random(),
): { discFactory: LevelDiscFactory; crackedDiscFactory: DiscFactory; playableGenerator: PlayableDiscGenerator } {
  const spawnForLevel = (level: number): DiscSpawnConfig => ({
    valueMin: rules.generation.discValueMin,
    valueMax: rules.generation.discValueMax,
    probNumbered: 1 - unnumberedProbabilityForLevel(rules.generation, level),
  });
  const playable = new PlayableDiscGenerator(rules, playableRandom);
  return {
    discFactory: (level, board) => playable.generate(level, board),
    crackedDiscFactory: () => makeCrackedDiscWithRandom(spawnForLevel(1), pushRandom),
    playableGenerator: playable,
  };
}

export class DiscQueue {
  private q: Disc[];
  private readonly factory: LevelDiscFactory;

  // Pre-fill three discs: index 0 is the current disc, index 1 is "next",
  // and index 2 ensures advance() can always append without leaving the queue
  // shorter than two visible entries mid-turn.
  constructor(factory: LevelDiscFactory, level: number, board: Board) {
    this.factory = factory;
    this.q = [this.factory(level, board), this.factory(level, board), this.factory(level, board)];
  }

  peek(): Disc {
    return this.q[0]!;
  }

  peekNext(): Disc {
    return this.q[1]!;
  }

  // Removes the head disc, appends a fresh random disc at the tail, and
  // returns the removed disc. Callers should call peek() before advance()
  // if they need the disc reference — advance() invalidates the old index 0.
  advance(level: number, board: Board): Disc {
    const head = this.q.shift()!;
    this.q.push(this.factory(level, board));
    return head;
  }

  snapshot(): DiscQueueSnapshot {
    const [current, next, hidden] = this.q;
    return [
      { value: current!.value, kind: current!.kind },
      { value: next!.value, kind: next!.kind },
      { value: hidden!.value, kind: hidden!.kind },
    ];
  }

  restore(snapshot: readonly QueuedDiscSnapshot[]): void {
    if (snapshot.length !== 3) throw new Error('DiscQueue restore requires exactly three discs');
    this.q = snapshot.map(({ value, kind }) => makeDisc(value, kind));
  }

  reset(level: number, board: Board): void {
    this.q = [this.factory(level, board), this.factory(level, board), this.factory(level, board)];
  }
}
