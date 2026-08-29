// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Renderer } from '../../ui/rendering/renderer.js';
import type { RewindVisualState, TutorialVisualState } from '../../ui/rendering/renderer.js';
import { GamePhase } from '../../game/state.js';
import type { GameState, GravityState } from '../../game/state.js';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import type { Board } from '../../game/model.js';
import {
  cellCenterX, cellCenterY, canvasLogicalWidth, canvasLogicalHeight,
  gridOriginX, gridOriginY, gridW, gridH, cellSize, setGridSize,
} from '../../ui/rendering/layout.js';
import {
  COLOR_COL_HOVER, COLOR_GAMEOVER_BG, COLOR_GRAVITY_LANE,
} from '../../ui/rendering/theme.js';
import type { GameStats } from '../../game/stats.js';
import { AnimPhase } from '../../ui/rendering/animation-types.js';
import type { RichDiscAnimation } from '../../ui/rendering/animation-types.js';

// ─── Fake canvas context ─────────────────────────────────────────────────────
// A real <canvas> 2D context isn't available under happy-dom, and pixel-level
// assertions would be brittle anyway. Instead this records every drawing call
// (method + args), snapshotting fillStyle/strokeStyle at call time, so tests
// can assert on *what the renderer decided to draw and where* — the actual
// logic/branching — without needing real rasterization.

interface RecordedCall {
  method: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: unknown;
  globalAlpha: unknown;
}

interface FakeContext {
  calls: RecordedCall[];
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  shadowColor: string;
  shadowBlur: number;
  [method: string]: unknown;
}

function makeFakeContext(): FakeContext {
  const calls: RecordedCall[] = [];
  const ctx = {
    calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: '', shadowBlur: 0,
  } as FakeContext;

  const record = (method: string) => (...args: unknown[]): void => {
    calls.push({
      method, args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle,
      lineWidth: ctx.lineWidth, globalAlpha: ctx.globalAlpha,
    });
  };

  for (const method of [
    'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'arc', 'roundRect', 'stroke', 'fill', 'fillText',
    'save', 'restore', 'translate', 'scale', 'setTransform', 'setLineDash',
  ]) {
    ctx[method] = record(method);
  }
  ctx.createLinearGradient = () => ({ addColorStop: () => {} });
  ctx.createRadialGradient = () => ({ addColorStop: () => {} });
  ctx.measureText = () => ({ width: 0 });

  return ctx;
}

function makeCanvas(ctx: FakeContext): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  (canvas as unknown as { getContext: () => FakeContext }).getContext = () => ctx;
  return canvas;
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    generationSeed: 1,
    generationSource: 'seeded',
    phase: GamePhase.WaitingForDrop,
    board: makeEmptyBoard(),
    currentDisc: makeDisc(3, DiscKind.Numbered),
    nextDisc: makeDisc(4, DiscKind.Numbered),
    cursorCol: 3,
    score: 0,
    dropCount: 0,
    level: 1,
    turnsPerLevel: 30,
    turnsRemaining: 30,
    breaksThisLevel: 0,
    entropy: 0,
    balancedLevels: 0,
    ...overrides,
  };
}

function makeGravity(overrides: Partial<GravityState> = {}): GravityState {
  return { angle: 0, turnStartAngle: 0, maxTiltDelta: 90, ...overrides };
}

function makeStats(overrides: Partial<GameStats> = {}): GameStats {
  return {
    highScore: 0, longestStreak: 0, averageScore: 0, gamesPlayed: 0, totalScore: 0,
    totalPlayTimeMs: 0, totalDiscsDropped: 0, totalDiscsBroken: 0, ...overrides,
  };
}

// draw()'s optional trailing params, always passed explicitly for clarity.
function callDraw(
  renderer: Renderer,
  state: GameState,
  board: Board = state.board,
  opts: {
    previewLanding?: { row: number; col: number } | null;
    tutorial?: TutorialVisualState | null;
    animations?: readonly RichDiscAnimation[];
    rewind?: RewindVisualState | null;
  } = {},
): void {
  renderer.draw(
    state, board, opts.animations ?? [], makeStats(), [], [],
    opts.tutorial ?? null, opts.previewLanding ?? null, false, null, opts.rewind ?? null,
  );
}

