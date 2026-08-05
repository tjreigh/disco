import { MULTIPLAYER_PROTOCOL_VERSION } from './multiplayer-contracts.js';
import type {
  MultiplayerClientMessage,
  MultiplayerMatchResult,
  MultiplayerModeIdentity,
  MultiplayerPlayerProgress,
  MultiplayerProgress,
  MultiplayerServerMessage,
  TurnResultWire,
  WireBoard,
  WireCell,
  WireClearStep,
  WireDisc,
  WireDropStep,
  WireFallMove,
  WireFallStep,
  WireGridPos,
  WirePushStep,
  WireRevealStep,
  WireStep,
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
    case 'play-turn':
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'playerId', 'type', 'matchId', 'column',
      ])
        || !isNonEmptyString(value.matchId)
        || !isLaneIndex(value.column)) {
        return invalidMessage();
      }
      return {
        ok: true,
        message: { ...base, type: value.type, matchId: value.matchId, column: value.column },
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
    case 'turn-assigned': {
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'mode', 'type',
        'matchId', 'playerId', 'turnDeadline', 'board',
      ])
        || !isNonEmptyString(value.matchId)
        || !isNonEmptyString(value.playerId)
        || !isNonNegativeInteger(value.turnDeadline)) return invalidMessage();
      const board = parseWireBoard(value.board);
      if (!board) return invalidMessage();
      return {
        ok: true,
        message: {
          ...base,
          type: value.type,
          matchId: value.matchId,
          playerId: value.playerId,
          turnDeadline: value.turnDeadline,
          board,
        },
      };
    }
    case 'turn-played':
    case 'turn-expired': {
      if (!hasExactKeys(value, [
        'protocolVersion', 'roomId', 'mode', 'type',
        'matchId', 'board', 'turnResult', 'nextPlayerId',
      ])
        || !isNonEmptyString(value.matchId)
        || !isNonEmptyString(value.nextPlayerId)) return invalidMessage();
      const board = parseWireBoard(value.board);
      if (!board) return invalidMessage();
      const turnResult = parseTurnResultWire(value.turnResult);
      if (!turnResult) return invalidMessage();
      return {
        ok: true,
        message: {
          ...base,
          type: value.type,
          matchId: value.matchId,
          board,
          turnResult,
          nextPlayerId: value.nextPlayerId,
        },
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

function parseWireBoard(value: unknown): WireBoard | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const board: WireCell[][] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0) return null;
    const parsedRow: WireCell[] = [];
    for (const cell of row) {
      if (cell === null) {
        parsedRow.push(null);
        continue;
      }
      const disc = parseWireDisc(cell);
      if (!disc) return null;
      parsedRow.push(disc);
    }
    board.push(parsedRow);
  }
  return board;
}

function isDiscValue(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 7;
}

// Positions may be -1 on one axis: entryPos for a Drop step lands one cell
// beyond whichever edge the disc entered through (see animation-queue.ts).
function isGridCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= -1;
}

function parseWireDisc(value: unknown): WireDisc | null {
  if (!isRecord(value)) return null;
  if (!('id' in value) || !isNonNegativeInteger(value.id)) return null;
  if (!('value' in value) || !isDiscValue(value.value)) return null;
  if (!('kind' in value) || typeof value.kind !== 'string' || value.kind.trim().length === 0) return null;
  const ownerId = 'ownerId' in value && typeof value.ownerId === 'string' && value.ownerId.trim().length > 0
    ? value.ownerId
    : undefined;
  return {
    id: value.id,
    value: value.value,
    kind: value.kind,
    ...(ownerId !== undefined ? { ownerId } : {}),
  };
}

function parseWireGridPos(value: unknown): WireGridPos | null {
  if (!isRecord(value)) return null;
  if (!isGridCoordinate(value.row) || !isGridCoordinate(value.col)) return null;
  return { row: value.row, col: value.col };
}

