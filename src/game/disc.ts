import type { Board, Disc } from './model.js';
import { DiscKind } from './model.js';
import type { GameModeConfig } from './modes/mode.js';
import { unnumberedProbabilityForLevel } from './modes/mode.js';
import type { RandomSource } from './random.js';

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
  /** Chance of Numbered vs. DoubleCracked — inverse of GameModeConfig's unnumbered probability. Only consulted by makeRandomDisc; makeCrackedDisc/makeCrackedDiscWithRandom ignore it and always produce DoubleCracked. */
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

export function makeRandomDisc(spawn: DiscSpawnConfig = CLASSIC_SPAWN): Disc {
  const value = randomValue(spawn);
  const r = Math.random();
  const kind = r < spawn.probNumbered ? DiscKind.Numbered : DiscKind.DoubleCracked;
  return makeDisc(value, kind);
}

// Always produces a DoubleCracked disc — used for row pushes where every
// incoming disc should require reveals before it can clear. Numbered discs in
// a push row could trigger immediate chain clears, which would feel unearned.
// SingleCracked is never spawned directly; it only exists as the result of a
// DoubleCracked disc degrading once from an adjacent clear.
export function makeCrackedDisc(spawn: DiscSpawnConfig = CLASSIC_SPAWN): Disc {
  return makeCrackedDiscWithRandom(spawn, Math.random);
}

function makeCrackedDiscWithRandom(spawn: DiscSpawnConfig, random: RandomSource): Disc {
  const value = randomValue(spawn, random);
  return makeDisc(value, DiscKind.DoubleCracked);
}

export type DiscFactory = () => Disc;
export type LevelDiscFactory = (level: number, board: Board) => Disc;

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

/** Stateful generation for the player's incoming queue. */
export class PlayableDiscGenerator {
  private readonly values: number[] = [];
  private readonly kinds: DiscKind[] = [];

  constructor(private readonly mode: GameModeConfig, private readonly random: RandomSource = () => Math.random()) {}

  generate(level: number, board: Board = this.emptyBoard()): Disc {
    const value = this.chooseValue(board);
    const kind = this.chooseKind(level);
    const historyLimit = Math.max(this.mode.discGeneration.valueBalanceWindow, this.mode.discGeneration.kindBalanceWindow);
    this.values.push(value);
    this.kinds.push(kind);
    if (this.values.length > historyLimit) this.values.shift();
    if (this.kinds.length > historyLimit) this.kinds.shift();
    return makeDisc(value, kind);
  }

  private emptyBoard(): Board {
    return Array.from(
      { length: this.mode.board.rows },
      () => Array(this.mode.board.cols).fill(null),
    );
  }

  private chooseValue(board: Board): number {
    const config = this.mode.discGeneration;
    const valueCount = this.mode.discValueMax - this.mode.discValueMin + 1;
    const candidates = Array.from(
      { length: valueCount },
      (_, index) => this.mode.discValueMin + index,
    ).filter(value => trailingRun(this.values, value) < config.maxSameValueRun);
    const recent = this.values.slice(-config.valueBalanceWindow);
    const expected = recent.length / valueCount;
    const pressure = this.boardPressure(board);
    const relevanceRates = this.relevanceRates(board, candidates);
    const valueRange = this.mode.discValueMax - this.mode.discValueMin;
    const weights = candidates.map(value => {
      const count = recent.filter(item => item === value).length;
      const historyWeight = Math.max(0.1, 1 + config.valueBalanceStrength * (expected - count));
      const normalizedValue = valueRange === 0 ? 0 : (value - this.mode.discValueMin) / valueRange;
      const pressureWeight = Math.exp(-config.boardPressureStrength * pressure * normalizedValue);
      const relevanceWeight = 1 + config.boardRelevanceStrength * pressure * relevanceRates.get(value)!;
      return historyWeight * pressureWeight * relevanceWeight;
    });
    return weightedChoice(candidates, weights, this.random);
  }

  private boardPressure(board: Board): number {
    const config = this.mode.discGeneration;
    const cols = board[0]?.length ?? 0;
    let maxColumnHeight = 0;
    for (let col = 0; col < cols; col++) {
      let height = 0;
      for (let row = 0; row < board.length; row++) {
        if (board[row]![col] != null) height++;
      }
      maxColumnHeight = Math.max(maxColumnHeight, height);
    }
    const denominator = this.mode.board.rows - config.boardPressureStartHeight;
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
    const config = this.mode.discGeneration;
    const numberedRun = trailingRun(this.kinds, DiscKind.Numbered);
    const crackedRun = trailingRun(this.kinds, DiscKind.DoubleCracked);
    if (numberedRun >= config.maxNumberedRun) return DiscKind.DoubleCracked;
    if (crackedRun >= config.maxCrackedRun) return DiscKind.Numbered;

    const target = 1 - unnumberedProbabilityForLevel(this.mode, level);
    const recent = this.kinds.slice(-config.kindBalanceWindow);
    const observed = recent.length === 0
      ? target
      : recent.filter(kind => kind === DiscKind.Numbered).length / recent.length;
    const probability = Math.max(0, Math.min(1, target + config.kindBalanceStrength * (target - observed)));
    return this.random() < probability ? DiscKind.Numbered : DiscKind.DoubleCracked;
  }
}

// Builds the DiscFactory closures a GameEngine needs from a mode's spawn config.
export function createDiscFactories(
  mode: GameModeConfig,
  playableRandom: RandomSource = () => Math.random(),
  pushRandom: RandomSource = () => Math.random(),
): { discFactory: LevelDiscFactory; crackedDiscFactory: DiscFactory } {
  const spawnForLevel = (level: number): DiscSpawnConfig => ({
    valueMin: mode.discValueMin,
    valueMax: mode.discValueMax,
    probNumbered: 1 - unnumberedProbabilityForLevel(mode, level),
  });
  const playable = new PlayableDiscGenerator(mode, playableRandom);
  return {
    discFactory: (level, board) => playable.generate(level, board),
    crackedDiscFactory: () => makeCrackedDiscWithRandom(spawnForLevel(1), pushRandom),
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

  reset(level: number, board: Board): void {
    this.q = [this.factory(level, board), this.factory(level, board), this.factory(level, board)];
  }
}
