import { afterEach, describe, expect, test, vi } from 'vitest';
import { SCORE_RACE_MODE } from '../../game/modes/score-race.js';
import { ApiRequestError } from '../../platform/api-client.js';
import {
  MultiplayerApiClient,
} from '../../platform/multiplayer-api-client.js';
import {
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../../shared/multiplayer-contracts.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MultiplayerApiClient', () => {
  test('creates and joins rooms with the canonical mode identity', async () => {
    const admission = {
      roomId: 'ABCD2345',
      playerId: 'player-1',
      reconnectCredential: 'secret',
      mode: multiplayerModeIdentity(SCORE_RACE_MODE),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify(admission),
      { status: 201, headers: { 'content-type': 'application/json' } },
    ));
    const client = new MultiplayerApiClient('https://api.example.test/');

    await expect(client.createRoom(SCORE_RACE_MODE)).resolves.toEqual(admission);
    await expect(client.joinRoom('ABCD2345', SCORE_RACE_MODE)).resolves.toEqual(admission);
    const expectedRequest = {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
        mode: multiplayerModeIdentity(SCORE_RACE_MODE),
      }),
    };
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/multiplayer/rooms',
      expectedRequest,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/multiplayer/rooms/ABCD2345/join',
      expectedRequest,
    );
  });

  test('preserves the response status for admission errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const client = new MultiplayerApiClient('https://api.example.test');

    const error = await client.joinRoom('MISSING1', SCORE_RACE_MODE)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(404);
  });
});
