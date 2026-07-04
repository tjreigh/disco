import type { Disc } from './model.js';
import { DiscKind } from './model.js';
import type { GameModeConfig } from './modes/mode.js';
import { unnumberedProbabilityForLevel } from './modes/mode.js';

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
  probNumbered: number;
}

const CLASSIC_SPAWN: DiscSpawnConfig = {
  valueMin: 1,
  valueMax: 7,
  probNumbered: 0.70,
};

function randomValue(spawn: DiscSpawnConfig): number {
  return spawn.valueMin + Math.floor(Math.random() * (spawn.valueMax - spawn.valueMin + 1));
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
  const value = randomValue(spawn);
  return makeDisc(value, DiscKind.DoubleCracked);
}

export type DiscFactory = () => Disc;
export type LevelDiscFactory = (level: number) => Disc;

// Builds the DiscFactory closures a GameEngine needs from a mode's spawn config.
export function createDiscFactories(mode: GameModeConfig): { discFactory: LevelDiscFactory; crackedDiscFactory: DiscFactory } {
  const spawnForLevel = (level: number): DiscSpawnConfig => ({
    valueMin: mode.discValueMin,
    valueMax: mode.discValueMax,
    probNumbered: 1 - unnumberedProbabilityForLevel(mode, level),
  });
  return {
    discFactory: level => makeRandomDisc(spawnForLevel(level)),
    crackedDiscFactory: () => makeCrackedDisc(spawnForLevel(1)),
  };
}

export class DiscQueue {
  private q: Disc[];
  private readonly factory: LevelDiscFactory;

  // Pre-fill three discs: index 0 is the current disc, index 1 is "next",
  // and index 2 ensures advance() can always append without leaving the queue
  // shorter than two visible entries mid-turn.
  constructor(factory: LevelDiscFactory = () => makeRandomDisc(), level = 1) {
    this.factory = factory;
    this.q = [this.factory(level), this.factory(level), this.factory(level)];
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
  advance(level = 1): Disc {
    const head = this.q.shift()!;
    this.q.push(this.factory(level));
    return head;
  }

  reset(level = 1): void {
    this.q = [this.factory(level), this.factory(level), this.factory(level)];
  }
}