function parseTurnResultWire(value: unknown): TurnResultWire | null {
  if (!isRecord(value)
    || !isNonEmptyString(value.playerId)
    || !isLaneIndex(value.column)
    || !isNonNegativeInteger(value.triggerScoreDelta)
    || !isNonNegativeInteger(value.opponentScoreDelta)
    || !isNonNegativeInteger(value.stackSize)
    || !Array.isArray(value.steps)
    || typeof value.gameOver !== 'boolean') return null;
  const gameOverReason = value.gameOverReason !== undefined
    && (value.gameOverReason === 'push-overflow' || value.gameOverReason === 'board-full')
    ? value.gameOverReason
    : undefined;
  const steps: WireStep[] = [];
  for (const step of value.steps) {
    const parsed = parseWireStep(step);
    if (!parsed) return null;
    steps.push(parsed);
  }
  return {
    playerId: value.playerId,
    column: value.column,
    triggerScoreDelta: value.triggerScoreDelta,
    opponentScoreDelta: value.opponentScoreDelta,
    stackSize: value.stackSize,
    steps,
    gameOver: value.gameOver,
    ...(gameOverReason !== undefined ? { gameOverReason } : {}),
  };
}

function parseWireStep(value: unknown): WireStep | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'drop': {
      if (!('disc' in value) || !('entryPos' in value) || !('landPos' in value)) return null;
      const disc = parseWireDisc(value.disc);
      const entryPos = parseWireGridPos(value.entryPos);
      const landPos = parseWireGridPos(value.landPos);
      if (!disc || !entryPos || !landPos) return null;
      return { kind: 'drop', disc, entryPos, landPos } satisfies WireDropStep;
    }
    case 'clear': {
      if (!('cleared' in value) || !('discs' in value)
        || !('chainLevel' in value) || !('pointsAwarded' in value)) return null;
      if (!Array.isArray(value.cleared) || !Array.isArray(value.discs)) return null;
      if (!isNonNegativeInteger(value.chainLevel) || !isNonNegativeInteger(value.pointsAwarded)) return null;
      const cleared = value.cleared.map(parseWireGridPos);
      const discs = value.discs.map(parseWireDisc);
      if (cleared.some(p => p === null) || discs.some(d => d === null)) return null;
      return {
        kind: 'clear',
        cleared: cleared as WireGridPos[],
        discs: discs as WireDisc[],
        chainLevel: value.chainLevel,
        pointsAwarded: value.pointsAwarded,
      } satisfies WireClearStep;
    }
    case 'fall': {
      if (!('moves' in value) || !Array.isArray(value.moves)) return null;
      const moves: WireFallMove[] = [];
      for (const move of value.moves) {
        if (!isRecord(move) || !('from' in move) || !('to' in move) || !('disc' in move)) return null;
        const from = parseWireGridPos(move.from);
        const to = parseWireGridPos(move.to);
        const disc = parseWireDisc(move.disc);
        if (!from || !to || !disc) return null;
        moves.push({ from, to, disc });
      }
      return { kind: 'fall', moves } satisfies WireFallStep;
    }
    case 'reveal': {
      if (!('positions' in value) || !('discs' in value)
        || !Array.isArray(value.positions) || !Array.isArray(value.discs)) return null;
      const positions = value.positions.map(parseWireGridPos);
      const discs = value.discs.map(parseWireDisc);
      if (positions.some(p => p === null) || discs.some(d => d === null)) return null;
      return {
        kind: 'reveal',
        positions: positions as WireGridPos[],
        discs: discs as WireDisc[],
      } satisfies WireRevealStep;
    }
    case 'push': {
      if (!('edge' in value) || !('newDiscs' in value)
        || typeof value.edge !== 'string' || !Array.isArray(value.newDiscs)) return null;
      const newDiscs = value.newDiscs.map(parseWireDisc);
      if (newDiscs.some(d => d === null)) return null;
      return {
        kind: 'push',
        edge: value.edge,
        newDiscs: newDiscs as WireDisc[],
      } satisfies WirePushStep;
    }
    case 'bonus': {
      if (!('bonusKind' in value) || !('pointsAwarded' in value)
        || typeof value.bonusKind !== 'string') return null;
      if (!isNonNegativeInteger(value.pointsAwarded)) return null;
      return { kind: 'bonus', bonusKind: value.bonusKind, pointsAwarded: value.pointsAwarded };
    }
    default:
      return null;
  }
}

function isLaneIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 6;
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
