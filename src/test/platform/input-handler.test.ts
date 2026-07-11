// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InputHandler, type InputIntent } from '../../platform/input-handler.js';
import {
  canvasLogicalHeight, canvasLogicalWidth, cellCenterX, cellCenterY, setGridSize, updateCellSize,
} from '../../ui/rendering/layout.js';

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: canvasLogicalWidth(),
    bottom: canvasLogicalHeight(),
    width: canvasLogicalWidth(),
    height: canvasLogicalHeight(),
    toJSON: () => ({}),
  }));
  document.body.append(canvas);
  return canvas;
}

function touch(init: { clientX: number; clientY: number }): Touch {
  return {
    identifier: 1,
    target: document.body,
    screenX: init.clientX,
    screenY: init.clientY,
    clientX: init.clientX,
    clientY: init.clientY,
    pageX: init.clientX,
    pageY: init.clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  } as unknown as Touch;
}

describe('InputHandler', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    setViewport(700, 700);
    setGridSize(7, 7);
    updateCellSize();
  });

  test('mouse move and click emit lane intents for columns', () => {
    const intents: InputIntent[] = [];
    const canvas = createCanvas();
    new InputHandler(canvas, intent => intents.push(intent), () => false, () => 3);

    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: cellCenterX(3), clientY: cellCenterY(0), bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('click', { clientX: cellCenterX(3), clientY: cellCenterY(0), bubbles: true }));

    expect(intents).toEqual([
      { kind: 'move', col: 3 },
      { kind: 'drop', col: 3 },
    ]);
  });

  test('pointer lanes can be rows for side-entry gravity controls', () => {
    const intents: InputIntent[] = [];
    const canvas = createCanvas();
    new InputHandler(canvas, intent => intents.push(intent), () => false, () => 2, () => 'row');

    canvas.dispatchEvent(new MouseEvent('click', { clientX: cellCenterX(0), clientY: cellCenterY(3), bubbles: true }));

    expect(intents).toEqual([{ kind: 'drop', col: 3 }]);
  });

  test('keyboard emits movement, drop, tilt, cancel, and restart intents', () => {
    const intents: InputIntent[] = [];
    const canvas = createCanvas();
    new InputHandler(canvas, intent => intents.push(intent), () => false, () => 3);

    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowDown', ' ', 'Enter', 'q', 'e', 'Escape', 'r']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }

    expect(intents).toEqual([
      { kind: 'move', col: 2 },
      { kind: 'move', col: 4 },
      { kind: 'drop', col: 3 },
      { kind: 'drop', col: 3 },
      { kind: 'drop', col: 3 },
      { kind: 'tilt', delta: -5 },
      { kind: 'tilt', delta: 5 },
      { kind: 'cancel' },
      { kind: 'restart' },
    ]);
  });

  test('keyboard movement follows row axis when gravity entry lanes are rows', () => {
    const intents: InputIntent[] = [];
    const canvas = createCanvas();
    new InputHandler(canvas, intent => intents.push(intent), () => false, () => 3, () => 'row');

    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }

    expect(intents).toEqual([
      { kind: 'move', col: 2 },
      { kind: 'move', col: 4 },
    ]);
  });

  test('keyboard ignores focusable and contenteditable targets', () => {
    const intents: InputIntent[] = [];
    const canvas = createCanvas();
    new InputHandler(canvas, intent => intents.push(intent), () => false, () => 3);
    const button = document.createElement('button');
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(button, editor);

    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(intents).toEqual([]);
  });

  test('touch tap drops, drag only moves, and game-over tap restarts', () => {
    const intents: InputIntent[] = [];
    const canvas = createCanvas();
    let gameOver = false;
    new InputHandler(canvas, intent => intents.push(intent), () => gameOver, () => 3);

    canvas.dispatchEvent(new TouchEvent('touchstart', {
      touches: [touch({ clientX: cellCenterX(2), clientY: cellCenterY(0) })],
      bubbles: true,
      cancelable: true,
    }));
    canvas.dispatchEvent(new TouchEvent('touchend', {
      changedTouches: [touch({ clientX: cellCenterX(2), clientY: cellCenterY(0) })],
      bubbles: true,
    }));

    canvas.dispatchEvent(new TouchEvent('touchstart', {
      touches: [touch({ clientX: cellCenterX(2), clientY: cellCenterY(0) })],
      bubbles: true,
      cancelable: true,
    }));
    canvas.dispatchEvent(new TouchEvent('touchmove', {
      touches: [touch({ clientX: cellCenterX(3), clientY: cellCenterY(0) })],
      bubbles: true,
      cancelable: true,
    }));
    canvas.dispatchEvent(new TouchEvent('touchend', {
      changedTouches: [touch({ clientX: cellCenterX(5), clientY: cellCenterY(0) })],
      bubbles: true,
    }));

    gameOver = true;
    canvas.dispatchEvent(new TouchEvent('touchstart', {
      touches: [touch({ clientX: cellCenterX(3), clientY: cellCenterY(0) })],
      bubbles: true,
      cancelable: true,
    }));
    canvas.dispatchEvent(new TouchEvent('touchend', {
      changedTouches: [touch({ clientX: cellCenterX(3), clientY: cellCenterY(0) })],
      bubbles: true,
    }));

    expect(intents).toEqual([
      { kind: 'move', col: 2 },
      { kind: 'drop', col: 2 },
      { kind: 'move', col: 2 },
      { kind: 'move', col: 3 },
      { kind: 'move', col: 3 },
      { kind: 'restart' },
    ]);
  });

  test('destroy removes event listeners', () => {
    const intents: InputIntent[] = [];
    const canvas = createCanvas();
    const input = new InputHandler(canvas, intent => intents.push(intent), () => false, () => 3);

    input.destroy();
    canvas.dispatchEvent(new MouseEvent('click', { clientX: cellCenterX(3), clientY: cellCenterY(0), bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));

    expect(intents).toEqual([]);
  });
});