let ctx: FakeContext;
let canvas: HTMLCanvasElement;
let renderer: Renderer;

beforeEach(() => {
  setViewport(900, 1100); // generous enough that a 7x7 board sits at MAX_CELL_SIZE
  setGridSize(7, 7);
  ctx = makeFakeContext();
  canvas = makeCanvas(ctx);
  renderer = new Renderer(canvas);
});

// ─── resize() ─────────────────────────────────────────────────────────────────

describe('resize', () => {
  test('sizes the canvas backing store to the logical size scaled by DPR', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    renderer.resize();

    const lw = canvasLogicalWidth();
    const lh = canvasLogicalHeight();
    expect(canvas.width).toBe(Math.round(lw * 2));
    expect(canvas.height).toBe(Math.round(lh * 2));
    expect(canvas.style.width).toBe(`${lw}px`);
    expect(canvas.style.height).toBe(`${lh}px`);

    const lastTransform = [...ctx.calls].reverse().find(c => c.method === 'setTransform');
    expect(lastTransform?.args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  test('publishes canvas and board dimensions for the DOM HUD overlay', () => {
    const localCtx = makeFakeContext();
    const localCanvas = makeCanvas(localCtx);
    const stage = document.createElement('div');
    // clientWidth/clientHeight (not getBoundingClientRect) is what resize()
    // measures, deliberately — see the comment in renderer.ts — since it
    // stays accurate even when a CSS zoom transform is applied to the stage.
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 375 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 667 });
    stage.append(localCanvas);
    document.body.append(stage);

    new Renderer(localCanvas);

    expect(stage.style.getPropertyValue('--game-canvas-width')).toBe(`${canvasLogicalWidth()}px`);
    expect(stage.style.getPropertyValue('--game-canvas-height')).toBe(`${canvasLogicalHeight()}px`);
    expect(stage.style.getPropertyValue('--game-grid-width')).toBe(`${gridW()}px`);
  });

  test('refreshes HUD geometry variables after the stage is resized', () => {
    const localCtx = makeFakeContext();
    const localCanvas = makeCanvas(localCtx);
    const stage = document.createElement('div');
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 393 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 852 });
    stage.append(localCanvas);
    document.body.append(stage);
    const localRenderer = new Renderer(localCanvas);
    const first = stage.style.getPropertyValue('--game-canvas-width');

    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 375 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 667 });
    localRenderer.resize();

    expect(stage.style.getPropertyValue('--game-canvas-width')).not.toBe(first);
    expect(stage.style.getPropertyValue('--game-grid-width')).toBe(`${gridW()}px`);
    expect(Number.parseFloat(stage.style.getPropertyValue('--game-grid-width')))
      .toBeLessThanOrEqual(Number.parseFloat(stage.style.getPropertyValue('--game-canvas-width')));
  });
});

// ─── draw(): phase gating ───────────────────────────────────────────────────

describe('draw phase gating', () => {
  test('Menu phase only clears and paints the background — no grid, no HUD', () => {
    callDraw(renderer, makeState({ phase: GamePhase.Menu }));
    expect(ctx.calls.some(c => c.method === 'roundRect')).toBe(false); // grid cells
    expect(ctx.calls.some(c => c.method === 'arc')).toBe(false); // no discs, no compass, no pips
  });

  test('WaitingForDrop draws exactly one rounded cell per board cell', () => {
    callDraw(renderer, makeState());
    const cellDraws = ctx.calls.filter(c => c.method === 'roundRect');
    expect(cellDraws).toHaveLength(49); // 7x7
  });

  test('GameOver draws the full-canvas overlay; other phases do not', () => {
    callDraw(renderer, makeState({ phase: GamePhase.GameOver }));
    const overlay = ctx.calls.find(c => c.method === 'fillRect' && c.fillStyle === COLOR_GAMEOVER_BG);
    expect(overlay?.args).toEqual([0, 0, canvasLogicalWidth(), canvasLogicalHeight()]);
    expect(ctx.calls.some(c => c.method === 'fillText' && c.args[0] === 'GAME OVER')).toBe(true);

    ctx.calls.length = 0;
    callDraw(renderer, makeState({ phase: GamePhase.WaitingForDrop }));
    expect(ctx.calls.some(c => c.method === 'fillRect' && c.fillStyle === COLOR_GAMEOVER_BG)).toBe(false);
    expect(ctx.calls.some(c => c.method === 'fillText' && c.args[0] === 'GAME OVER')).toBe(false);
  });
});

