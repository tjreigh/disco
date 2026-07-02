import { Disc, DiscKind } from './types.js';
import { PROB_NUMBERED, PROB_SINGLE_CRACKED } from './constants.js';

// Module-level counter keeps IDs unique across game restarts within a session,
// so a new disc never accidentally shares an ID with a disc from a previous game
// that the animation system might still be referencing.
let _nextId = 0;

export function makeDisc(value: number, kind: DiscKind): Disc {
  return { id: _nextId++, value, kind };
}

export function makeRandomDisc(): Disc {
  const value = Math.floor(Math.random() * 7) + 1;
  const r = Math.random();
  const kind =
    r < PROB_NUMBERED       ? DiscKind.Numbered :
    r < PROB_SINGLE_CRACKED ? DiscKind.SingleCracked :
                              DiscKind.DoubleCracked;
  return makeDisc(value, kind);
}

// Always produces a cracked disc — used for row pushes where every incoming
// disc should require reveals before it can clear. Numbered discs in a push
// row could trigger immediate chain clears, which would feel unearned.
export function makeCrackedDisc(): Disc {
  const value = Math.floor(Math.random() * 7) + 1;
  const kind = Math.random() < 0.5 ? DiscKind.SingleCracked : DiscKind.DoubleCracked;
  return makeDisc(value, kind);
}

export type DiscFactory = () => Disc;

export class DiscQueue {
  private q: Disc[];
  private readonly factory: DiscFactory;

  // Pre-fill three discs: index 0 is the current disc, index 1 is "next",
  // and index 2 ensures advance() can always append without leaving the queue
  // shorter than two visible entries mid-turn.
  constructor(factory: DiscFactory = makeRandomDisc) {
    this.factory = factory;
    this.q = [this.factory(), this.factory(), this.factory()];
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
  advance(): Disc {
    const head = this.q.shift()!;
    this.q.push(this.factory());
    return head;
  }

  reset(): void {
    this.q = [this.factory(), this.factory(), this.factory()];
  }
}
