// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import { Renderer } from '../../ui/rendering/renderer.js';
import { GamePhase } from '../../game/state.js';
import type { GameState, GravityState } from '../../game/state.js';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import { DiscKind } from '../../game/model.js';
import type { Board } from '../../game/model.js';
import {
  cellCenterX, cellCenterY, canvasLogicalWidth, canvasLogicalHeight,
  gridPadding, gridOriginY, gridW, gridH, cellSize, setGridSize,
} from '../../ui/rendering/layout.js';
import { computeGravityVector } from '../../game/gravity.js';
import {
  COLOR_COL_HOVER, COLOR_GAMEOVER_BG, COLOR_GRAVITY_ACCENT, COLOR_GRAVITY_LANE, HUD_TOP_HEIGHT,
} from '../../ui/rendering/theme.js';
import type { GameStats } from '../../game/stats.js';

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
    ...overrides,
  };
}

function makeGravity(overrides: Partial<GravityState> = {}): GravityState {
  return { angle: 0, turnStartAngle: 0, maxTiltDelta: 45, ...overrides };
}

function makeStats(overrides: Partial<GameStats> = {}): GameStats {
  return { highScore: 0, longestStreak: 0, averageScore: 0, gamesPlayed: 0, totalScore: 0, ...overrides };
}

// draw()'s optional trailing params, always passed explicitly for clarity.
function callDraw(
  renderer: Renderer,
  state: GameState,
  board: Board = state.board,
  opts: { previewLanding?: { row: number; col: number } | null } = {},
): void {
  renderer.draw(
    state, board, [], makeStats(), state.score, [], [],
    30, { level: state.level, turnsPerLevel: state.turnsPerLevel, turnsRemaining: state.turnsRemaining },
    null, opts.previewLanding ?? null,
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

// ─── Cursor highlight axis ──────────────────────────────────────────────────

describe('cursor highlight axis', () => {
  test('Classic (no gravity): highlights a full-height column at the cursor', () => {
    callDraw(renderer, makeState({ cursorCol: 2 }));
    const highlight = ctx.calls.find(c => c.method === 'fillRect' && c.fillStyle === COLOR_COL_HOVER);
    expect(highlight?.args).toEqual([gridPadding() + 2 * cellSize(), gridOriginY(), cellSize(), gridH()]);
  });

  test('Gravity mode pointing right (entry from left): highlights a full-width row', () => {
    const state = makeState({ cursorCol: 2, gravity: makeGravity({ angle: 90 }) });
    callDraw(renderer, state);
    const highlight = ctx.calls.find(c => c.method === 'fillRect' && c.fillStyle === COLOR_COL_HOVER);
    // width = gridW(), height = cellSize() — the opposite shape from the column case.
    expect(highlight?.args[2]).toBe(gridW());
    expect(highlight?.args[3]).toBe(cellSize());
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

// ─── Gravity compass ────────────────────────────────────────────────────────

describe('gravity compass', () => {
  test('arrow direction matches computeGravityVector for the current angle', () => {
    const angle = 130;
    const state = makeState({ gravity: makeGravity({ angle }) });
    callDraw(renderer, state);

    const cx = canvasLogicalWidth() - gridPadding() - 36;
    const cy = HUD_TOP_HEIGHT * 0.5;
    const radius = 26;
    const { gx, gy } = computeGravityVector(angle);
    const expectedTipX = cx + gx * radius * 0.82;
    const expectedTipY = cy + gy * radius * 0.82;

    const shaft = ctx.calls.find(c =>
      c.method === 'lineTo' && c.strokeStyle === COLOR_GRAVITY_ACCENT && c.lineWidth === 4
      && Math.abs((c.args[0] as number) - expectedTipX) < 1e-6
      && Math.abs((c.args[1] as number) - expectedTipY) < 1e-6,
    );
    expect(shaft).toBeDefined();
  });

  test('is not drawn at all for a mode without gravity', () => {
    callDraw(renderer, makeState());
    expect(ctx.calls.some(c => c.strokeStyle === COLOR_GRAVITY_ACCENT)).toBe(false);
  });

  // strokeStyle/lineWidth are only "live" at the moment stroke() actually
  // runs, not at the earlier arc()/moveTo() path-building calls (canvas 2D
  // reads style state lazily) — and the compass ARROW's shaft stroke also
  // uses lineWidth 4 + the accent color, so lineWidth/strokeStyle alone can't
  // distinguish it from the tilt-range arc's stroke. Distinguish by what
  // path-building call immediately preceded the stroke: an arc() means the
  // curved tilt-range arc, a lineTo() means the straight arrow shaft.
  function tiltArcStrokeCount(): number {
    return ctx.calls.filter((c, i) =>
      c.method === 'stroke' && c.strokeStyle === COLOR_GRAVITY_ACCENT && c.lineWidth === 4
      && ctx.calls[i - 1]?.method === 'arc',
    ).length;
  }

  test('draws the tilt-range arc only during Aiming, not WaitingForDrop', () => {
    const base = { gravity: makeGravity({ angle: 10, turnStartAngle: 0, maxTiltDelta: 45 }) };

    callDraw(renderer, makeState({ ...base, phase: GamePhase.WaitingForDrop }));
    expect(tiltArcStrokeCount()).toBe(0);

    ctx.calls.length = 0;
    callDraw(renderer, makeState({ ...base, phase: GamePhase.Aiming }));
    expect(tiltArcStrokeCount()).toBe(1);
  });
});

// ─── HUD ────────────────────────────────────────────────────────────────────

describe('HUD', () => {
  test('draws the locale-formatted display score', () => {
    callDraw(renderer, makeState({ score: 12_345 }));
    expect(ctx.calls.some(c => c.method === 'fillText' && c.args[0] === (12_345).toLocaleString('en-US'))).toBe(true);
  });

  test('draws one turn pip per turn in the level', () => {
    callDraw(renderer, makeState({ turnsPerLevel: 30, turnsRemaining: 30 }));
    // Pips are drawn via arc() with a small radius (<=7); discs use discR() (much larger).
    const pipArcs = ctx.calls.filter(c => c.method === 'arc' && (c.args[2] as number) <= 7);
    expect(pipArcs.length).toBeGreaterThanOrEqual(30);
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
