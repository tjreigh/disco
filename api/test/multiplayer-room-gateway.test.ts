import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../src/multiplayer/contracts.js';
import {
  SCORE_RACE_ROOM_MODE,
  ScoreRaceRoomService,
} from '../src/multiplayer/room-service.js';
import { createTestConfig, createTestDb } from './helpers.js';

let db: Database.Database | null = null;
let app: FastifyInstance | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await app?.close();
  db?.close();
  app = null;
  db = null;
});

async function createApp(): Promise<FastifyInstance> {
  db = createTestDb();
  const roomService = new ScoreRaceRoomService({
    clock: { now: () => Date.now() },
    countdownMs: 5,
  });
  app = await buildApp(createTestConfig(), db, { roomService, roomTickMs: 5 });
  await app.ready();
  return app;
}

const admissionRequest = {
  protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
  mode: SCORE_RACE_ROOM_MODE,
};

describe('multiplayer room gateway', () => {
  it('validates public room admission and rejects incompatible or full rooms', async () => {
    const instance = await createApp();

    const invalid = await instance.inject({
      method: 'POST',
      url: '/multiplayer/rooms',
      payload: { ...admissionRequest, unexpected: true },
    });
    const incompatible = await instance.inject({
      method: 'POST',
      url: '/multiplayer/rooms',
      payload: {
        ...admissionRequest,
        mode: { ...SCORE_RACE_ROOM_MODE, version: 2 },
      },
    });
    const created = await instance.inject({
      method: 'POST',
      url: '/multiplayer/rooms',
      payload: admissionRequest,
    });
    const room = created.json();
    const joined = await instance.inject({
      method: 'POST',
      url: `/multiplayer/rooms/${String(room.roomId).toLowerCase()}/join`,
      payload: admissionRequest,
    });
    const full = await instance.inject({
      method: 'POST',
      url: `/multiplayer/rooms/${String(room.roomId)}/join`,
      payload: admissionRequest,
    });

    expect(invalid.statusCode).toBe(400);
    expect(incompatible.statusCode).toBe(409);
    expect(incompatible.json()).toEqual({ error: 'mode-mismatch' });
    expect(created.statusCode).toBe(201);
    expect(room).toEqual({
      roomId: expect.stringMatching(/^[A-Z2-9]{8}$/),
      playerId: expect.any(String),
      reconnectCredential: expect.any(String),
      mode: SCORE_RACE_ROOM_MODE,
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json().roomId).toBe(room.roomId);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: 'room-full' });
  });

  it('rate limits room creation by forwarded client address', async () => {
    const instance = await createApp();
    const create = () => instance.inject({
      method: 'POST',
      url: '/multiplayer/rooms',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.40' },
      payload: admissionRequest,
    });

    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await create()).statusCode).toBe(201);
    }
    const limited = await create();

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate_limited' });
  });

  it('authenticates sockets, relays canonical progress, and broadcasts one result', async () => {
    const instance = await createApp();
    const hostAdmission = await admit(instance, '/multiplayer/rooms');
    const guestAdmission = await admit(
      instance,
      `/multiplayer/rooms/${hostAdmission.roomId}/join`,
    );
    const host = await connect(instance, hostAdmission);
    const guest = await connect(instance, guestAdmission);

    await readyPlayer(host, true);
    await readyPlayer(guest, true);
    const hostCountdown = await nextMessageOfType(host, 'match-countdown');
    const guestCountdown = await nextMessageOfType(guest, 'match-countdown');
    expect(guestCountdown).toEqual(hostCountdown);

    await new Promise(resolve => setTimeout(resolve, 10));
    host.send(JSON.stringify({
      ...clientEnvelope(hostAdmission),
      type: 'publish-progress',
      matchId: hostCountdown.matchId,
      progress: { sequence: 1, score: 120, turnsPlayed: 1 },
    }));
    expect(await nextMessageOfType(guest, 'opponent-progress')).toMatchObject({
      matchId: hostCountdown.matchId,
      progress: {
        playerId: hostAdmission.playerId,
        sequence: 1,
        score: 120,
        turnsPlayed: 1,
        finished: false,
      },
    });

    host.send(JSON.stringify({
      ...clientEnvelope(hostAdmission),
      type: 'finish-match',
      matchId: hostCountdown.matchId,
      progress: { sequence: 1, score: 120, turnsPlayed: 1 },
    }));
    await nextMessageOfType(guest, 'opponent-progress');
    guest.send(JSON.stringify({
      ...clientEnvelope(guestAdmission),
      type: 'finish-match',
      matchId: hostCountdown.matchId,
      progress: { sequence: 1, score: 80, turnsPlayed: 1 },
    }));

    const hostResult = await nextMessageOfType(host, 'match-finished');
    const guestResult = await nextMessageOfType(guest, 'match-finished');
    expect(guestResult).toEqual(hostResult);
    expect(hostResult.result).toEqual({
      winnerId: hostAdmission.playerId,
      scores: [
        { playerId: hostAdmission.playerId, score: 120 },
        { playerId: guestAdmission.playerId, score: 80 },
      ],
      forfeitedBy: null,
    });
  });

  it('rejects an invalid first frame without admitting the socket', async () => {
    const instance = await createApp();
    const socket = await instance.injectWS('/multiplayer/socket');
    sockets.push(socket);
    retainMessages(socket);
    socket.send(JSON.stringify({ type: 'set-ready', ready: true }));

    expect(await nextJson(socket)).toEqual({
      type: 'room-transport-error',
      error: 'invalid-message',
    });
    await new Promise<void>(resolve => socket.once('close', () => resolve()));
    expect(socket.readyState).toBe(socket.CLOSED);
  });
});