describe('rewind inspection preview', () => {
  test('keeps the target disc intact, dims other discs, and draws a pending-fracture marker', () => {
    const board = makeEmptyBoard();
    const target = makeDisc(6, DiscKind.Numbered);
    placeDisc(board, 6, 2, target);
    placeDisc(board, 6, 3, makeDisc(4, DiscKind.Numbered));

    callDraw(renderer, makeState({ phase: GamePhase.Animating, board }), board, {
      rewind: {
        targets: [{ position: { row: 6, col: 2 }, resultingKind: DiscKind.SingleCracked }],
      },
    });

    expect(target.kind).toBe(DiscKind.Numbered);
    expect(ctx.calls.some(call => call.globalAlpha === 0.48)).toBe(true);
    expect(ctx.calls.some(call => call.method === 'stroke' && call.strokeStyle === '#e879f9')).toBe(true);
    expect(ctx.calls.some(call => call.method === 'fillText' && call.args[0] === '!')).toBe(true);
  });
});

// ─── Cursor highlight axis ──────────────────────────────────────────────────

describe('cursor highlight axis', () => {
  test('Classic (no gravity): highlights a full-height column at the cursor', () => {
    callDraw(renderer, makeState({ cursorCol: 2 }));
    const highlight = ctx.calls.find(c => c.method === 'fillRect' && c.fillStyle === COLOR_COL_HOVER);
    expect(highlight?.args).toEqual([gridOriginX() + 2 * cellSize(), gridOriginY(), cellSize(), gridH()]);
  });

  test('Gravity mode pointing right (entry from left): highlights a full-width row', () => {
    const state = makeState({ cursorCol: 2, gravity: makeGravity({ angle: 90 }) });
    callDraw(renderer, state);
    const highlight = ctx.calls.find(c => c.method === 'fillRect' && c.fillStyle === COLOR_COL_HOVER);
    // width = gridW(), height = cellSize() — the opposite shape from the column case.
    expect(highlight?.args[2]).toBe(gridW());
    expect(highlight?.args[3]).toBe(cellSize());
  });

  test('during Aiming the staged-lane cursor highlight is hidden, and no full-edge bar is drawn', () => {
    vi.stubGlobal('performance', { now: () => 500 });
    const state = makeState({
      phase: GamePhase.Aiming,
      cursorCol: 4,
      gravity: makeGravity({ angle: 70, turnStartAngle: 0, pendingLane: 4 }),
    });
    callDraw(renderer, state);

    // Cursor lane highlight is NOT drawn during Aiming.
    const cursorHighlight = ctx.calls.some(
      c => c.method === 'fillRect' && c.fillStyle === COLOR_COL_HOVER,
    );
    expect(cursorHighlight).toBe(false);

    // The old Aiming edge bar (a blue fillRect spanning a full grid edge) is
    // gone — the "tilt owed" cue now lives on the tutorial lane highlight,
    // the tilt buttons, the HUD hint, and the compass ring instead.
    const edgeBar = ctx.calls.some(
      c => c.method === 'fillRect'
        && typeof c.fillStyle === 'string'
        && (c.fillStyle as string).startsWith('rgba(98, 176, 232,')
        && (c.args[3] === gridH() || c.args[2] === gridW()),
    );
    expect(edgeBar).toBe(false);
  });
});

