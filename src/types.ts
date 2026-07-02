// const enum values are inlined by tsc — no runtime object is emitted.
export const enum DiscKind {
  Numbered      = 'numbered',
  SingleCracked = 'single-cracked',
  DoubleCracked = 'double-cracked',
}

export interface Disc {
  readonly id: number; // monotonically increasing; unique across restarts within a session
  value: number;
  kind: DiscKind;      // mutable — applyCrackUpdates upgrades cracked discs in-place
}

// null means empty cell; undefined is never a valid cell value (board is always fully initialized).
export type Cell = Disc | null;

/** [row][col], row 0 = top, row 6 = bottom */
export type Board = Cell[][];

export interface GridPos {
  row: number;
  col: number;
}

// ---------------------------------------------------------------------------
// Physics steps
//
// Physics runs synchronously the moment a disc is dropped, producing the
// complete final board state and an ordered list of PhysicsSteps. The game
// then replays these steps as animations. This keeps logic and visuals in
// sync: the board is already settled before the first animation frame fires.
// ---------------------------------------------------------------------------

export const enum StepKind {
  Drop   = 'drop',
  Clear  = 'clear',
  Fall   = 'fall',
  Reveal = 'reveal',
  Push   = 'push',
}

export interface DropStep {
  kind: StepKind.Drop;
  disc: Disc;
  col: number;
  toLandRow: number;
}

export interface ClearStep {
  kind: StepKind.Clear;
  cleared: GridPos[];
  // Disc value snapshots captured before removal so later synchronous physics
  // cannot rewrite an earlier playback event.
  discs: Disc[];
  chainLevel: number;
  pointsAwarded: number;
}

export interface FallStep {
  kind: StepKind.Fall;
  moves: Array<{ from: GridPos; to: GridPos; disc: Disc }>;
}

export interface RevealStep {
  kind: StepKind.Reveal;
  positions: GridPos[];
  // Disc value snapshots after this specific kind upgrade, captured so a later
  // upgrade in the same turn cannot rewrite this playback event.
  discs: Disc[];
}

export interface PushStep {
  kind: StepKind.Push;
  newRow: Disc[];
}

export type PhysicsStep = DropStep | ClearStep | FallStep | RevealStep | PushStep;

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

export const enum AnimPhase {
  Dropping  = 'dropping',
  Flashing  = 'flashing', // pre-clear pulse; transitions to Clearing at FLASH_MS
  Clearing  = 'clearing',
  Falling   = 'falling',
  Revealing = 'revealing',
  Pushing   = 'pushing',
}

export interface DiscAnimation {
  discId: number;
  phase: AnimPhase;
  startTime: number; // DOMHighResTimeStamp of when this phase began
  duration: number;  // ms for this phase (Flashing uses FLASH_MS + CLEAR_MS combined)
  fromY: number;
  toY: number;
  alpha: number;     // written each frame by AnimationQueue.updateAnimProps
  scale: number;
  progress: number;  // 0..1, clamped; driven by elapsed / duration
}

// ---------------------------------------------------------------------------
// Game state machine
// ---------------------------------------------------------------------------

export const enum GamePhase {
  WaitingForDrop = 'waiting',
  Animating      = 'animating', // covers the entire animation playback of one drop + all chains
  GameOver       = 'game-over',
}

export interface GameState {
  phase: GamePhase;
  board: Board;
  currentDisc: Disc;
  nextDisc: Disc;
  cursorCol: number;
  score: number;
  dropCount: number;
  level: number;
}

// ---------------------------------------------------------------------------
// RichDiscAnimation
//
// Extends DiscAnimation with disc + col references needed by the renderer.
// These are kept separate from DiscAnimation so that the base animation type
// has no dependency on Disc (which would couple animation.ts to game types
// more tightly than necessary).
// ---------------------------------------------------------------------------
export interface RichDiscAnimation extends DiscAnimation {
  disc: Disc;
  col: number;
}