interface Admission {
  readonly roomId: string;
  readonly playerId: string;
  readonly reconnectCredential: string;
}

async function admit(instance: FastifyInstance, url: string): Promise<Admission> {
  const response = await instance.inject({
    method: 'POST',
    url,
    payload: admissionRequest,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Admission;
}

async function connect(instance: FastifyInstance, admission: Admission): Promise<WebSocket> {
  const socket = await instance.injectWS('/multiplayer/socket');
  sockets.push(socket);
  retainMessages(socket);
  socketAdmissions.set(socket, admission);
  socket.send(JSON.stringify({
    type: 'authenticate-room',
    ...clientEnvelope(admission),
    reconnectCredential: admission.reconnectCredential,
  }));
  await nextMessageOfType(socket, 'room-state');
  return socket;
}

function clientEnvelope(admission: Admission) {
  return {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: admission.roomId,
    playerId: admission.playerId,
  };
}

async function readyPlayer(socket: WebSocket, ready: boolean): Promise<void> {
  const admission = await admissionForSocket(socket);
  socket.send(JSON.stringify({
    ...clientEnvelope(admission),
    type: 'set-ready',
    ready,
  }));
  await nextMessageOfType(socket, 'room-state');
}

const socketAdmissions = new WeakMap<WebSocket, Admission>();

async function admissionForSocket(socket: WebSocket): Promise<Admission> {
  const admission = socketAdmissions.get(socket);
  if (!admission) throw new Error('Socket admission was not retained');
  return admission;
}

async function nextMessageOfType(socket: WebSocket, type: string): Promise<any> {
  while (true) {
    const message = await nextJson(socket);
    if (message.type === type) return message;
  }
}

async function nextJson(socket: WebSocket): Promise<any> {
  const inbox = socketInboxes.get(socket);
  if (!inbox) throw new Error('Socket inbox was not retained');
  const queued = inbox.messages.shift();
  if (queued !== undefined) return queued;
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = inbox.waiters.indexOf(waiter);
      if (index >= 0) inbox.waiters.splice(index, 1);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, 1_000);
    const waiter = (message: unknown) => {
      clearTimeout(timeout);
      resolve(message);
    };
    inbox.waiters.push(waiter);
  });
}

interface SocketInbox {
  readonly messages: unknown[];
  readonly waiters: Array<(message: unknown) => void>;
}

const socketInboxes = new WeakMap<WebSocket, SocketInbox>();

function retainMessages(socket: WebSocket): void {
  const inbox: SocketInbox = { messages: [], waiters: [] };
  socketInboxes.set(socket, inbox);
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as unknown;
    const waiter = inbox.waiters.shift();
    if (waiter) waiter(message);
    else inbox.messages.push(message);
  });
}
