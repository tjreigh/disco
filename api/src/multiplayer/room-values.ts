import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { RoomIdAllocator, RoomValueFactory } from './room-types.js';

const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 8;

export function createDefaultRoomValueFactory(): RoomValueFactory {
  return {
    createRoomId: () => {
      let id = '';
      for (let index = 0; index < ROOM_ID_LENGTH; index++) {
        id += ROOM_ID_ALPHABET[randomInt(ROOM_ID_ALPHABET.length)];
      }
      return id;
    },
    createPlayerId: () => randomUUID(),
    createReconnectCredential: () => randomBytes(32).toString('base64url'),
    createMatchId: () => randomUUID(),
    createSeed: () => randomBytes(4).readUInt32BE(0),
  };
}

export function createRoomIdAllocator(maxAttempts = 32): RoomIdAllocator {
  const claimed = new Set<string>();
  return {
    claim(generateCandidate: () => string): string {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = requiredValue(generateCandidate(), 'room id');
        if (!claimed.has(candidate)) {
          claimed.add(candidate);
          return candidate;
        }
      }
      throw new Error('Room id allocator could not produce a unique room id');
    },
    release(roomId: string): void {
      claimed.delete(roomId);
    },
  };
}

export function digestCredential(credential: string): Buffer {
  return createHash('sha256').update(credential).digest();
}

export function credentialMatches(credential: string, expectedDigest: Buffer): boolean {
  const actualDigest = digestCredential(credential);
  return actualDigest.length === expectedDigest.length
    && timingSafeEqual(actualDigest, expectedDigest);
}

export function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Room durations must be positive safe integers');
  }
  return value;
}

export function requiredValue(value: string, label: string): string {
  if (!value.trim()) throw new Error(`Room value factory produced an empty ${label}`);
  return value;
}

export function uint32Value(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error('Room value factory produced an invalid seed');
  }
  return value;
}