// ─── Tutorial lane highlight ────────────────────────────────────────────────
// Green while the player is choosing a lane; once a lane is staged it turns
// blue (gravity accent). While a tilt is still owed the blue variant pulses
// and shows ↺/↻ arrow glyphs at the entry edge; after a committable tilt it
// goes steady and drops the arrows (the remaining action is Confirm).
// The fake gradient records no color stops, so these assert on strokeRect
// colors and fillText glyphs, not the gradient fill.

const GREEN_BRIGHT = 'rgba(129, 230, 177,';
const BLUE_BRIGHT = 'rgba(146, 199, 240,';

function tutorialStroke(calls: readonly RecordedCall[], prefix: string): RecordedCall | undefined {
  return calls.find(
    c => c.method === 'strokeRect'
      && typeof c.strokeStyle === 'string'
      && (c.strokeStyle as string).startsWith(prefix),
  );
}

function arrowCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter(c => c.method === 'fillText' && (c.args[0] === '↺' || c.args[0] === '↻'));
}

describe('tutorial lane highlight', () => {
  beforeEach(() => {
    vi.stubGlobal('performance', { now: () => 500 });
  });

  test('choosing a lane (not staged): green border, no arrows', () => {
    callDraw(renderer, makeState(), undefined, {
      tutorial: { allowedCols: [2], staged: false, needsTilt: false },
    });
    const stroke = tutorialStroke(ctx.calls, GREEN_BRIGHT);
    expect(stroke).toBeTruthy();
    expect(stroke!.args).toEqual([gridOriginX() + 2 * cellSize() + 3, gridOriginY() + 3, cellSize() - 6, gridH() - 6]);
    expect(arrowCalls(ctx.calls)).toHaveLength(0);
    expect(tutorialStroke(ctx.calls, BLUE_BRIGHT)).toBeUndefined();
  });

  test('staged and tilt owed: blue border plus ↺/↻ arrows above the grid, no green', () => {
    const state = makeState({
      phase: GamePhase.Aiming,
      gravity: makeGravity({ angle: 0, turnStartAngle: 0, pendingLane: 2 }),
    });
    callDraw(renderer, state, undefined, {
      tutorial: { allowedCols: [2], staged: true, needsTilt: true },
    });
    expect(tutorialStroke(ctx.calls, BLUE_BRIGHT)).toBeTruthy();
    expect(tutorialStroke(ctx.calls, GREEN_BRIGHT)).toBeUndefined();
    const arrows = arrowCalls(ctx.calls);
    expect(arrows.map(a => a.args[0]).sort()).toEqual(['↺', '↻']);
    for (const arrow of arrows) expect(arrow.args[2] as number).toBeLessThan(gridOriginY());
  });

  test('staged after a valid tilt: tutorial lane and arrows are hidden', () => {
    const state = makeState({
      phase: GamePhase.Aiming,
      gravity: makeGravity({ angle: 45, turnStartAngle: 0, pendingLane: 2 }),
    });
    callDraw(renderer, state, undefined, {
      tutorial: { allowedCols: [2], staged: true, needsTilt: false },
    });
    expect(tutorialStroke(ctx.calls, BLUE_BRIGHT)).toBeUndefined();
    expect(tutorialStroke(ctx.calls, GREEN_BRIGHT)).toBeUndefined();
    expect(arrowCalls(ctx.calls)).toHaveLength(0);
    expect(ctx.calls.find(
      c => c.method === 'arc'
        && typeof c.fillStyle === 'string'
        && (c.fillStyle as string).startsWith(BLUE_BRIGHT),
    )).toBeUndefined();
  });

  test('axis pinning: mid-tilt past 45° the staged lane stays a COLUMN pinned to turnStartAngle', () => {
    const state = makeState({
      phase: GamePhase.Aiming,
      gravity: makeGravity({ angle: 90, turnStartAngle: 0, pendingLane: 3 }),
    });
    callDraw(renderer, state, undefined, {
      tutorial: { allowedCols: [3], staged: true, needsTilt: true },
    });
    const stroke = tutorialStroke(ctx.calls, BLUE_BRIGHT);
    expect(stroke).toBeTruthy();
    // Column shape: full grid height, not full grid width.
    expect(stroke!.args[3]).toBe(gridH() - 6);
    for (const arrow of arrowCalls(ctx.calls)) {
      expect(arrow.args[2] as number).toBeLessThan(gridOriginY());
    }
  });

  test('bottom entry (turnStartAngle 180): column highlight with marker and arrows BELOW the grid', () => {
    const state = makeState({
      phase: GamePhase.Aiming,
      gravity: makeGravity({ angle: 180, turnStartAngle: 180, pendingLane: 3 }),
    });
    callDraw(renderer, state, undefined, {
      tutorial: { allowedCols: [3], staged: true, needsTilt: true },
    });
    const stroke = tutorialStroke(ctx.calls, BLUE_BRIGHT);
    expect(stroke).toBeTruthy();
    expect(stroke!.args[3]).toBe(gridH() - 6); // still a column
    const arrows = arrowCalls(ctx.calls);
    expect(arrows.length).toBe(2);
    for (const arrow of arrows) {
      expect(arrow.args[2] as number).toBeGreaterThan(gridOriginY() + gridH());
    }
    // Entry marker dot sits below the grid too.
    const marker = ctx.calls.find(
      c => c.method === 'arc'
        && typeof c.fillStyle === 'string'
        && (c.fillStyle as string).startsWith(BLUE_BRIGHT)
        && (c.args[1] as number) > gridOriginY() + gridH(),
    );
    expect(marker).toBeTruthy();
  });

  test('row variant (turnStartAngle 90, entry from left): row highlight with arrows LEFT of the grid', () => {
    const state = makeState({
      phase: GamePhase.Aiming,
      cursorCol: 3,
      gravity: makeGravity({ angle: 90, turnStartAngle: 90, pendingLane: 3 }),
    });
    callDraw(renderer, state, undefined, {
      tutorial: { allowedCols: [3], staged: true, needsTilt: true },
    });
    const stroke = tutorialStroke(ctx.calls, BLUE_BRIGHT);
    expect(stroke).toBeTruthy();
    expect(stroke!.args[2]).toBe(gridW() - 6); // row shape: full grid width
    const arrows = arrowCalls(ctx.calls);
    expect(arrows.length).toBe(2);
    for (const arrow of arrows) {
      expect(arrow.args[1] as number).toBeLessThan(gridOriginX());
    }
  });

  test('hidden while the accepted turn animates, without hiding the grid or turn animation', () => {
    const animatedDisc = makeDisc(6, DiscKind.Numbered);
    const animation: RichDiscAnimation = {
      discId: animatedDisc.id,
      disc: animatedDisc,
      phase: AnimPhase.Dropping,
      startTime: 0,
      duration: 100,
      fromX: 10,
      toX: 30,
      fromY: 20,
      toY: 40,
      alpha: 1,
      scale: 1,
      progress: 1,
    };
    const state = makeState({
      phase: GamePhase.Animating,
      gravity: makeGravity({ angle: 45, turnStartAngle: 0 }),
    });

    callDraw(renderer, state, undefined, {
      // The controller may still carry the just-completed tutorial step while
      // resolution runs. Neither its green nor blue lane should leak through.
      tutorial: { allowedCols: [2], staged: false, needsTilt: false },
      animations: [animation],
    });

    expect(tutorialStroke(ctx.calls, GREEN_BRIGHT)).toBeUndefined();
    expect(tutorialStroke(ctx.calls, BLUE_BRIGHT)).toBeUndefined();
    expect(arrowCalls(ctx.calls)).toHaveLength(0);
    const tutorialMarker = ctx.calls.find(
      c => c.method === 'arc'
        && typeof c.fillStyle === 'string'
        && ((c.fillStyle as string).startsWith(GREEN_BRIGHT)
          || (c.fillStyle as string).startsWith(BLUE_BRIGHT)),
    );
    expect(tutorialMarker).toBeUndefined();

    // Resolution itself is unaffected: the board grid and animated disc are
    // still rendered in the same frame.
    expect(ctx.calls.filter(c => c.method === 'roundRect')).toHaveLength(49);
    expect(ctx.calls.some(c => c.method === 'translate' && c.args[0] === 30 && c.args[1] === 40)).toBe(true);
  });
});

