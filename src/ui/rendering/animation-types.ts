import type { Disc } from '../../game/model.js';

export const enum AnimPhase {
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
  fromY: number;
  toY: number;
  alpha: number;
  scale: number;
  progress: number;
}

export interface RichDiscAnimation extends DiscAnimation {
  disc: Disc;
  col: number;
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
