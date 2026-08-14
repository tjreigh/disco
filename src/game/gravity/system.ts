import { deepCloneBoard, placeDisc } from '../board.js';
import type { Disc } from '../model.js';
import type { Board, GridPos } from '../model.js';
import type { GameRulesConfig } from '../modes/mode.js';
import type { PhysicsTrace, SettleFn } from '../physics.js';
import type { GameState, GravityState } from '../state.js';
import { GamePhase } from '../state.js';
import type { PhysicsStep } from '../events.js';
import { computeGravityDropSteps } from './physics.js';
import {
  entryEdgeForAngle, entryPositionForLane, isLaneFull, settleContinuous,
  snapAngleToEightDirections,
} from './settling.js';
import type { RejectedTurnReason } from '../turn-types.js';

export type GravityCommitResult =
  | { accepted: false; reason: RejectedTurnReason }
  | { accepted: true; steps: PhysicsStep[] };

export interface GravityResolutionContext {
  angleDeg: number;
  settle?: SettleFn;
}

/** Owns Gravity's staged-drop interaction and angle-aware turn preparation. */
export class GravitySystem {
  private rules: GameRulesConfig;

  constructor(rules: GameRulesConfig) {
    this.rules = rules;
  }

  get enabled(): boolean {
    return this.rules.placement.kind === 'stage-and-tilt@1';
  }

  reconfigure(rules: GameRulesConfig): void {
    this.rules = rules;
  }

  initialState(): GravityState | undefined {
    const placement = this.rules.placement;
    if (placement.kind !== 'stage-and-tilt@1') return undefined;
    return {
      angle: placement.initialAngleDeg,
      turnStartAngle: placement.initialAngleDeg,
      maxTiltDelta: placement.maxTiltDeltaDeg,
    };
  }

  restoredState(angle: number | undefined): GravityState | undefined {
    const placement = this.rules.placement;
    if (angle === undefined || placement.kind !== 'stage-and-tilt@1') return undefined;
    return {
      angle,
      turnStartAngle: angle,
      maxTiltDelta: placement.maxTiltDeltaDeg,
    };
  }

  laneCount(board: Board, gravity: GravityState | undefined): number {
    if (gravity) {
      const entryEdge = entryEdgeForAngle(gravity.angle);
      if (entryEdge === 'left' || entryEdge === 'right') return board.length;
    }
    return board[0]!.length;
  }

  stageDrop(state: GameState, lane: number): RejectedTurnReason | undefined {
    if (!this.enabled || !state.gravity) return 'wrong-phase';
    if (state.phase === GamePhase.GameOver) return 'game-over';
    if (state.phase !== GamePhase.WaitingForDrop) return 'wrong-phase';

    const entryEdge = entryEdgeForAngle(state.gravity.angle);
    if (!Number.isInteger(lane) || lane < 0 || lane >= this.laneCount(state.board, state.gravity)) {
      return 'invalid-column';
    }
    if (isLaneFull(state.board, lane, entryEdge)) return 'full-column';

    state.cursorCol = lane;
    state.gravity.turnStartAngle = state.gravity.angle;
    state.gravity.pendingLane = lane;
    state.phase = GamePhase.Aiming;
    return undefined;
  }

  tilt(state: GameState, delta: number): void {
    const gravity = state.gravity;
    if (!gravity || state.phase !== GamePhase.Aiming || gravity.pendingLane === undefined) return;

    const min = gravity.turnStartAngle - gravity.maxTiltDelta;
    const max = gravity.turnStartAngle + gravity.maxTiltDelta;
    gravity.angle = Math.max(min, Math.min(max, gravity.angle + delta));
  }

  previewSettledBoard(state: GameState, disc: Disc): Board {
    const scratch = deepCloneBoard(state.board);
    const gravity = state.gravity;
    if (gravity?.pendingLane !== undefined) {
      const entryEdge = entryEdgeForAngle(gravity.turnStartAngle);
      const rows = scratch.length;
      const cols = scratch[0]!.length;
      const entryPos = entryPositionForLane(entryEdge, gravity.pendingLane, rows, cols);
      placeDisc(scratch, entryPos.row, entryPos.col, disc);
    }
    if (gravity) settleContinuous(scratch, snapAngleToEightDirections(gravity.angle));
    return scratch;
  }

  previewDropLanding(state: GameState, lane: number, disc: Disc): GridPos | null {
    const gravity = state.gravity;
    if (!this.enabled || !gravity) return null;
    const staged = gravity.pendingLane !== undefined;
    const selectedLane = gravity.pendingLane ?? lane;
    const entryEdge = entryEdgeForAngle(staged ? gravity.turnStartAngle : gravity.angle);
    if (isLaneFull(state.board, selectedLane, entryEdge)) return null;

    const rows = state.board.length;
    const cols = state.board[0]!.length;
    const scratch = deepCloneBoard(state.board);
    const onEntryPos = entryPositionForLane(entryEdge, selectedLane, rows, cols);
    placeDisc(scratch, onEntryPos.row, onEntryPos.col, disc);

    const result = settleContinuous(scratch, gravity.angle);
    const move = result.moves.find(candidate => candidate.disc.id === disc.id);
    return move ? move.to : onEntryPos;
  }

  cancelTilt(state: GameState): void {
    if (state.phase !== GamePhase.Aiming || !state.gravity) return;
    state.gravity.angle = state.gravity.turnStartAngle;
    delete state.gravity.pendingLane;
    state.phase = GamePhase.WaitingForDrop;
  }

  prepareTiltCommit(state: GameState, disc: Disc, trace: PhysicsTrace): GravityCommitResult {
    if (state.phase === GamePhase.GameOver) return { accepted: false, reason: 'game-over' };
    if (state.phase !== GamePhase.Aiming || !state.gravity || state.gravity.pendingLane === undefined) {
      return { accepted: false, reason: 'wrong-phase' };
    }

    const snappedAngle = snapAngleToEightDirections(state.gravity.angle);
    if (snappedAngle === snapAngleToEightDirections(state.gravity.turnStartAngle)) {
      return { accepted: false, reason: 'tilt-required' };
    }
    const entryEdge = entryEdgeForAngle(state.gravity.turnStartAngle);
    const lane = state.gravity.pendingLane;
    state.gravity.angle = snappedAngle;
    delete state.gravity.pendingLane;

    const newEdge = entryEdgeForAngle(snappedAngle);
    const axisFlipped = (entryEdge === 'left' || entryEdge === 'right')
      !== (newEdge === 'left' || newEdge === 'right');
    if (axisFlipped) {
      state.cursorCol = Math.floor(this.laneCount(state.board, state.gravity) / 2);
    }

    const steps = computeGravityDropSteps(
      state.board,
      disc,
      lane,
      entryEdge,
      snappedAngle,
      this.rules,
      trace,
    );
    return { accepted: true, steps };
  }

  resolutionContext(gravity: GravityState | undefined): GravityResolutionContext {
    if (!gravity) return { angleDeg: 0 };
    const angleDeg = gravity.angle;
    return { angleDeg, settle: board => settleContinuous(board, angleDeg) };
  }
}
