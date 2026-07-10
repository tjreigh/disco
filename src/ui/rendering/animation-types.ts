import type { Disc } from '../../game/model.js';

export enum AnimPhase {
  Dropping = 'dropping',
  Flashing = 'flashing',
  Clearing = 'clearing',
  Falling = 'falling',
  Revealing = 'revealing',
  Pushing = 'pushing',
}

export interface DiscAnimation {
  discId: number;
  phase: AnimPhase;
  startTime: number;
  duration: number;
  fromX: number;
  toX: number;
  fromY: number;
  toY: number;
  alpha: number;
  scale: number;
  progress: number;
  // Canvas-space waypoints for a bent (non-straight-line) motion, e.g. a
  // Falling disc that actually routed around obstacles. fromX/Y and toX/Y
  // above always still hold the overall start/end, unchanged, for anything
  // that only cares about the net motion. Present only when there's more
  // than a single straight hop worth animating.
  waypoints?: { x: number; y: number }[];
}

export interface RichDiscAnimation extends DiscAnimation {
  disc: Disc;
}

export interface ScorePopup {
  value: number;
  col: number;
  row: number;
  startTime: number;
  duration: number;
  progress: number;
  alpha: number;
  yOffset: number;
}

export interface ScoreIndicator {
  title: string;
  detail: string;
  startTime: number;
  duration: number;
  progress: number;
  alpha: number;
  scale: number;
}