// ─── Diagonal lane overlay ──────────────────────────────────────────────────
// Clearing checks runs along the current (snapped) gravity angle, not always
// grid rows/columns — see gravityRunLengths. At a cardinal angle the ordinary
// grid already shows that axis, but at a diagonal angle nothing about the
// plain upright grid does, and a pile pressed against a wall can visually
// read as a plain column/row regardless of the true gravity direction. This
// overlay draws the actual diagonal lattice so the real check axis is
// visible on the board itself.

function hasDiagonalLaneStroke(calls: readonly RecordedCall[]): boolean {
  return calls.some(c => c.method === 'stroke' && c.strokeStyle === COLOR_GRAVITY_LANE);
}

describe('diagonal lane overlay', () => {
  test('not drawn for Classic (no gravity)', () => {
    callDraw(renderer, makeState());
    expect(hasDiagonalLaneStroke(ctx.calls)).toBe(false);
  });

  test.each([0, 90, 180, 270])('not drawn at cardinal angle %ideg — the plain grid already shows it', (angle) => {
    const state = makeState({ gravity: makeGravity({ angle }) });
    callDraw(renderer, state);
    expect(hasDiagonalLaneStroke(ctx.calls)).toBe(false);
  });

  test.each([45, 135, 225, 315])('drawn at diagonal angle %ideg', (angle) => {
    const state = makeState({ gravity: makeGravity({ angle }) });
    callDraw(renderer, state);
    expect(hasDiagonalLaneStroke(ctx.calls)).toBe(true);
  });

  // The engine only ever persists a snapped angle outside of Aiming (see
  // GameEngine.commitTilt), but WHILE aiming state.gravity.angle briefly
  // holds the raw dragged value — the overlay must react to what committing
  // now would actually snap to, not the raw value, so it never shows a
  // lattice that doesn't match what's about to happen.
  test('uses the snapped angle, not the raw dragged value, while aiming', () => {
    const state = makeState({ gravity: makeGravity({ angle: 40 }) }); // raw 40 snaps to 45
    callDraw(renderer, state);
    expect(hasDiagonalLaneStroke(ctx.calls)).toBe(true);
  });

  test('does not show at a raw angle that snaps back to cardinal', () => {
    const state = makeState({ gravity: makeGravity({ angle: 12 }) }); // raw 12 snaps to 0
    callDraw(renderer, state);
    expect(hasDiagonalLaneStroke(ctx.calls)).toBe(false);
  });
});

