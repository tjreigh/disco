import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AudioManager } from '../../platform/audio-manager.js';

// vitest.config.ts runs this suite under environment: 'node', so there is no
// AudioContext global by default. We stub just the Web Audio surface that
// AudioManager.beep() actually touches (read the implementation before
// trimming this further): ctx.createOscillator/createGain/currentTime/
// destination, osc.type/frequency.value/connect/start/stop, and
// env.gain.setValueAtTime/exponentialRampToValueAtTime/connect.
function makeFakeOscillator() {
  return {
    type: 'sine' as OscillatorType,
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function makeFakeGain() {
  return {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
}

describe('AudioManager', () => {
  let createOscillator: ReturnType<typeof vi.fn>;
  let createGain: ReturnType<typeof vi.fn>;
  let audioContextCtor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createOscillator = vi.fn(() => makeFakeOscillator());
    createGain = vi.fn(() => makeFakeGain());
    // AudioManager does `new AudioContext()`, so this stub must be invocable
    // as a constructor. An arrow function can't be (vitest just swallows the
    // resulting TypeError inside beep()'s try/catch, silently under-counting
    // calls), so this needs a plain function whose returned object `new` uses
    // as the instance.
    audioContextCtor = vi.fn(function AudioContextStub() {
      return {
        createOscillator,
        createGain,
        currentTime: 0,
        destination: {},
      };
    });
    vi.stubGlobal('AudioContext', audioContextCtor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const playMethods: Array<[string, (manager: AudioManager) => void]> = [
    ['playDrop', manager => manager.playDrop()],
    ['playClear', manager => manager.playClear(2)],
    ['playReveal', manager => manager.playReveal()],
    ['playGameOver', manager => manager.playGameOver()],
    ['playPush', manager => manager.playPush()],
  ];

  test.each(playMethods)('%s schedules a sound without throwing', (_name, invoke) => {
    const manager = new AudioManager();
    expect(() => invoke(manager)).not.toThrow();
    expect(createOscillator).toHaveBeenCalledTimes(1);
    expect(createGain).toHaveBeenCalledTimes(1);
  });

  test('constructs the AudioContext lazily, on first beep rather than in the constructor', () => {
    const manager = new AudioManager();
    expect(audioContextCtor).not.toHaveBeenCalled();

    manager.playDrop();
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });

  test('reuses a single AudioContext across multiple plays', () => {
    const manager = new AudioManager();
    manager.playDrop();
    manager.playReveal();
    manager.playPush();
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });

  test('setEnabled(false) short-circuits every play method before touching audio', () => {
    const manager = new AudioManager();
    manager.setEnabled(false);

    manager.playDrop();
    manager.playClear(3);
    manager.playReveal();
    manager.playGameOver();
    manager.playPush();

    expect(createOscillator).not.toHaveBeenCalled();
    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  test('setEnabled(true) re-enables playback after being disabled', () => {
    const manager = new AudioManager();
    manager.setEnabled(false);
    manager.setEnabled(true);
    manager.playDrop();
    expect(createOscillator).toHaveBeenCalledTimes(1);
  });

  test('toggleEnabled flips and returns the new state; isEnabled reflects it', () => {
    const manager = new AudioManager();
    expect(manager.isEnabled()).toBe(true);

    expect(manager.toggleEnabled()).toBe(false);
    expect(manager.isEnabled()).toBe(false);

    expect(manager.toggleEnabled()).toBe(true);
    expect(manager.isEnabled()).toBe(true);
  });

  test('errors thrown inside the Web Audio stubs are swallowed', () => {
    createOscillator.mockImplementation(() => {
      throw new Error('boom');
    });
    const manager = new AudioManager();
    expect(() => manager.playDrop()).not.toThrow();
  });
});
