import { describe, expect, test } from 'vitest';
import {
  createDefaultRoomValueFactory,
  createRoomIdAllocator,
  credentialMatches,
  digestCredential,
  positiveDuration,
  requiredValue,
  uint32Value,
} from '../src/multiplayer/room-values.js';

describe('createRoomIdAllocator', () => {
  test('claims the first non-colliding candidate a generator produces', () => {
    const allocator = createRoomIdAllocator();
    let attempt = 0;
    const candidates = ['ROOM-A', 'ROOM-A', 'ROOM-B'];
    allocator.claim(() => 'ROOM-A');
    const claimed = allocator.claim(() => candidates[attempt++]!);
    expect(claimed).toBe('ROOM-B');
    expect(attempt).toBe(3);
  });

  test('release frees a claim so it can be reused', () => {
    const allocator = createRoomIdAllocator();
    const id = allocator.claim(() => 'ROOM-X');
    allocator.release(id);
    expect(allocator.claim(() => 'ROOM-X')).toBe('ROOM-X');
  });

  test('throws after exhausting attempts against a generator that never produces a fresh id', () => {
    const allocator = createRoomIdAllocator(3);
    allocator.claim(() => 'ROOM-Y');
    expect(() => allocator.claim(() => 'ROOM-Y')).toThrow();
  });

  test('rejects a blank candidate', () => {
    const allocator = createRoomIdAllocator();
    expect(() => allocator.claim(() => '   ')).toThrow(/room id/);
  });

  test('two allocators are independent namespaces', () => {
    const a = createRoomIdAllocator();
    const b = createRoomIdAllocator();
    expect(a.claim(() => 'SHARED')).toBe('SHARED');
    expect(b.claim(() => 'SHARED')).toBe('SHARED');
  });
});

describe('credentialMatches', () => {
  test('matches the credential that produced the digest', () => {
    const digest = digestCredential('secret');
    expect(credentialMatches('secret', digest)).toBe(true);
  });

  test('rejects a different credential without throwing', () => {
    const digest = digestCredential('secret');
    expect(credentialMatches('not-secret', digest)).toBe(false);
  });

  // node:crypto's timingSafeEqual throws on unequal-length buffers — the
  // length check here must short-circuit before ever calling it, or a
  // malformed/truncated stored digest would crash credential verification
  // instead of just failing it.
  test('does not throw when compared against a digest of a different length', () => {
    const shortDigest = Buffer.from([1, 2, 3]);
    expect(() => credentialMatches('secret', shortDigest)).not.toThrow();
    expect(credentialMatches('secret', shortDigest)).toBe(false);
  });
});

describe('positiveDuration', () => {
  test('accepts positive safe integers', () => {
    expect(positiveDuration(1)).toBe(1);
    expect(positiveDuration(60_000)).toBe(60_000);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p', (value) => {
    expect(() => positiveDuration(value)).toThrow();
  });
});

describe('requiredValue', () => {
  test('returns a non-blank value unchanged', () => {
    expect(requiredValue('room-1', 'room id')).toBe('room-1');
  });

  test.each(['', '   '])('rejects %p with a message naming the label', (value) => {
    expect(() => requiredValue(value, 'room id')).toThrow(/room id/);
  });
});

describe('uint32Value', () => {
  test('accepts values within uint32 range', () => {
    expect(uint32Value(0)).toBe(0);
    expect(uint32Value(0xffff_ffff)).toBe(0xffff_ffff);
  });

  test.each([-1, 0x1_0000_0000, 1.5, Number.NaN])('rejects %p', (value) => {
    expect(() => uint32Value(value)).toThrow();
  });
});

describe('createDefaultRoomValueFactory', () => {
  test('produces well-formed, non-repeating room/player/credential/match ids and an in-range seed', () => {
    const factory = createDefaultRoomValueFactory();
    expect(factory.createRoomId()).toMatch(/^[A-Z2-9]{8}$/);
    expect(factory.createPlayerId()).not.toBe(factory.createPlayerId());
    expect(factory.createReconnectCredential().length).toBeGreaterThan(0);
    expect(factory.createMatchId()).not.toBe(factory.createMatchId());
    const seed = factory.createSeed();
    expect(Number.isSafeInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffff_ffff);
  });
});