// ─── Ghost preview ──────────────────────────────────────────────────────────

describe('ghost preview', () => {
  test('Classic: ghost disc is translated to the true landing cell (bottom of an empty column)', () => {
    callDraw(renderer, makeState({ cursorCol: 3 }));
    const translates = ctx.calls.filter(c => c.method === 'translate');
    expect(translates).toContainEqual(expect.objectContaining({
      args: [cellCenterX(3), cellCenterY(6)],
    }));
  });

  test('Classic: no ghost is drawn once the column is full', () => {
    const board = makeEmptyBoard();
    for (let r = 0; r < 7; r++) placeDisc(board, r, 3, makeDisc(1, DiscKind.Numbered));
    const state = makeState({ cursorCol: 3, board });
    callDraw(renderer, state, board);

    // Column 3 is full of real (alpha=1) discs, so translates at that column
    // are expected — the absence check is specifically for a ghost's
    // signature partial alpha (0.28 for Classic), not for any translate at all.
    const ghostAtCol3 = ctx.calls.some(c =>
      c.method === 'translate' && c.args[0] === cellCenterX(3) && (c.globalAlpha as number) < 1,
    );
    expect(ghostAtCol3).toBe(false);
  });

  test('Gravity: ghost uses the caller-supplied previewLanding, not the entry cell', () => {
    const state = makeState({ cursorCol: 3, gravity: makeGravity({ angle: 0 }) });
    callDraw(renderer, state, state.board, { previewLanding: { row: 5, col: 4 } });

    const translates = ctx.calls.filter(c => c.method === 'translate');
    expect(translates).toContainEqual(expect.objectContaining({
      args: [cellCenterX(4), cellCenterY(5)],
    }));
    // Never translates to the entry cell (0,3) as if it were the landing spot.
    expect(translates.some(c => c.args[0] === cellCenterX(3) && c.args[1] === cellCenterY(0))).toBe(false);
  });

  test('Gravity: no ghost at all when previewLanding is null (lane full)', () => {
    const state = makeState({ cursorCol: 3, gravity: makeGravity() });
    callDraw(renderer, state, state.board, { previewLanding: null });

    // Gravity's ghost disc is drawn at alpha=0.32 (see drawGhostGravity) — no
    // translate call should carry that signature anywhere.
    const ghostTranslate = ctx.calls.find(c => c.method === 'translate' && c.globalAlpha === 0.32);
    expect(ghostTranslate).toBeUndefined();
  });
});

