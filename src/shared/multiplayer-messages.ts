import { MULTIPLAYER_PROTOCOL_VERSION } from './multiplayer-contracts.js';
import type {
  MultiplayerClientMessage,
  MultiplayerMatchResult,
  MultiplayerModeIdentity,
  MultiplayerPlayerProgress,
  MultiplayerProgress,
  MultiplayerServerMessage,
} from './multiplayer-contracts.js';

export type MultiplayerMessageError = 'invalid-message' | 'protocol-mismatch';

export type MultiplayerMessageParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly error: MultiplayerMessageError };

export function parseMultiplayerClientMessage(
  value: unknown,
): MultiplayerMessageParseResult<MultiplayerClientMessage> {
  const protocolError = protocolErrorFor(value);
  if (protocolError) return { ok: false, error: protocolError };
  if (!isRecord(value)
    || !isNonEmptyString(value.roomId)
    || !isNonEmptyString(value.playerId)
    || typeof value.type !== 'string') {
    return invalidMessage();
  }
  const base = {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: value.roomId,
    playerId: value.playerId,
  };

  switch (value.type) {
    case 'set-ready':
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'playerId', 'type', 'ready',
      ]) || typeof value.ready !== 'boolean') return invalidMessage();
      return { ok: true, message: { ...base, type: value.type, ready: value.ready } };
    case 'publish-progress':
    case 'finish-match': {
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'playerId', 'type', 'matchId', 'progress',
      ]) || !isNonEmptyString(value.matchId)) return invalidMessage();
      const progress = parseProgress(value.progress);
      if (!progress) return invalidMessage();
      return {
        ok: true,
        message: { ...base, type: value.type, matchId: value.matchId, progress },
      };
    }
    case 'resume-session':
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'playerId', 'type',
        'matchId', 'lastProgressSequence',
      ])
        || !(value.matchId === null || isNonEmptyString(value.matchId))
        || !isNonNegativeInteger(value.lastProgressSequence)) {
        return invalidMessage();
      }
      return {
        ok: true,
        message: {
          ...base,
          type: value.type,
          matchId: value.matchId,
          lastProgressSequence: value.lastProgressSequence,
        },
      };
    default:
      return invalidMessage();
  }
}

export function parseMultiplayerServerMessage(
  value: unknown,
): MultiplayerMessageParseResult<MultiplayerServerMessage> {
  const protocolError = protocolErrorFor(value);
  if (protocolError) return { ok: false, error: protocolError };
  if (!isRecord(value)
    || !isNonEmptyString(value.roomId)
    || typeof value.type !== 'string') {
    return invalidMessage();
  }
  const mode = parseModeIdentity(value.mode);
  if (!mode) return invalidMessage();
  const base = {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: value.roomId,
    mode,
  };

  switch (value.type) {
    case 'room-state':
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'mode', 'type', 'localReady', 'opponentReady',
      ])
        || typeof value.localReady !== 'boolean'
        || typeof value.opponentReady !== 'boolean') {
        return invalidMessage();
      }
      return {
        ok: true,
        message: {
          ...base,
          type: value.type,
          localReady: value.localReady,
          opponentReady: value.opponentReady,
        },
      };
    case 'match-countdown':
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'mode', 'type',
        'matchId', 'startsAt', 'deadline', 'seed',
      ])
        || !isNonEmptyString(value.matchId)
        || !isNonNegativeInteger(value.startsAt)
        || !isNonNegativeInteger(value.deadline)
        || value.startsAt >= value.deadline
        || !isUint32(value.seed)) {
        return invalidMessage();
      }
      return {
        ok: true,
        message: {
          ...base,
          type: value.type,
          matchId: value.matchId,
          startsAt: value.startsAt,
          deadline: value.deadline,
          seed: value.seed,
        },
      };
    case 'opponent-progress':
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'mode', 'type', 'matchId', 'progress',
      ])
        || !isNonEmptyString(value.matchId)
        || !isPlayerProgress(value.progress)) {
        return invalidMessage();
      }
      return {
        ok: true,
        message: {
          ...base,
          type: value.type,
          matchId: value.matchId,
          progress: { ...value.progress },
        },
      };
    case 'match-finished': {
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'mode', 'type', 'matchId', 'result',
      ]) || !isNonEmptyString(value.matchId)) return invalidMessage();
      const result = parseMatchResult(value.result);
      if (!result) return invalidMessage();
      return {
        ok: true,
        message: { ...base, type: value.type, matchId: value.matchId, result },
      };
    }
    default:
      return invalidMessage();
  }
}

function parseModeIdentity(value: unknown): MultiplayerModeIdentity | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'version', 'rules'])
    || !isNonEmptyString(value.id)
    || !isPositiveInteger(value.version)
    || !isRecord(value.rules)
    || !hasExactKeys(value.rules, ['id', 'version'])
    || !isNonEmptyString(value.rules.id)
    || !isPositiveInteger(value.rules.version)) {
    return null;
  }
  return {
    id: value.id,
    version: value.version,
    rules: { id: value.rules.id, version: value.rules.version },
  };
}

function parseProgress(value: unknown): MultiplayerProgress | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['sequence', 'score', 'turnsPlayed'])
    || !isNonNegativeInteger(value.sequence)
    || !isNonNegativeInteger(value.score)
    || !isNonNegativeInteger(value.turnsPlayed)) {
    return null;
  }
  return {
    sequence: value.sequence,
    score: value.score,
    turnsPlayed: value.turnsPlayed,
  };
}

function isPlayerProgress(value: unknown): value is MultiplayerPlayerProgress {
  return isRecord(value)
    && hasExactKeys(value, [
      'playerId', 'sequence', 'score', 'turnsPlayed', 'finished',
    ])
    && isNonEmptyString(value.playerId)
    && isNonNegativeInteger(value.sequence)
    && isNonNegativeInteger(value.score)
    && isNonNegativeInteger(value.turnsPlayed)
    && typeof value.finished === 'boolean';
}

function parseMatchResult(value: unknown): MultiplayerMatchResult | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['winnerId', 'scores'])
    || !(value.winnerId === null || isNonEmptyString(value.winnerId))
    || !Array.isArray(value.scores)
    || value.scores.length !== 2) {
    return null;
  }
  const scores = value.scores.map(score => {
    if (!isRecord(score)
      || !hasExactKeys(score, ['playerId', 'score'])
      || !isNonEmptyString(score.playerId)
      || !isNonNegativeInteger(score.score)) {
      return null;
    }
    return { playerId: score.playerId, score: score.score };
  });
  const first = scores[0];
  const second = scores[1];
  if (!first || !second || first.playerId === second.playerId) return null;
  const expectedWinner = first.score === second.score
    ? null
    : first.score > second.score ? first.playerId : second.playerId;
  if (value.winnerId !== expectedWinner) return null;
  return {
    winnerId: value.winnerId,
    scores: [first, second],
  };
}

function protocolErrorFor(value: unknown): MultiplayerMessageError | null {
  if (!isRecord(value) || !('protocolVersion' in value)) return 'invalid-message';
  return value.protocolVersion === MULTIPLAYER_PROTOCOL_VERSION
    ? null
    : 'protocol-mismatch';
}

function invalidMessage<T>(): MultiplayerMessageParseResult<T> {
  return { ok: false, error: 'invalid-message' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isUint32(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 0xffff_ffff;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && actual.every(key => expected.includes(key));
}
