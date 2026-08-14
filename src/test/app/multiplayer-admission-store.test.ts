// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import { SCORE_RACE_MODE } from '../../game/modes/score-race.js';
import { SHARED_DUEL_MODE } from '../../game/modes/shared-duel.js';
import {
  admissionErrorText,
  forgetAdmission,
  privateRoomUrl,
  readAdmission,
  retainAdmission,
} from '../../app/multiplayer-admission-store.js';
import { multiplayerModeIdentity } from '../../shared/multiplayer-contracts.js';

const scoreRaceMode = multiplayerModeIdentity(SCORE_RACE_MODE);
const sharedDuelMode = multiplayerModeIdentity(SHARED_DUEL_MODE);

function admission(overrides: Partial<{
  roomId: string;
  playerId: string;
  reconnectCredential: string;
  mode: typeof scoreRaceMode;
}> = {}) {
  return {
    roomId: 'ABCD2345',
    playerId: 'player-1',
    reconnectCredential: 'secret',
    mode: scoreRaceMode,
    ...overrides,
  };
}

describe('multiplayer-admission-store', () => {
  beforeEach(() => window.sessionStorage.clear());

  test('round-trips a retained admission for the same expected mode', () => {
    const value = admission();
    expect(retainAdmission(scoreRaceMode, value)).toBe(true);
    expect(readAdmission(scoreRaceMode, value.roomId)).toEqual(value);
  });

  test('a retained admission for one mode is never accepted by another mode', () => {
    const value = admission({ roomId: 'SAMEROOM', mode: scoreRaceMode });
    retainAdmission(scoreRaceMode, value);

    // Same room id, different expected mode — must not return the Score
    // Race admission as if it were valid for Disco Duel.
    expect(readAdmission(sharedDuelMode, 'SAMEROOM')).toBeNull();
    // The original mode can still read its own admission back.
    expect(readAdmission(scoreRaceMode, 'SAMEROOM')).toEqual(value);
  });

  test('removes a wrong-mode admission stored under the requested mode key', () => {
    const value = admission({ roomId: 'SAMEROOM', mode: scoreRaceMode });
    window.sessionStorage.setItem(
      'disco_multiplayer_admission:shared-duel:SAMEROOM',
      JSON.stringify(value),
    );

    expect(readAdmission(sharedDuelMode, 'SAMEROOM')).toBeNull();
    expect(window.sessionStorage.getItem('disco_multiplayer_admission:shared-duel:SAMEROOM')).toBeNull();
  });

  test('rejects a wrong-mode admission before retaining it', () => {
    const value = admission({ roomId: 'SAMEROOM', mode: scoreRaceMode });

    expect(retainAdmission(sharedDuelMode, value)).toBe(false);
    expect(window.sessionStorage.length).toBe(0);
  });

  test('rejects empty admission credentials before retaining them', () => {
    expect(retainAdmission(scoreRaceMode, admission({ reconnectCredential: '' }))).toBe(false);
    expect(window.sessionStorage.length).toBe(0);
  });

  test('rejects and removes malformed retained JSON', () => {
    window.sessionStorage.setItem('disco_multiplayer_admission:score-race:BADROOM', '{not json');
    expect(readAdmission(scoreRaceMode, 'BADROOM')).toBeNull();
    expect(window.sessionStorage.getItem('disco_multiplayer_admission:score-race:BADROOM')).toBeNull();
  });

  test('rejects and removes a retained value missing required fields', () => {
    window.sessionStorage.setItem(
      'disco_multiplayer_admission:score-race:INCOMPLETE',
      JSON.stringify({ roomId: 'INCOMPLETE', playerId: 'p1' }),
    );
    expect(readAdmission(scoreRaceMode, 'INCOMPLETE')).toBeNull();
    expect(window.sessionStorage.getItem('disco_multiplayer_admission:score-race:INCOMPLETE')).toBeNull();
  });

  test('removes a wrong-room admission stored under the requested room key', () => {
    window.sessionStorage.setItem(
      'disco_multiplayer_admission:score-race:ROOMTWO',
      JSON.stringify(admission({ roomId: 'ROOMONE' })),
    );

    expect(readAdmission(scoreRaceMode, 'ROOMTWO')).toBeNull();
    expect(window.sessionStorage.getItem('disco_multiplayer_admission:score-race:ROOMTWO')).toBeNull();
  });

  test('forgetAdmission removes only the matching mode+room entry', () => {
    const scoreRaceAdmission = admission({ roomId: 'SAMEROOM', mode: scoreRaceMode });
    const sharedDuelAdmission = admission({ roomId: 'SAMEROOM', mode: sharedDuelMode, playerId: 'player-2' });
    retainAdmission(scoreRaceMode, scoreRaceAdmission);
    retainAdmission(sharedDuelMode, sharedDuelAdmission);

    forgetAdmission(scoreRaceMode, 'SAMEROOM');

    expect(readAdmission(scoreRaceMode, 'SAMEROOM')).toBeNull();
    expect(readAdmission(sharedDuelMode, 'SAMEROOM')).toEqual(sharedDuelAdmission);
  });

  test('storage access throwing does not raise', () => {
    const original = window.sessionStorage.setItem;
    window.sessionStorage.setItem = () => {
      throw new Error('quota exceeded');
    };
    try {
      expect(retainAdmission(scoreRaceMode, admission())).toBe(true);
    } finally {
      window.sessionStorage.setItem = original;
    }
  });
});

describe('privateRoomUrl', () => {
  test('sets the Score Race mode query parameter', () => {
    const url = new URL(privateRoomUrl('ABCD2345', 'score-race'));
    expect(url.searchParams.get('room')).toBe('ABCD2345');
    expect(url.searchParams.get('mode')).toBe('score-race');
  });

  test('sets the mode query param when passed (Disco Duel)', () => {
    const url = new URL(privateRoomUrl('ABCD2345', 'shared-duel'));
    expect(url.searchParams.get('room')).toBe('ABCD2345');
    expect(url.searchParams.get('mode')).toBe('shared-duel');
  });
});

describe('admissionErrorText', () => {
  test('describes a missing room code', () => {
    expect(admissionErrorText(new Error('missing-room'))).toMatch(/missing a room code/);
  });

  test('describes known HTTP statuses', () => {
    expect(admissionErrorText({ status: 404 })).toMatch(/no longer exists/);
    expect(admissionErrorText({ status: 409 })).toMatch(/full or uses a different/);
    expect(admissionErrorText({ status: 429 })).toMatch(/Too many room attempts/);
  });

  test('falls back to a generic message for anything else', () => {
    expect(admissionErrorText(new Error('network down'))).toMatch(/Could not reach the multiplayer service/);
  });
});