// ─── HUD ────────────────────────────────────────────────────────────────────

describe('canvas HUD removal', () => {
  test('does not draw the score as canvas text', () => {
    callDraw(renderer, makeState({ score: 12_345 }));
    expect(ctx.calls.some(c => c.method === 'fillText' && c.args[0] === (12_345).toLocaleString('en-US'))).toBe(false);
  });

  test('does not draw turn pips in canvas', () => {
    callDraw(renderer, makeState({ turnsPerLevel: 30, turnsRemaining: 30 }));
    const pipArcs = ctx.calls.filter(c => c.method === 'arc' && (c.args[2] as number) <= 7);
    expect(pipArcs.length).toBe(0);
  });
});

// ─── drawDisc branching ─────────────────────────────────────────────────────

describe('drawDisc', () => {
  test('a Numbered disc draws its value as text', () => {
    renderer.drawDisc(makeDisc(5, DiscKind.Numbered), 100, 100, 30, 1, 1);
    expect(ctx.calls.some(c => c.method === 'fillText' && c.args[0] === '5')).toBe(true);
  });

  test('a DoubleCracked disc draws two crack strokes and no value text', () => {
    ctx.calls.length = 0;
    renderer.drawDisc(makeDisc(5, DiscKind.DoubleCracked), 100, 100, 30, 1, 1);
    expect(ctx.calls.some(c => c.method === 'fillText')).toBe(false);
    // Each crack is its own beginPath/moveTo/lineTo/lineTo/stroke sequence;
    // double-cracked draws two, single-cracked (below) draws one.
    const crackStrokes = ctx.calls.filter(c => c.method === 'stroke').length;
    expect(crackStrokes).toBeGreaterThanOrEqual(2);
  });

  test('SingleCracked draws fewer crack strokes than DoubleCracked', () => {
    ctx.calls.length = 0;
    renderer.drawDisc(makeDisc(5, DiscKind.SingleCracked), 100, 100, 30, 1, 1);
    const singleStrokes = ctx.calls.filter(c => c.method === 'stroke').length;

    ctx.calls.length = 0;
    renderer.drawDisc(makeDisc(5, DiscKind.DoubleCracked), 100, 100, 30, 1, 1);
    const doubleStrokes = ctx.calls.filter(c => c.method === 'stroke').length;

    expect(singleStrokes).toBeLessThan(doubleStrokes);
  });

  test('clamps out-of-range alpha into globalAlpha\'s valid [0,1] domain', () => {
    expect(() => renderer.drawDisc(makeDisc(1, DiscKind.Numbered), 0, 0, 10, 5, 1)).not.toThrow();
    expect(() => renderer.drawDisc(makeDisc(1, DiscKind.Numbered), 0, 0, 10, -5, 1)).not.toThrow();
  });
});
